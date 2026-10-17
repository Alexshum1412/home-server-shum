import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BackupDeps, type BackupSettings, runBackup } from '../src/backup/run.ts';
import { BACKUP_STATUS_FILE } from '../src/backup/status.ts';
import { loadConfig } from '../src/config.ts';
import { readBackupStatus } from '../src/system/backup.ts';
import { createFakeClock, makeTempDir, removeDir } from './helpers.ts';

const GIT = 'git';
const gitAvailable = spawnSync(GIT, ['--version'], { windowsHide: true }).status === 0;
const NOW = '2026-10-17T00:30:00.000Z';

function git(args: string[]): string {
  return execFileSync(GIT, args, { encoding: 'utf8', windowsHide: true }).trim();
}

const IDENTITY = [
  '-c',
  'user.name=Test',
  '-c',
  'user.email=test@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

async function commit(repo: string, file: string, text: string): Promise<string> {
  await fsp.writeFile(path.join(repo, file), text);
  git(['-C', repo, 'add', file]);
  git(['-C', repo, ...IDENTITY, 'commit', '-q', '-m', `change ${file}`]);
  return git(['-C', repo, 'rev-parse', 'HEAD']);
}

interface Fx {
  base: string;
  dataDir: string;
  root: string;
  repo: string;
  remote: string;
  head: string;
}

let fx: Fx;

beforeEach(async () => {
  const base = await makeTempDir('fd-mirror-');
  const dataDir = path.join(base, 'data');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(path.join(dataDir, 'services.json'), '{"services":[]}');
  const repo = path.join(base, 'repo');
  const remote = path.join(base, 'remote.git');
  let head = '';
  if (gitAvailable) {
    await fsp.mkdir(repo, { recursive: true });
    git(['init', '-q', repo]);
    head = await commit(repo, 'README.md', '# test\n');
    git(['-C', repo, 'branch', '-M', 'main']);
    git(['init', '-q', '--bare', remote]);
    git(['-C', repo, 'remote', 'add', 'origin', remote]);
  }
  fx = { base, dataDir, root: path.join(base, 'backups'), repo, remote, head };
}, 60_000);

afterEach(async () => {
  await removeDir(fx.base);
});

function settings(overrides: Partial<BackupSettings> = {}): BackupSettings {
  return {
    dataDir: fx.dataDir,
    targets: [fx.root],
    keep: 14,
    repoDir: fx.repo,
    extraFiles: [],
    gitExe: GIT,
    // Tests push to a local bare repository; production allows only https://github.com/.
    gitPush: { remote: 'origin', branch: 'main', allowedUrl: /.*/ },
    ...overrides,
  };
}

function deps(): BackupDeps {
  return {
    clock: createFakeClock(NOW),
    appVersion: '9.9.9',
    listVolumes: async () => [],
    statfs: async () => ({ freeBytes: 500 * 1024 * 1024 * 1024 }),
    tailscaleServe: async () => ({}),
    tempDir: path.join(fx.base, 'tmp'),
    systemDrive: path.parse(fx.base).root.slice(0, 2),
  };
}

describe.skipIf(!gitAvailable)('GitHub mirror of the code', { timeout: 60_000 }, () => {
  it('pushes the committed history and records it as an optional target', async () => {
    const result = await runBackup(settings(), deps());
    expect(result.ok).toBe(true);
    const mirror = result.targets.find((target) => target.optional);
    expect(mirror).toMatchObject({ name: 'GitHub (код)', ok: true, optional: true, error: null });
    expect(mirror?.snapshot).toBe(fx.head.slice(0, 12));
    expect(git(['--git-dir', fx.remote, 'rev-parse', 'refs/heads/main'])).toBe(fx.head);
    const status = JSON.parse(await fsp.readFile(path.join(fx.dataDir, BACKUP_STATUS_FILE), 'utf8'));
    expect(status.lastResult).toBe('ok');
    expect(status.targets.some((target: { optional?: boolean }) => target.optional === true)).toBe(true);
  });

  it('never force-pushes: a diverged remote is a remark, the local backup still succeeds', async () => {
    // Someone else pushed a commit the local repository does not have.
    const other = path.join(fx.base, 'other');
    git(['push', '-q', fx.remote, 'main']);
    git(['clone', '-q', '-b', 'main', fx.remote, other]);
    const theirs = await commit(other, 'THEIRS.md', 'theirs\n');
    git(['-C', other, 'push', '-q', 'origin', 'main']);
    await commit(fx.repo, 'OURS.md', 'ours\n');

    const result = await runBackup(settings(), deps());
    expect(result.ok).toBe(true);
    const mirror = result.targets.find((target) => target.optional);
    expect(mirror?.ok).toBe(false);
    expect(mirror?.error).toMatch(/вручную/);
    expect(result.warnings.some((warning) => warning.startsWith('GitHub (код):'))).toBe(true);
    // The remote keeps its own history.
    expect(git(['--git-dir', fx.remote, 'rev-parse', 'refs/heads/main'])).toBe(theirs);
  });

  it('refuses to push anywhere but https://github.com/ by default', async () => {
    const result = await runBackup(
      settings({ gitPush: { remote: 'origin', branch: 'main', allowedUrl: undefined } }),
      deps(),
    );
    const mirror = result.targets.find((target) => target.optional);
    expect(mirror).toMatchObject({ ok: false });
    expect(mirror?.error).toMatch(/github\.com/);
    expect(
      spawnSync(GIT, ['--git-dir', fx.remote, 'rev-parse', '--verify', 'refs/heads/main']).status,
    ).not.toBe(0);
  });

  it('adds no mirror entry when pushing is not configured', async () => {
    const result = await runBackup(settings({ gitPush: null }), deps());
    expect(result.targets.some((target) => target.optional)).toBe(false);
  });
});

describe('dashboard status with an optional mirror', () => {
  it('shows a failed GitHub mirror as a remark, not as a failed backup', async () => {
    const dataDir = path.join(fx.base, 'status');
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.writeFile(
      path.join(dataDir, BACKUP_STATUS_FILE),
      JSON.stringify({
        lastRunAt: NOW,
        lastResult: 'ok',
        lastSuccessAt: NOW,
        restoreTestedAt: NOW,
        targets: [
          {
            name: 'основной диск',
            root: 'C:\\FamilyServer\\backups',
            ok: true,
            snapshot: 'x',
            sizeBytes: 1,
            error: null,
          },
          {
            name: 'GitHub (код)',
            root: 'https://github.com/a/b.git',
            ok: false,
            snapshot: null,
            sizeBytes: null,
            error: 'нет связи с GitHub',
            optional: true,
          },
        ],
        warnings: ['GitHub (код): нет связи с GitHub'],
      }),
    );
    const info = await readBackupStatus(dataDir, () => new Date(NOW));
    expect(info.state).toBe('ok');
    expect(info.message).toContain('GitHub (код) — нет');
  });
});

describe('BACKUP_GIT_PUSH setting', () => {
  it('parses remote/branch, turns off with none or empty, rejects garbage', () => {
    expect(loadConfig({ BACKUP_GIT_PUSH: 'origin/main' }).backupGitPush).toEqual({
      remote: 'origin',
      branch: 'main',
    });
    expect(loadConfig({ BACKUP_GIT_PUSH: 'none' }).backupGitPush).toBeNull();
    expect(loadConfig({}).backupGitPush).toBeNull();
    expect(() => loadConfig({ BACKUP_GIT_PUSH: 'origin main; rm -rf' })).toThrow();
  });
});
