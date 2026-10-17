import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BackupDeps, type BackupSettings, runBackup } from '../src/backup/run.ts';
import { readManifest, SNAPSHOT_RE, verifySnapshot } from '../src/backup/snapshot.ts';
import { createFakeClock, makeTempDir, removeDir } from './helpers.ts';

let base: string;
let dirs: { data: string; files: string; photos: string; jellyfin: string; target: string; temp: string };
const clock = createFakeClock('2026-10-17T00:30:00.000Z');

beforeEach(async () => {
  base = await makeTempDir('fd-bkfam-');
  dirs = {
    data: path.join(base, 'data'),
    files: path.join(base, 'Files'),
    photos: path.join(base, 'Photos'),
    jellyfin: path.join(base, 'jellyfin'),
    target: path.join(base, 'backups'),
    temp: path.join(base, 'tmp'),
  };
  for (const d of Object.values(dirs)) await fsp.mkdir(d, { recursive: true });
  await fsp.writeFile(path.join(dirs.data, 'users.json'), '{"version":1,"users":[]}');
  const put = async (rel: string, content: string) => {
    const file = path.join(base, rel);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content);
  };
  await put('Files/users/mama/паспорт.pdf', '%PDF скан');
  await put('Files/shared/рецепты/борщ.txt', 'свёкла');
  await put('Files/users/mama/Загрузки/.abc.part', 'partial download');
  await put('Files/.trash/shared/20261016-000000 old.txt', 'trash');
  await put('Photos/users/mama/2026-10/IMG_1.jpg', 'jpeg-bytes');
  await put('Photos/.thumbs/users/mama/2026-10/IMG_1.jpg.jpg', 'thumb');
  await put('jellyfin/config/system.xml', '<ServerConfiguration/>');
  await put('jellyfin/data/data/jellyfin.db', 'sqlite');
  await put('jellyfin/data/metadata/library/aa/poster.jpg', 'big image');
  await put('jellyfin/cache/x.bin', 'cache');
});

afterEach(async () => {
  await removeDir(base);
});

function settings(): BackupSettings {
  return {
    dataDir: dirs.data,
    targets: [dirs.target],
    keep: 14,
    repoDir: null,
    extraFiles: [],
    gitExe: 'git',
    familyTrees: [
      { prefix: 'family/files', dir: dirs.files },
      { prefix: 'family/photos', dir: dirs.photos },
      { prefix: 'family/home-video', dir: path.join(base, 'missing-folder') },
    ],
    jellyfinDataRoot: dirs.jellyfin,
  };
}

function deps(overrides: Partial<BackupDeps> = {}): BackupDeps {
  return {
    clock,
    appVersion: '9.9.9',
    listVolumes: async () => [],
    statfs: async () => ({ freeBytes: 500 * 1024 ** 3 }),
    tailscaleServe: async () => ({}),
    tempDir: dirs.temp,
    systemDrive: path.parse(base).root.slice(0, 2),
    ...overrides,
  };
}

async function snapshots(): Promise<string[]> {
  return (await fsp.readdir(dirs.target)).filter((n) => SNAPSHOT_RE.test(n)).sort();
}

describe('family data in the backup', { timeout: 60_000 }, () => {
  it('copies files, photos (with thumbnails) and Jellyfin config/database; skips trash, partials, metadata, cache', async () => {
    const calls: string[] = [];
    const result = await runBackup(
      settings(),
      deps({
        pauseService: async (name) => {
          calls.push(`stop ${name}`);
          return async () => {
            calls.push(`start ${name}`);
          };
        },
      }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(calls).toEqual(['stop jellyfin', 'start jellyfin']);
    const [name] = await snapshots();
    const { manifest } = await readManifest(path.join(dirs.target, name ?? ''));
    const paths = manifest?.files.map((f) => f.path) ?? [];
    expect(paths).toEqual(
      expect.arrayContaining([
        'family/files/users/mama/паспорт.pdf',
        'family/files/shared/рецепты/борщ.txt',
        'family/photos/users/mama/2026-10/IMG_1.jpg',
        'family/photos/.thumbs/users/mama/2026-10/IMG_1.jpg.jpg',
        'jellyfin/config/system.xml',
        'jellyfin/data/data/jellyfin.db',
        'data/users.json',
      ]),
    );
    for (const skipped of ['.part', '.trash', 'metadata', 'cache/']) {
      expect(
        paths.some((p) => p.includes(skipped)),
        skipped,
      ).toBe(false);
    }
    expect(result.warnings).toEqual([]);
  });

  it('hard-links unchanged family files to the previous snapshot and copies changed ones', async () => {
    expect((await runBackup(settings(), deps())).ok).toBe(true);
    clock.advance(24 * 3600 * 1000);
    const changed = path.join(dirs.files, 'shared', 'рецепты', 'борщ.txt');
    await fsp.writeFile(changed, 'свёкла, капуста');
    await fsp.utimes(changed, new Date(), new Date(Date.now() + 5000));
    expect((await runBackup(settings(), deps())).ok).toBe(true);
    const [first, second] = await snapshots();
    const a = path.join(dirs.target, first ?? '', 'family', 'files', 'users', 'mama', 'паспорт.pdf');
    const b = path.join(dirs.target, second ?? '', 'family', 'files', 'users', 'mama', 'паспорт.pdf');
    const [sa, sb] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
    expect(sb.nlink).toBeGreaterThanOrEqual(2); // the same data on disk, not a second copy
    expect(sb.ino).toBe(sa.ino);
    const recipe = path.join(dirs.target, second ?? '', 'family', 'files', 'shared', 'рецепты', 'борщ.txt');
    expect(await fsp.readFile(recipe, 'utf8')).toBe('свёкла, капуста');
    expect((await fsp.stat(recipe)).nlink).toBe(1);
    // A full verification (re-hashing everything) passes for both snapshots.
    for (const name of [first, second]) {
      const check = await verifySnapshot(path.join(dirs.target, name ?? ''), {
        gitExe: 'git',
        tempDir: dirs.temp,
      });
      expect(check.ok, check.problems.join('; ')).toBe(true);
    }
  });

  it('a snapshot stays complete after the older one it links to is pruned', async () => {
    expect((await runBackup(settings(), deps())).ok).toBe(true);
    clock.advance(24 * 3600 * 1000);
    expect((await runBackup({ ...settings(), keep: 1 }, deps())).ok).toBe(true);
    const left = await snapshots();
    expect(left).toHaveLength(1);
    const check = await verifySnapshot(path.join(dirs.target, left[0] ?? ''), {
      gitExe: 'git',
      tempDir: dirs.temp,
    });
    expect(check.ok, check.problems.join('; ')).toBe(true);
  });

  it('fails the target with a clear message when the drive is too small; Jellyfin still restarts', async () => {
    let restarted = false;
    const result = await runBackup(
      settings(),
      deps({
        statfs: async () => ({ freeBytes: 1024 }),
        pauseService: async () => async () => {
          restarted = true;
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.targets[0]?.error).toMatch(/Недостаточно места.*носитель большего объёма/);
    expect(restarted).toBe(true);
  });

  it('notes when Jellyfin could not be paused, but still makes the copy', async () => {
    const result = await runBackup(settings(), deps({ pauseService: async () => null }));
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/Jellyfin не был остановлен/);
  });
});
