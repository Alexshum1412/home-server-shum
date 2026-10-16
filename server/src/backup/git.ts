import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { removeTree } from './files.ts';

/** A repository of a few MB bundles in seconds; a slow USB drive gets plenty of headroom. */
export const GIT_TIMEOUT_MS = 5 * 60_000;
const MAX_BUFFER = 16 * 1024 * 1024;

export class GitError extends Error {
  readonly code: 'not_found' | 'timeout' | 'failed';
  constructor(code: GitError['code'], message: string) {
    super(message);
    this.name = 'GitError';
    this.code = code;
  }
}

function explain(stderr: string): string {
  const text = stderr.trim();
  if (/not a git repository/i.test(text)) return 'папка не является Git-репозиторием';
  if (/dubious ownership/i.test(text)) {
    return 'Git не доверяет папке с другим владельцем (запускайте копирование от имени владельца репозитория)';
  }
  if (/empty bundle/i.test(text)) return 'в репозитории ещё нет ни одного коммита';
  const line = text.split(/\r?\n/).find((item) => item.trim() !== '') ?? '';
  return line === '' ? 'неизвестная ошибка' : line.slice(0, 200);
}

/** Runs git with a fixed argument array (no shell); rejects with a Russian GitError. */
export function runGit(gitExe: string, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      gitExe,
      [...args],
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        if (error.code === 'ENOENT') {
          reject(new GitError('not_found', `Git не найден (${gitExe}); укажите путь к git.exe в GIT_EXE`));
        } else if (error.killed || error.signal) {
          reject(new GitError('timeout', `Git не ответил за ${Math.round(timeoutMs / 60_000)} мин`));
        } else {
          reject(new GitError('failed', `Git: ${explain(stderr)}`));
        }
      },
    );
  });
}

export interface BundleInfo {
  head: string | null;
  refs: string[];
}

/** `git bundle list-heads`: "<sha> <ref>" lines. */
export async function listBundleHeads(gitExe: string, bundle: string): Promise<BundleInfo> {
  const out = await runGit(gitExe, ['bundle', 'list-heads', bundle]);
  let head: string | null = null;
  const refs: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    const match = /^([0-9a-f]{40,64})\s+(\S+)$/.exec(line.trim());
    if (!match) continue;
    const [, sha, ref] = match;
    if (ref === 'HEAD') head = sha ?? null;
    else if (ref) refs.push(ref);
  }
  return { head, refs };
}

/** Bundles every ref of the repository into `outFile` (git bundle create <file> --all). */
export async function createBundle(gitExe: string, repoDir: string, outFile: string): Promise<BundleInfo> {
  await runGit(gitExe, ['-C', repoDir, 'bundle', 'create', outFile, '--all']);
  return listBundleHeads(gitExe, outFile);
}

/** `git bundle verify` needs a repository: use a throwaway empty bare one under `tempDir`. */
export async function verifyBundle(gitExe: string, bundle: string, tempDir: string): Promise<void> {
  await fsp.mkdir(tempDir, { recursive: true });
  const scratch = await fsp.mkdtemp(path.join(tempDir, 'family-git-verify-'));
  try {
    await runGit(gitExe, ['init', '-q', '--bare', scratch]);
    await runGit(gitExe, ['--git-dir', scratch, 'bundle', 'verify', '-q', bundle]);
  } finally {
    await removeTree(scratch, tempDir).catch(() => undefined);
  }
}

/** Clones a bundle into `dest` (which must not exist) and returns the checked-out HEAD. */
export async function cloneBundle(gitExe: string, bundle: string, dest: string): Promise<string> {
  await runGit(gitExe, ['clone', '-q', bundle, dest]);
  return (await runGit(gitExe, ['-C', dest, 'rev-parse', 'HEAD'])).trim();
}
