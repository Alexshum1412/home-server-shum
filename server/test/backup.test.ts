import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreSnapshot, testRestore } from '../src/backup/restore.ts';
import { applyRetention, listSnapshots } from '../src/backup/retention.ts';
import { type BackupDeps, type BackupSettings, runBackup } from '../src/backup/run.ts';
import { createSnapshot, type SnapshotOptions, verifySnapshot } from '../src/backup/snapshot.ts';
import { collectSources, listDataFiles } from '../src/backup/sources.ts';
import { BACKUP_STATUS_FILE } from '../src/backup/status.ts';
import { parseVolumes, resolveTargets, type VolumeEntry } from '../src/backup/targets.ts';
import { POWERSHELL_SCRIPTS } from '../src/system/powershell.ts';
import { createFakeClock, type FakeClock, makeTempDir, removeDir } from './helpers.ts';

const GIT = 'git';
const gitAvailable = spawnSync(GIT, ['--version'], { windowsHide: true }).status === 0;
const HOUR = 60 * 60 * 1000;
const NOW = '2026-10-16T18:30:00.000Z';
const FIRST_NAME = 'family-backup-20261016-183000';
/** Marker inside the data files: it must never show up anywhere it should not. */
const SECRET = 'top-secret-marker-7f3a';

const EXPECTED_DATA_FILES = [
  'audit.1.jsonl',
  'audit.jsonl',
  'custom.json',
  'logins.json',
  'services.json',
  'users.json',
];

interface Fixture {
  base: string;
  dataDir: string;
  rootA: string;
  rootB: string;
  extraFile: string;
  tempDir: string;
  repoDir: string | null;
  repoHead: string | null;
  clock: FakeClock;
}

let fx: Fixture;

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content);
  }
}

/** All entries below `dir` as posix relative paths (files only). */
async function walk(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

function git(args: string[]): string {
  return execFileSync(GIT, args, { encoding: 'utf8', windowsHide: true }).trim();
}

async function makeRepo(dir: string): Promise<string> {
  await fsp.mkdir(dir, { recursive: true });
  git(['init', '-q', dir]);
  await fsp.writeFile(path.join(dir, 'README.md'), '# test repo\n');
  git(['-C', dir, 'add', 'README.md']);
  git([
    '-C',
    dir,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'init',
  ]);
  return git(['-C', dir, 'rev-parse', 'HEAD']);
}

async function setup(options: { repo?: boolean } = {}): Promise<Fixture> {
  const base = await makeTempDir('fd-backup-');
  const dataDir = path.join(base, 'data');
  await writeTree(dataDir, {
    'users.json': JSON.stringify({ users: [{ username: 'papa', passwordHash: SECRET }] }),
    'logins.json': '{"u1":"2026-10-16T10:00:00.000Z"}',
    'services.json': '{"services":[]}',
    'audit.jsonl': '{"action":"login.success"}\n',
    'audit.1.jsonl': '{"action":"logout"}\n',
    'custom.json': '{"x":1}',
    'sessions.json': `{"sessions":["${SECRET}"]}`,
    'backup-status.json': '{"lastResult":"ok","lastSuccessAt":"2026-10-10T10:00:00.000Z"}',
    '.users.json.1234.abcdefabcdef.tmp': SECRET,
    'leftover.json.tmp': SECRET,
    'notes.txt': 'not a data file',
    'audit.x.jsonl': 'not rotated by us',
    'logs/server.log': SECRET,
    'run/server.pid': '1234',
  });
  const extraFile = path.join(base, 'project', '.env');
  await writeTree(path.dirname(extraFile), { '.env': `PORT=8070\nSECRET=${SECRET}\n` });
  const tempDir = path.join(base, 'tmp');
  await fsp.mkdir(tempDir);
  let repoDir: string | null = null;
  let repoHead: string | null = null;
  if (options.repo && gitAvailable) {
    repoDir = path.join(base, 'repo');
    repoHead = await makeRepo(repoDir);
  }
  return {
    base,
    dataDir,
    rootA: path.join(base, 'backups-a'),
    rootB: path.join(base, 'backups-b'),
    extraFile,
    tempDir,
    repoDir,
    repoHead,
    clock: createFakeClock(NOW),
  };
}

function settings(overrides: Partial<BackupSettings> = {}): BackupSettings {
  return {
    dataDir: fx.dataDir,
    targets: [fx.rootA, fx.rootB],
    keep: 14,
    repoDir: fx.repoDir,
    extraFiles: [fx.extraFile],
    gitExe: GIT,
    ...overrides,
  };
}

function deps(overrides: Partial<BackupDeps> = {}): BackupDeps {
  return {
    clock: fx.clock,
    appVersion: '9.9.9',
    listVolumes: async () => [],
    statfs: async () => ({ freeBytes: 500 * 1024 * 1024 * 1024 }),
    tailscaleServe: async () => ({ TCP: { '443': { HTTPS: true } } }),
    tempDir: fx.tempDir,
    systemDrive: path.parse(fx.base).root.slice(0, 2),
    ...overrides,
  };
}

function snapshotOptions(overrides: Partial<SnapshotOptions> = {}): SnapshotOptions {
  return { clock: fx.clock, appVersion: '9.9.9', gitExe: GIT, tempDir: fx.tempDir, ...overrides };
}

async function makeSnapshot(root = fx.rootA, options: Partial<SnapshotOptions> = {}) {
  const sources = await collectSources(settings(), deps());
  try {
    return await createSnapshot(root, sources, snapshotOptions(options));
  } finally {
    await sources.cleanup();
  }
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

async function exists(file: string): Promise<boolean> {
  return fsp.lstat(file).then(
    () => true,
    () => false,
  );
}

/** A fake complete snapshot (only a manifest) for retention tests. */
async function fakeSnapshot(root: string, name: string): Promise<void> {
  await writeTree(path.join(root, name), { 'manifest.json': '{}' });
}

beforeEach(async () => {
  fx = await setup();
});

afterEach(async () => {
  await removeDir(fx.base);
});

describe('backup sources', () => {
  it('takes the data files, but never sessions, temp files, the status file or sub-folders', async () => {
    expect(await listDataFiles(fx.dataDir)).toEqual(EXPECTED_DATA_FILES);
  });

  it('collects data, extra files, network and system info; temp staging is cleaned up', async () => {
    const sources = await collectSources(settings(), deps());
    try {
      expect(sources.entries.map((entry) => entry.path).sort()).toEqual(
        [
          ...EXPECTED_DATA_FILES.map((name) => `data/${name}`),
          'config/.env',
          'network/tailscale-serve.json',
          'system-info.json',
        ].sort(),
      );
      expect(sources.network).toEqual({ ok: true });
      expect(sources.repo).toMatchObject({ ok: false });
      expect(sources.totalBytes).toBeGreaterThan(0);
    } finally {
      await sources.cleanup();
    }
    expect(await fsp.readdir(fx.tempDir)).toEqual([]);
  });

  it('records a Tailscale failure instead of failing', async () => {
    const sources = await collectSources(
      settings(),
      deps({
        tailscaleServe: async () => {
          throw new Error('Tailscale не найден на этом компьютере');
        },
      }),
    );
    try {
      expect(sources.network).toEqual({ ok: false, reason: 'Tailscale не найден на этом компьютере' });
      expect(sources.entries.some((entry) => entry.path.startsWith('network/'))).toBe(false);
    } finally {
      await sources.cleanup();
    }
  });

  it('warns about a missing extra file and still collects the rest', async () => {
    const missing = path.join(fx.base, 'nope', '.env');
    const sources = await collectSources(settings({ extraFiles: [missing] }), deps());
    try {
      expect(sources.entries.some((entry) => entry.path.startsWith('config/'))).toBe(false);
      expect(sources.warnings.join('\n')).toContain(missing);
    } finally {
      await sources.cleanup();
    }
  });

  it('fails clearly when the data folder does not exist', async () => {
    await expect(
      collectSources(settings({ dataDir: path.join(fx.base, 'missing') }), deps()),
    ).rejects.toThrow(/Папка данных/);
  });
});

describe('snapshot', () => {
  it('writes a verified snapshot with sha256 for every file in the manifest', async () => {
    const snap = await makeSnapshot();
    expect(snap.name).toBe(FIRST_NAME);
    expect(snap.dir).toBe(path.join(fx.rootA, FIRST_NAME));
    expect(await fsp.readdir(fx.rootA)).toEqual([FIRST_NAME]); // no .partial left behind

    const manifest = await readJson(path.join(snap.dir, 'manifest.json'));
    expect(manifest).toMatchObject({
      formatVersion: 1,
      createdAt: NOW,
      appVersion: '9.9.9',
      host: os.hostname(),
      network: { ok: true },
      repo: { ok: false },
    });
    const files = manifest.files as Array<{ path: string; size: number; sha256: string }>;
    for (const name of EXPECTED_DATA_FILES) {
      const content = await fsp.readFile(path.join(fx.dataDir, name));
      expect(files.find((file) => file.path === `data/${name}`)).toEqual({
        path: `data/${name}`,
        size: content.length,
        sha256: sha256(content),
      });
    }
    const env = await fsp.readFile(fx.extraFile);
    expect(files.find((file) => file.path === 'config/.env')).toEqual({
      path: 'config/.env',
      size: env.length,
      sha256: sha256(env),
    });
    // What is on disk is exactly what the manifest lists (+ the manifest itself).
    expect(await walk(snap.dir)).toEqual([...files.map((file) => file.path), 'manifest.json'].sort());
    expect(snap.sizeBytes).toBe(files.reduce((sum, file) => sum + file.size, 0));

    const all = files.map((file) => file.path).join('\n');
    expect(all).not.toMatch(/sessions|backup-status|\.tmp|logs\/|run\/|notes\.txt/);

    const info = await readJson(path.join(snap.dir, 'system-info.json'));
    expect(info).toMatchObject({ appVersion: '9.9.9', node: process.version, hostname: os.hostname() });
    expect(info.createdAt).toBe(NOW);
    expect(await readJson(path.join(snap.dir, 'network', 'tailscale-serve.json'))).toEqual({
      TCP: { '443': { HTTPS: true } },
    });

    const result = await verifySnapshot(snap.dir, { gitExe: GIT, tempDir: fx.tempDir });
    expect(result).toMatchObject({ ok: true, problems: [] });
  });

  it('adds -2, -3 when a snapshot with the same time already exists', async () => {
    expect((await makeSnapshot()).name).toBe(FIRST_NAME);
    expect((await makeSnapshot()).name).toBe(`${FIRST_NAME}-2`);
    expect((await makeSnapshot()).name).toBe(`${FIRST_NAME}-3`);
  });

  it('never gives the final name to a snapshot that fails the integrity check', async () => {
    await expect(
      makeSnapshot(fx.rootA, {
        beforeVerify: async (partialDir) => {
          expect(path.basename(partialDir)).toBe(`${FIRST_NAME}.partial`);
          const file = path.join(partialDir, 'data', 'users.json');
          const content = await fsp.readFile(file);
          content[0] = content[0] === 0x41 ? 0x42 : 0x41; // flip one byte, same size
          await fsp.writeFile(file, content);
        },
      }),
    ).rejects.toThrow(/целостност/);
    // Neither a final snapshot nor the broken partial copy remains.
    expect(await fsp.readdir(fx.rootA)).toEqual([]);
  });
});

describe('verify', () => {
  it('detects a modified byte, a missing file and an extra file', async () => {
    const snap = await makeSnapshot();
    const options = { gitExe: GIT, tempDir: fx.tempDir };

    const users = path.join(snap.dir, 'data', 'users.json');
    const original = await fsp.readFile(users);
    const changed = Buffer.from(original);
    changed[changed.length - 1] = changed[changed.length - 1] === 0x7d ? 0x5d : 0x7d;
    await fsp.writeFile(users, changed);
    let result = await verifySnapshot(snap.dir, options);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/data\/users\.json.*изменено/);
    await fsp.writeFile(users, original);

    await fsp.rm(path.join(snap.dir, 'data', 'logins.json'));
    await fsp.writeFile(path.join(snap.dir, 'data', 'stranger.json'), '{}');
    result = await verifySnapshot(snap.dir, options);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('Нет файла data/logins.json');
    expect(result.problems.join('\n')).toContain('Лишний файл в копии: data/stranger.json');
    // Problems name files, never their contents.
    expect(result.problems.join('\n')).not.toContain(SECRET);
  });

  it('reports a missing or broken manifest', async () => {
    const snap = await makeSnapshot();
    const manifest = path.join(snap.dir, 'manifest.json');
    await fsp.writeFile(manifest, '{ broken');
    let result = await verifySnapshot(snap.dir, { gitExe: GIT, tempDir: fx.tempDir });
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/manifest\.json/);
    await fsp.rm(manifest);
    result = await verifySnapshot(snap.dir, { gitExe: GIT, tempDir: fx.tempDir });
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/Нет файла manifest\.json/);
  });

  it('rejects a manifest that points outside the snapshot', async () => {
    const snap = await makeSnapshot();
    const file = path.join(snap.dir, 'manifest.json');
    const manifest = await readJson(file);
    (manifest.files as Array<{ path: string }>)[0] = {
      path: '../evil.json',
      size: 1,
      sha256: 'a'.repeat(64),
    } as never;
    await fsp.writeFile(file, JSON.stringify(manifest));
    const result = await verifySnapshot(snap.dir, { gitExe: GIT, tempDir: fx.tempDir });
    expect(result.ok).toBe(false);
  });
});

describe('retention', () => {
  it('keeps the newest N complete snapshots and touches nothing else', async () => {
    const root = fx.rootA;
    const snapshots = [
      'family-backup-20261001-000000',
      'family-backup-20261002-000000',
      'family-backup-20261003-000000',
      'family-backup-20261003-000000-2',
      'family-backup-20261003-000000-10',
    ];
    for (const name of snapshots) await fakeSnapshot(root, name);
    // Things that are not ours: kept whatever happens.
    await writeTree(root, {
      'notes.txt': 'keep me',
      'family-backup-old-style/file.txt': 'keep me',
      'Family-Backup-20200101-000000/manifest.json': '{}',
      'family-backup-20200101-000000.zip': 'keep me',
      'family-backup-20200102-000000/readme.txt': 'no manifest: not a complete snapshot',
    });
    await fsp.writeFile(path.join(root, 'family-backup-20200103-000000'), 'a file, not a folder');

    const result = await applyRetention(root, { keep: 2, dataDir: fx.dataDir, clock: fx.clock });
    expect(result.removed.sort()).toEqual(snapshots.slice(0, 3));
    expect(result.kept).toEqual(['family-backup-20261003-000000-10', 'family-backup-20261003-000000-2']);
    expect((await fsp.readdir(root)).sort()).toEqual(
      [
        'Family-Backup-20200101-000000',
        'family-backup-20200101-000000.zip',
        'family-backup-20200102-000000',
        'family-backup-20200103-000000',
        'family-backup-20261003-000000-10',
        'family-backup-20261003-000000-2',
        'family-backup-old-style',
        'notes.txt',
      ].sort(),
    );
    expect((await listSnapshots(root)).map((s) => s.name)).toEqual([
      'family-backup-20261003-000000-10',
      'family-backup-20261003-000000-2',
    ]);
  });

  it('never deletes a protected snapshot (the one just written), even if the clock went back', async () => {
    await fakeSnapshot(fx.rootA, 'family-backup-20300101-000000'); // written while the clock was wrong
    await fakeSnapshot(fx.rootA, FIRST_NAME);
    const result = await applyRetention(fx.rootA, {
      keep: 1,
      dataDir: fx.dataDir,
      clock: fx.clock,
      protect: [FIRST_NAME],
    });
    expect(result.removed).toEqual([]);
    expect(result.kept.sort()).toEqual([FIRST_NAME, 'family-backup-20300101-000000'].sort());
  });

  it('never follows a junction or symlink when deleting', async () => {
    const outside = path.join(fx.base, 'outside');
    await writeTree(outside, { 'precious.txt': 'family photo' });
    await fakeSnapshot(fx.rootA, 'family-backup-20261001-000000');
    await fakeSnapshot(fx.rootA, 'family-backup-20261002-000000');
    await fsp.symlink(outside, path.join(fx.rootA, 'family-backup-20261001-000000', 'link'), 'junction');
    // A junction that looks like a snapshot is not a snapshot.
    await fsp.symlink(outside, path.join(fx.rootA, 'family-backup-20000101-000000'), 'junction');

    const result = await applyRetention(fx.rootA, { keep: 1, dataDir: fx.dataDir, clock: fx.clock });
    expect(result.removed).toEqual(['family-backup-20261001-000000']);
    expect(await fsp.readFile(path.join(outside, 'precious.txt'), 'utf8')).toBe('family photo');
    expect(await exists(path.join(fx.rootA, 'family-backup-20000101-000000'))).toBe(true);
  });

  it('removes .partial folders older than 24 hours only', async () => {
    const old = path.join(fx.rootA, 'family-backup-20261015-100000.partial');
    const fresh = path.join(fx.rootA, 'family-backup-20261016-170000.partial');
    const foreign = path.join(fx.rootA, 'something.partial');
    await writeTree(old, { 'data/users.json': '{}' });
    await writeTree(fresh, { 'data/users.json': '{}' });
    await writeTree(foreign, { 'x.txt': 'x' });
    const now = fx.clock().getTime();
    const oldTime = new Date(now - 25 * HOUR);
    await fsp.utimes(old, oldTime, oldTime);
    await fsp.utimes(foreign, oldTime, oldTime);
    const freshTime = new Date(now - HOUR);
    await fsp.utimes(fresh, freshTime, freshTime);

    const result = await applyRetention(fx.rootA, { keep: 3, dataDir: fx.dataDir, clock: fx.clock });
    expect(result.removedPartials).toEqual(['family-backup-20261015-100000.partial']);
    expect((await fsp.readdir(fx.rootA)).sort()).toEqual(
      ['family-backup-20261016-170000.partial', 'something.partial'].sort(),
    );
  });

  it('refuses to work on a drive root or on the data folder', async () => {
    const driveRoot = path.parse(fx.base).root;
    await expect(
      applyRetention(driveRoot, { keep: 1, dataDir: fx.dataDir, clock: fx.clock }),
    ).rejects.toThrow(/корнем диска/);
    await expect(
      applyRetention(fx.dataDir, { keep: 1, dataDir: fx.dataDir, clock: fx.clock }),
    ).rejects.toThrow(/данн/);
    await expect(
      applyRetention(path.join(fx.dataDir, 'logs'), { keep: 1, dataDir: fx.dataDir, clock: fx.clock }),
    ).rejects.toThrow(/данн/);
  });
});

describe('restore', () => {
  it('refuses a non-empty destination and the live data folder', async () => {
    const snap = await makeSnapshot();
    const options = { gitExe: GIT, tempDir: fx.tempDir, liveDataDir: fx.dataDir, cloneRepo: true };
    const busy = path.join(fx.base, 'busy');
    await writeTree(busy, { 'keep.txt': 'x' });
    await expect(restoreSnapshot(snap.dir, busy, options)).rejects.toThrow(/не пуст/);
    await expect(restoreSnapshot(snap.dir, fx.dataDir, options)).rejects.toThrow(/рабоч/);
    await expect(restoreSnapshot(snap.dir, path.join(fx.dataDir, 'restored'), options)).rejects.toThrow(
      /рабоч/,
    );
    expect(await fsp.readFile(path.join(busy, 'keep.txt'), 'utf8')).toBe('x');
    expect(await exists(path.join(fx.dataDir, 'restored'))).toBe(false);
  });

  it('restores into an empty folder and re-verifies the copied files', async () => {
    const snap = await makeSnapshot();
    const dest = path.join(fx.base, 'restore', 'here');
    const result = await restoreSnapshot(snap.dir, dest, {
      gitExe: GIT,
      tempDir: fx.tempDir,
      liveDataDir: fx.dataDir,
      cloneRepo: true,
    });
    expect(result.fileCount).toBeGreaterThan(EXPECTED_DATA_FILES.length);
    expect(result.repoHead).toBeNull();
    for (const name of EXPECTED_DATA_FILES) {
      expect(await fsp.readFile(path.join(dest, 'data', name), 'utf8')).toBe(
        await fsp.readFile(path.join(fx.dataDir, name), 'utf8'),
      );
    }
    expect(await fsp.readFile(path.join(dest, 'config', '.env'), 'utf8')).toBe(
      await fsp.readFile(fx.extraFile, 'utf8'),
    );
    // An existing but empty folder is fine too.
    const empty = path.join(fx.base, 'empty');
    await fsp.mkdir(empty);
    await restoreSnapshot(snap.dir, empty, {
      gitExe: GIT,
      tempDir: fx.tempDir,
      liveDataDir: fx.dataDir,
      cloneRepo: false,
    });
    expect(await exists(path.join(empty, 'data', 'users.json'))).toBe(true);
  });

  it('refuses to restore a damaged snapshot', async () => {
    const snap = await makeSnapshot();
    await fsp.appendFile(path.join(snap.dir, 'data', 'services.json'), ' ');
    const dest = path.join(fx.base, 'restore');
    await expect(
      restoreSnapshot(snap.dir, dest, {
        gitExe: GIT,
        tempDir: fx.tempDir,
        liveDataDir: fx.dataDir,
        cloneRepo: true,
      }),
    ).rejects.toThrow(/не прошла проверку/);
    expect(await exists(path.join(dest, 'data'))).toBe(false);
  });
});

describe.skipIf(!gitAvailable)('git bundle of the code', () => {
  beforeEach(async () => {
    await removeDir(fx.base);
    fx = await setup({ repo: true });
  });

  it('bundles the repository, verifies the bundle and clones it on restore', async () => {
    const snap = await makeSnapshot();
    const manifest = await readJson(path.join(snap.dir, 'manifest.json'));
    expect(manifest.repo).toMatchObject({ ok: true, head: fx.repoHead });
    expect((manifest.repo as { refs: string[] }).refs.length).toBeGreaterThan(0);
    expect(await exists(path.join(snap.dir, 'repo.bundle'))).toBe(true);
    expect((await verifySnapshot(snap.dir, { gitExe: GIT, tempDir: fx.tempDir })).ok).toBe(true);

    const dest = path.join(fx.base, 'restored');
    const result = await restoreSnapshot(snap.dir, dest, {
      gitExe: GIT,
      tempDir: fx.tempDir,
      liveDataDir: fx.dataDir,
      cloneRepo: true,
    });
    expect(result.repoHead).toBe(fx.repoHead);
    expect(await fsp.readFile(path.join(dest, 'repo', 'README.md'), 'utf8')).toContain('test repo');
    expect(await fsp.readdir(fx.tempDir)).toEqual([]);
  });

  it('restores the data even when git is missing at restore time (code clone becomes a remark)', async () => {
    const snap = await makeSnapshot();
    const missingGit = path.join(fx.base, 'no-git', 'git.exe');
    const dest = path.join(fx.base, 'restored');
    const result = await restoreSnapshot(snap.dir, dest, {
      gitExe: missingGit,
      tempDir: fx.tempDir,
      liveDataDir: fx.dataDir,
      cloneRepo: true,
    });
    expect(result.repoHead).toBeNull();
    expect(result.repoError).toMatch(/Git не найден/);
    expect(result.warnings.join('\n')).toMatch(/Git не найден/);
    expect(await exists(path.join(dest, 'data', 'users.json'))).toBe(true);
    expect(await exists(path.join(dest, 'repo.bundle'))).toBe(true);
  });

  it('still creates the snapshot when git is missing and records why', async () => {
    const missingGit = path.join(fx.base, 'no-git', 'git.exe');
    const sources = await collectSources(settings({ gitExe: missingGit }), deps());
    try {
      const snap = await createSnapshot(fx.rootA, sources, snapshotOptions({ gitExe: missingGit }));
      const manifest = await readJson(path.join(snap.dir, 'manifest.json'));
      expect(manifest.repo).toMatchObject({ ok: false, reason: expect.stringMatching(/Git/) });
      expect(await exists(path.join(snap.dir, 'repo.bundle'))).toBe(false);
      expect(sources.warnings.join('\n')).toMatch(/Git/);
    } finally {
      await sources.cleanup();
    }
  });
});

describe('targets', () => {
  const volume = (driveLetter: string, label: string): VolumeEntry => ({
    driveLetter,
    label,
    driveType: 'Removable',
    fileSystem: 'NTFS',
    sizeBytes: 16_000_000_000,
    freeBytes: 15_000_000_000,
  });

  it('parses the volume list from PowerShell and drops garbage', () => {
    expect(
      parseVolumes([
        {
          driveLetter: 'D',
          label: 'reserve',
          driveType: 'Removable',
          fileSystem: 'NTFS',
          sizeBytes: 1,
          freeBytes: 1,
        },
        { driveLetter: '', label: 'x' },
        'junk',
        null,
      ]),
    ).toEqual([{ ...volume('D', 'reserve'), sizeBytes: 1, freeBytes: 1 }]);
    expect(parseVolumes('unsupported')).toEqual([]);
    expect(POWERSHELL_SCRIPTS.volumes).toContain('Get-Volume');
    expect(POWERSHELL_SCRIPTS.volumes).not.toMatch(/Set-|Format-Volume|Remove-|New-/);
  });

  it('resolves a label to the current drive letter (case-insensitive)', async () => {
    let calls = 0;
    const targets = await resolveTargets(
      ['C:\\FamilyServer\\backups', 'label:reserve\\FamilyServerBackups'],
      {
        systemDrive: 'C:',
        listVolumes: async () => {
          calls += 1;
          return [volume('C', ''), volume('F', 'RESERVE')];
        },
      },
    );
    expect(targets).toEqual([
      {
        name: 'основной диск',
        spec: 'C:\\FamilyServer\\backups',
        root: path.resolve('C:\\FamilyServer\\backups'),
      },
      {
        name: 'флешка «reserve»',
        spec: 'label:reserve\\FamilyServerBackups',
        root: 'F:\\FamilyServerBackups',
      },
    ]);
    expect(calls).toBe(1);
  });

  it('fails only the flash-drive target when it is not connected', async () => {
    const targets = await resolveTargets(['C:\\b', 'label:reserve\\FamilyServerBackups'], {
      systemDrive: 'C:',
      listVolumes: async () => [volume('C', '')],
    });
    expect(targets[0]).toMatchObject({ name: 'основной диск' });
    expect(targets[1]).toEqual({
      name: 'флешка «reserve»',
      spec: 'label:reserve\\FamilyServerBackups',
      root: null,
      error: 'Флешка «reserve» не подключена',
    });
    const twice = await resolveTargets(['label:reserve\\x'], {
      systemDrive: 'C:',
      listVolumes: async () => [volume('E', 'reserve'), volume('F', 'reserve')],
    });
    expect(twice[0]).toMatchObject({ root: null, error: expect.stringMatching(/несколько/) });
    const broken = await resolveTargets(['label:reserve\\x'], {
      systemDrive: 'C:',
      listVolumes: async () => {
        throw new Error('boom');
      },
    });
    expect(broken[0]).toMatchObject({ root: null, error: expect.stringMatching(/список дисков/) });
  });

  it('names targets on other drives and never lists volumes without label targets', async () => {
    const targets = await resolveTargets(['D:\\b', 'C:\\a', 'C:\\c'], {
      systemDrive: 'C:',
      listVolumes: async () => {
        throw new Error('must not be called');
      },
    });
    expect(targets.map((target) => target.name)).toEqual(['диск D:', 'основной диск', 'основной диск (2)']);
  });
});

describe('runBackup', () => {
  it('writes a snapshot to every target and a status file', async () => {
    const result = await runBackup(settings(), deps());
    expect(result.ok).toBe(true);
    expect(result.targets).toHaveLength(2);
    for (const [index, root] of [fx.rootA, fx.rootB].entries()) {
      expect(await fsp.readdir(root)).toEqual([FIRST_NAME]);
      expect(result.targets[index]).toMatchObject({ root, ok: true, snapshot: FIRST_NAME, error: null });
      expect(result.targets[index]?.sizeBytes).toBeGreaterThan(0);
    }
    const status = await readJson(path.join(fx.dataDir, BACKUP_STATUS_FILE));
    expect(status).toMatchObject({
      lastRunAt: NOW,
      lastResult: 'ok',
      lastSuccessAt: NOW,
      restoreTestedAt: null,
    });
    expect(status.targets).toHaveLength(2);
    expect(JSON.stringify(status)).not.toContain(SECRET);
    expect(await fsp.readdir(fx.tempDir)).toEqual([]);
  });

  it('one failing target fails the run, keeps lastSuccessAt, and the other target is still written', async () => {
    await fsp.writeFile(
      path.join(fx.dataDir, BACKUP_STATUS_FILE),
      JSON.stringify({
        lastRunAt: '2026-10-15T18:30:00.000Z',
        lastResult: 'ok',
        lastSuccessAt: '2026-10-15T18:30:00.000Z',
        restoreTestedAt: '2026-10-14T12:00:00.000Z',
      }),
    );
    const result = await runBackup(
      settings({ targets: [fx.rootA, 'label:reserve\\FamilyServerBackups'] }),
      deps(),
    );
    expect(result.ok).toBe(false);
    expect(result.targets[0]).toMatchObject({ ok: true, snapshot: FIRST_NAME });
    expect(result.targets[1]).toMatchObject({
      name: 'флешка «reserve»',
      ok: false,
      root: null,
      error: 'Флешка «reserve» не подключена',
    });
    expect(await fsp.readdir(fx.rootA)).toEqual([FIRST_NAME]);
    const status = await readJson(path.join(fx.dataDir, BACKUP_STATUS_FILE));
    expect(status).toMatchObject({
      lastRunAt: NOW,
      lastResult: 'failed',
      lastSuccessAt: '2026-10-15T18:30:00.000Z',
      restoreTestedAt: '2026-10-14T12:00:00.000Z',
    });
  });

  it('keeps restoreTestedAt after a successful run', async () => {
    await fsp.writeFile(
      path.join(fx.dataDir, BACKUP_STATUS_FILE),
      JSON.stringify({ lastResult: 'ok', restoreTestedAt: '2026-10-14T12:00:00.000Z' }),
    );
    await runBackup(settings(), deps());
    const status = await readJson(path.join(fx.dataDir, BACKUP_STATUS_FILE));
    expect(status).toMatchObject({
      lastResult: 'ok',
      lastSuccessAt: NOW,
      restoreTestedAt: '2026-10-14T12:00:00.000Z',
    });
  });

  it('fails a target without enough free space and writes nothing there', async () => {
    const result = await runBackup(
      settings(),
      deps({
        statfs: async (target) => ({ freeBytes: target.startsWith(fx.rootB) ? 10 * 1024 * 1024 : 1e12 }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.targets[0]).toMatchObject({ ok: true });
    expect(result.targets[1]).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Недостаточно места/),
    });
    expect(await fsp.readdir(fx.rootB)).toEqual([]);
  });

  it('applies retention after writing', async () => {
    for (const name of ['family-backup-20261001-000000', 'family-backup-20261002-000000']) {
      await fakeSnapshot(fx.rootA, name);
    }
    const result = await runBackup(settings({ targets: [fx.rootA], keep: 2 }), deps());
    expect(result.ok).toBe(true);
    expect((await fsp.readdir(fx.rootA)).sort()).toEqual(['family-backup-20261002-000000', FIRST_NAME]);
  });

  it('refuses a target inside the data folder', async () => {
    const result = await runBackup(settings({ targets: [path.join(fx.dataDir, 'backups')] }), deps());
    expect(result.ok).toBe(false);
    expect(result.targets[0]?.error).toMatch(/данн/);
    expect(await exists(path.join(fx.dataDir, 'backups'))).toBe(false);
  });
});

describe('testRestore', () => {
  it('restores the newest snapshot of every target and records restoreTestedAt', async () => {
    await runBackup(settings(), deps());
    fx.clock.advance(HOUR);
    const result = await testRestore(settings(), deps());
    expect(result.ok).toBe(true);
    expect(result.targets.map((target) => target.snapshot)).toEqual([FIRST_NAME, FIRST_NAME]);
    const status = await readJson(path.join(fx.dataDir, BACKUP_STATUS_FILE));
    expect(status).toMatchObject({ lastSuccessAt: NOW, restoreTestedAt: '2026-10-16T19:30:00.000Z' });
    expect(await fsp.readdir(fx.tempDir)).toEqual([]);
  });

  it('does not record a restore test when a target has no snapshot', async () => {
    await runBackup(settings({ targets: [fx.rootA] }), deps());
    const result = await testRestore(settings(), deps());
    expect(result.ok).toBe(false);
    expect(result.targets[1]).toMatchObject({ ok: false, error: expect.stringMatching(/нет ни одной/i) });
    const status = await readJson(path.join(fx.dataDir, BACKUP_STATUS_FILE));
    expect(status.restoreTestedAt).toBeNull();
  });

  it.skipIf(!gitAvailable)('clones the code bundle and compares HEAD with the manifest', async () => {
    await removeDir(fx.base);
    fx = await setup({ repo: true });
    await runBackup(settings(), deps());
    const result = await testRestore(settings(), deps());
    expect(result.ok).toBe(true);
    expect(result.targets[0]).toMatchObject({ ok: true, repoHead: fx.repoHead });
    expect(await fsp.readdir(fx.tempDir)).toEqual([]);
  });
});
