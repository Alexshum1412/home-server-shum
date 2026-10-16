import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir, REPO_ROOT, removeDir } from './helpers.ts';

const CLI = path.join(REPO_ROOT, 'server', 'src', 'cli', 'backup.ts');
const SECRET = 'cli-secret-marker-91c2';
const SNAPSHOT_RE = /^family-backup-\d{8}-\d{6}(-\d+)?$/;
const gitAvailable = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

let base: string;
let dataDir: string;
let rootA: string;
let rootB: string;
let tempDir: string;
let repoDir: string;
let outputs: string[];

async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, content);
  }
}

beforeEach(async () => {
  base = await makeTempDir('fd-backup-cli-');
  dataDir = path.join(base, 'data');
  rootA = path.join(base, 'backups-a');
  rootB = path.join(base, 'backups-b');
  tempDir = path.join(base, 'tmp');
  repoDir = path.join(base, 'repo');
  await fsp.mkdir(tempDir);
  await writeTree(dataDir, {
    'users.json': JSON.stringify({ users: [{ username: 'papa', passwordHash: SECRET }] }),
    'services.json': '{"services":[]}',
    'audit.jsonl': `{"detail":"${SECRET}"}\n`,
    'sessions.json': `{"token":"${SECRET}"}`,
  });
  await writeTree(path.join(base, 'project'), { '.env': `SECRET=${SECRET}\n` });
  await fsp.mkdir(repoDir);
  if (gitAvailable) {
    execFileSync('git', ['init', '-q', repoDir], { windowsHide: true });
    await fsp.writeFile(path.join(repoDir, 'README.md'), 'code\n');
    execFileSync('git', ['-C', repoDir, 'add', 'README.md'], { windowsHide: true });
    execFileSync(
      'git',
      [
        '-C',
        repoDir,
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
      ],
      { windowsHide: true },
    );
  }
  outputs = [];
});

afterEach(async () => {
  await removeDir(base);
  // Whatever happened, the CLI never printed the contents of a backed-up file.
  expect(outputs.join('\n')).not.toContain(SECRET);
});

/** Temp folders only: the real data folder, C:\FamilyServer and the flash drive are unreachable. */
function cliEnv(targets = `${rootA};${rootB}`): NodeJS.ProcessEnv {
  return {
    SystemRoot: process.env.SystemRoot,
    SystemDrive: process.env.SystemDrive,
    PATH: process.env.PATH,
    TEMP: tempDir,
    TMP: tempDir,
    USERPROFILE: base,
    LOCALAPPDATA: base,
    DASHBOARD_DATA_DIR: dataDir,
    BACKUP_TARGETS: targets,
    BACKUP_KEEP: '3',
    BACKUP_REPO_DIR: repoDir,
    BACKUP_EXTRA_FILES: path.join(base, 'project', '.env'),
    TAILSCALE_EXE: path.join(base, 'no-tailscale.exe'),
  };
}

function runCli(args: string[], env = cliEnv()): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      outputs.push(stdout, stderr);
      resolve({ code, stdout, stderr });
    });
  });
}

async function snapshotsIn(root: string): Promise<string[]> {
  return (await fsp.readdir(root)).filter((name) => SNAPSHOT_RE.test(name)).sort();
}

async function readStatus(): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(path.join(dataDir, 'backup-status.json'), 'utf8'));
}

describe('backup CLI', { timeout: 120_000 }, () => {
  it('run → list → verify → test-restore → restore on two temp targets', async () => {
    const run = await runCli(['run']);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('основной диск');
    expect(run.stdout).toContain('Резервное копирование завершено');
    const [snapA] = await snapshotsIn(rootA);
    expect(snapA).toBeDefined();
    expect(await snapshotsIn(rootB)).toEqual([snapA]);
    expect(await readStatus()).toMatchObject({ lastResult: 'ok', restoreTestedAt: null });

    const list = await runCli(['list']);
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).toContain(snapA);
    expect(list.stdout).toContain(rootA);
    expect(list.stdout).toContain(rootB);

    const verify = await runCli(['verify']);
    expect(verify.code, verify.stderr).toBe(0);
    expect(verify.stdout).toContain('в порядке');

    const tested = await runCli(['test-restore']);
    expect(tested.code, tested.stderr).toBe(0);
    expect(tested.stdout).toContain('Проверка восстановления пройдена');
    expect((await readStatus()).restoreTestedAt).toEqual(expect.any(String));

    const dest = path.join(base, 'restored');
    const restore = await runCli(['restore', path.join(rootA, snapA ?? ''), '--to', dest]);
    expect(restore.code, restore.stderr).toBe(0);
    expect(await fsp.readFile(path.join(dest, 'data', 'users.json'), 'utf8')).toContain('papa');
    if (gitAvailable) {
      // Git for Windows may check out with CRLF (core.autocrlf).
      expect(await fsp.readFile(path.join(dest, 'repo', 'README.md'), 'utf8')).toMatch(/^code\r?\n$/);
    }
    expect((await fsp.readdir(tempDir)).filter((name) => name.startsWith('family-'))).toEqual([]);

    const prune = await runCli(['prune']);
    expect(prune.code, prune.stderr).toBe(0);
  });

  it('verify of a damaged snapshot fails with exit code 1', async () => {
    expect((await runCli(['run'])).code).toBe(0);
    const [snap] = await snapshotsIn(rootA);
    const dir = path.join(rootA, snap ?? '');
    await fsp.appendFile(path.join(dir, 'data', 'users.json'), ' ');
    const verify = await runCli(['verify', dir]);
    expect(verify.code).toBe(1);
    expect(`${verify.stdout}${verify.stderr}`).toContain('data/users.json');
  });

  it('a failing target makes the run exit 1, the other target is still written', async () => {
    const blocked = path.join(base, 'not-a-folder');
    await fsp.writeFile(blocked, 'a file where a folder should be');
    const run = await runCli(['run'], cliEnv(`${rootA};${blocked}`));
    expect(run.code).toBe(1);
    expect(`${run.stdout}${run.stderr}`).toContain('ОШИБКА');
    expect(await snapshotsIn(rootA)).toHaveLength(1);
    expect(await readStatus()).toMatchObject({ lastResult: 'failed', lastSuccessAt: null });
  });

  it('usage errors exit with code 2', async () => {
    expect((await runCli([])).code).toBe(2);
    expect((await runCli(['frobnicate'])).code).toBe(2);
    expect((await runCli(['restore', path.join(rootA, 'x')])).code).toBe(2);
    const help = await runCli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('test-restore');
    // Restore into the live data folder is refused.
    expect((await runCli(['run'])).code).toBe(0);
    const [snap] = await snapshotsIn(rootA);
    const refused = await runCli(['restore', path.join(rootA, snap ?? ''), '--to', dataDir]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('рабочую папку');
  });
});
