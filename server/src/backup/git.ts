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
  // Push failures first: they are the ones a family admin is most likely to see.
  if (/\[rejected\]|non-fast-forward|fetch first|failed to push some refs/i.test(text)) {
    return 'на GitHub есть коммиты, которых нет здесь; принудительная перезапись не выполняется — разберитесь вручную (git pull в папке проекта)';
  }
  if (
    /authentication failed|could not read username|terminal prompts disabled|invalid username|permission .* denied|\b403\b/i.test(
      text,
    )
  ) {
    return 'нет доступа к GitHub — войдите заново: выполните git push в папке проекта';
  }
  if (
    /could not resolve host|failed to connect|unable to access|timed out|connection was reset/i.test(text)
  ) {
    return 'нет связи с GitHub';
  }
  if (/not a git repository/i.test(text)) return 'папка не является Git-репозиторием';
  if (/dubious ownership/i.test(text)) {
    return 'Git не доверяет папке с другим владельцем (запускайте копирование от имени владельца репозитория)';
  }
  if (/empty bundle/i.test(text)) return 'в репозитории ещё нет ни одного коммита';
  const line = text.split(/\r?\n/).find((item) => item.trim() !== '') ?? '';
  return line === '' ? 'неизвестная ошибка' : line.slice(0, 200);
}

/** Runs git with a fixed argument array (no shell); rejects with a Russian GitError. */
export function runGit(
  gitExe: string,
  args: readonly string[],
  timeoutMs = GIT_TIMEOUT_MS,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      gitExe,
      [...args],
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
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

/** The only remotes the scheduled mirror may push to: a repository on https://github.com/. */
export const GITHUB_REMOTE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(?:\.git)?\/?$/i;
export const PUSH_TIMEOUT_MS = 2 * 60_000;

/** Never show credentials that may be embedded in a remote URL. */
function withoutCredentials(url: string): string {
  return url.replace(/\/\/[^@/]+@/, '//');
}

export interface PushResult {
  /** Remote URL without credentials. */
  url: string;
  /** The commit the branch points to (what is now on the remote). */
  head: string;
}

/**
 * Pushes one branch of the repository to its remote: fast-forward only (never --force), never
 * prompts (a missing GitHub login fails instead of opening a window in a scheduled run), and only
 * to a remote whose URL matches `allowedUrl` (https://github.com/ by default).
 */
export async function pushBranch(
  gitExe: string,
  repoDir: string,
  remote: string,
  branch: string,
  allowedUrl: RegExp = GITHUB_REMOTE,
  timeoutMs = PUSH_TIMEOUT_MS,
): Promise<PushResult> {
  const rawUrl = (await runGit(gitExe, ['-C', repoDir, 'remote', 'get-url', remote])).trim();
  const url = withoutCredentials(rawUrl);
  if (!allowedUrl.test(rawUrl)) {
    throw new GitError(
      'failed',
      `отправка разрешена только в репозиторий на https://github.com/ (у «${remote}» сейчас: ${url})`,
    );
  }
  const head = (
    await runGit(gitExe, ['-C', repoDir, 'rev-parse', '--verify', `refs/heads/${branch}`])
  ).trim();
  await runGit(
    gitExe,
    ['-C', repoDir, 'push', '--porcelain', remote, `refs/heads/${branch}:refs/heads/${branch}`],
    timeoutMs,
    { GCM_INTERACTIVE: 'never' },
  );
  return { url, head };
}

/** Clones a bundle into `dest` (which must not exist) and returns the checked-out HEAD. */
export async function cloneBundle(gitExe: string, bundle: string, dest: string): Promise<string> {
  await runGit(gitExe, ['clone', '-q', bundle, dest]);
  return (await runGit(gitExe, ['-C', dest, 'rev-parse', 'HEAD'])).trim();
}
