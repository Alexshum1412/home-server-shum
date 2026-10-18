// A real end-to-end check of the torrent queue, never touching the family's folders.
//
// It starts the real aria2c.exe (from TORRENT_HOME, default C:\FamilyServer\apps\aria2) and a second,
// throwaway copy of the portal with its own data, files and media folders, then walks one legal torrent
// through the whole life: check → add → cancel → retry → pause → resume → finish → hash of the result.
//
//   node tests/live/torrent-lifecycle.mjs <file.torrent> [--sha256 <expected hash of the downloaded file>] [--root <folder>]
//
// Needs the internet. Nothing is deleted at the end: the folder with the downloaded file is printed.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../server/src/config.ts';
import { ensureAria2SecretSync } from '../../server/src/downloads/aria2.ts';
import { aria2Conf } from '../../server/src/supervisor/apps.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const torrentFile = args.find((arg) => !arg.startsWith('--') && arg.endsWith('.torrent'));
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
if (!torrentFile) {
  console.error(
    'Usage: node tests/live/torrent-lifecycle.mjs <file.torrent> [--sha256 <hex>] [--root <folder>]',
  );
  process.exit(2);
}
const expectedSha = flag('sha256')?.toLowerCase();
const root = path.resolve(
  flag('root') ?? `C:/FamilyServer/downloads/lifecycle-${randomBytes(3).toString('hex')}`,
);
const t0 = Date.now();
const log = (message) =>
  console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)} s] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dataDir = path.join(root, 'data');
const env = {
  ...process.env,
  DASHBOARD_DATA_DIR: dataDir,
  HOST: '127.0.0.1',
  PORT: '8076',
  LOG_LEVEL: 'warn',
  FAMILY_FILES_DIR: path.join(root, 'files'),
  FAMILY_PHOTOS_DIR: path.join(root, 'photos'),
  MEDIA_DIR: path.join(root, 'media'),
  CHAT_DIR: path.join(root, 'chat'),
  BACKUP_TARGETS: path.join(root, 'backups'),
  BACKUP_GIT_PUSH: 'none',
  JELLYFIN_URL: 'http://127.0.0.1:8099',
  PRINTER_IPP_URL: '',
  LAN_BIND: '',
  LAN_URL: '',
  OLIVIA_LLM_URL: '',
  MIN_FREE_GB: '5',
  TORRENT_RPC_URL: 'http://127.0.0.1:6801/jsonrpc',
};
for (const folder of [dataDir, env.FAMILY_FILES_DIR, env.FAMILY_PHOTOS_DIR, env.MEDIA_DIR, env.CHAT_DIR])
  mkdirSync(folder, { recursive: true });
const config = loadConfig(env);
const aria2Dir = path.join(root, 'aria2');
mkdirSync(path.join(aria2Dir, 'incoming'), { recursive: true });
writeFileSync(path.join(aria2Dir, 'session.txt'), '');
const secret = ensureAria2SecretSync(dataDir);
const paths = {
  exe: path.join(config.torrent.home, 'aria2c.exe'),
  dataRoot: aria2Dir,
  conf: path.join(aria2Dir, 'aria2.conf'),
  port: 6801,
};
writeFileSync(paths.conf, aria2Conf(paths, secret, config), { mode: 0o600 });

const children = [];
function start(command, commandArgs, options) {
  const child = spawn(command, commandArgs, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  child.stdout.on('data', (d) =>
    process.stdout.write(`    [${path.basename(command)}] ${String(d).replace(secret, '[secret]').trim()}\n`),
  );
  child.stderr.on('data', (d) =>
    process.stdout.write(
      `    [${path.basename(command)}!] ${String(d).replace(secret, '[secret]').trim()}\n`,
    ),
  );
  return child;
}
async function stopAll() {
  try {
    await fetch('http://127.0.0.1:6801/jsonrpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 's',
        method: 'aria2.shutdown',
        params: [`token:${secret}`],
      }),
    });
  } catch {}
  await sleep(1500);
  for (const child of children) if (child.exitCode === null) child.kill();
}
process.on('SIGINT', () => void stopAll().then(() => process.exit(130)));

const base = 'http://127.0.0.1:8076';
let cookie = '';
async function api(method, url, body, extraHeaders = {}) {
  const headers = { cookie, origin: base, ...extraHeaders };
  let payload;
  if (body instanceof Buffer) payload = body;
  else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(base + url, { method, headers, body: payload });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: response.status, json, setCookie: response.headers.get('set-cookie') };
}

async function sha256(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

function workingSet(pid) {
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue | ForEach-Object { [math]::Round($_.WorkingSet64/1MB) })`,
    ],
    { encoding: 'utf8' },
  );
  return Number(r.stdout.trim()) || null;
}

let exitCode = 0;
try {
  log(`working folder: ${root}`);
  const password = `Lc-${randomBytes(9).toString('base64url')}`;
  const added = spawnSync(
    process.execPath,
    [
      'server/src/cli/users.ts',
      'add',
      'lifecycle',
      '--name',
      'Проверка',
      '--role',
      'admin',
      '--password-stdin',
    ],
    { cwd: repo, env, input: `${password}\n`, encoding: 'utf8' },
  );
  if (added.status !== 0) throw new Error(`cannot create the test user: ${added.stdout}${added.stderr}`);

  const aria = start(paths.exe, [`--conf-path=${paths.conf}`], { cwd: path.dirname(paths.exe) });
  start(process.execPath, ['server/src/index.ts'], { cwd: repo, env });
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {}
    await sleep(500);
  }
  const login = await api('POST', '/api/login', { username: 'lifecycle', password });
  if (login.status !== 200) throw new Error(`login failed: ${login.status}`);
  cookie = (login.setCookie ?? '').split(';')[0];
  log('signed in to the throwaway portal');

  const list0 = await api('GET', '/api/downloads');
  log(`engine: ${JSON.stringify(list0.json?.torrentEngine)}`);
  if (list0.json?.torrentEngine?.state !== 'ok')
    throw new Error('the torrent client is not available to the portal');

  const bytes = readFileSync(torrentFile);
  /** Check the file (the portal reads it first) and add it; the same steps a person takes in «Загрузки». */
  async function submit() {
    const put = await api(
      'PUT',
      `/api/downloads/torrent-file?name=${encodeURIComponent(path.basename(torrentFile))}`,
      bytes,
      { 'content-type': 'application/octet-stream', 'x-upload': '1' },
    );
    log(`check: HTTP ${put.status} ${put.json?.status ?? ''}`);
    let check = put.json;
    for (let i = 0; i < 40 && check?.status === 'pending'; i += 1) {
      await sleep(1000);
      check = (await api('GET', `/api/downloads/check/${check.checkId}`)).json;
    }
    if (check?.status !== 'ready')
      throw new Error(`the check did not finish: ${JSON.stringify(check).slice(0, 300)}`);
    log(
      `check ready: «${check.fileName}», will download ${check.willDownload?.files} file(s), ${check.willDownload?.sizeBytes} bytes`,
    );
    const add = await api('POST', '/api/downloads', { checkId: check.checkId, destination: 'personal' });
    if (add.status >= 300) throw new Error(`add failed: ${add.status} ${JSON.stringify(add.json)}`);
    log(`added: id ${add.json.id.slice(0, 8)}, state ${add.json.state}`);
    return add.json;
  }
  let task = await submit();

  const act = async (action) => {
    const r = await api('POST', `/api/downloads/${task.id}/${action}`, {});
    if (r.status < 300 && r.json) task = r.json;
    log(
      `${action}: HTTP ${r.status}, state now ${task.state ?? '?'}${r.json?.error ? ` (${r.json.error})` : ''}`,
    );
    return r;
  };
  const view = async () => {
    const r = await api('GET', '/api/downloads');
    const found =
      (r.json?.tasks ?? []).find((item) => item.id === task.id) ??
      (r.json?.tasks ?? []).find((item) => item.kind === 'torrent');
    if (found) task = found;
    return found;
  };

  const phases = { cancelled: false, retried: false, paused: false, resumed: false };
  let lastLog = 0;
  let peakSpeed = 0;
  let peakUpload = 0;
  const deadline = Date.now() + 60 * 60_000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const current = await view();
    if (!current) continue;
    const percent = current.sizeBytes
      ? Math.round((current.receivedBytes / current.sizeBytes) * 1000) / 10
      : 0;
    peakSpeed = Math.max(peakSpeed, current.speedBps ?? 0);
    peakUpload = Math.max(peakUpload, current.torrent?.uploadSpeedBps ?? 0);
    if (Date.now() - lastLog > 15_000) {
      lastLog = Date.now();
      log(
        `${current.state} ${percent}% ${(current.receivedBytes / 1048576).toFixed(0)}/${((current.sizeBytes ?? 0) / 1048576).toFixed(0)} MiB, ${((current.speedBps ?? 0) / 1048576).toFixed(2)} MiB/s, eta ${current.torrent?.etaSec ?? '-'} s, peers ${current.torrent?.connections ?? '-'}, seeders ${current.torrent?.seeders ?? '-'}, up ${((current.torrent?.uploadSpeedBps ?? 0) / 1024).toFixed(0)} KiB/s, aria2 ${workingSet(aria.pid) ?? '?'} MiB`,
      );
    }
    if (current.state === 'failed') {
      log(`failed: ${current.error}`);
      exitCode = 1;
      break;
    }
    if (current.state === 'completed') break;
    if (!phases.cancelled && percent >= 2 && current.state === 'downloading') {
      phases.cancelled = true;
      const before = current.receivedBytes;
      const r = await act('cancel');
      await sleep(2500);
      const left = ((await api('GET', '/api/downloads')).json?.tasks ?? []).filter(
        (item) => item.kind === 'torrent',
      ).length;
      log(`after cancel (HTTP ${r.status}): torrent tasks in the list: ${left}`);
      // «Отменить» takes the download off the list; adding the same torrent again continues from the partial file
      task = await submit();
      phases.retried = true;
      log(
        `added again; it had ${(before / 1048576).toFixed(0)} MiB before the cancel, now: ${(task.receivedBytes / 1048576).toFixed(0)} MiB`,
      );
    } else if (phases.retried && !phases.paused && percent >= 4 && task.state === 'downloading') {
      phases.paused = true;
      const before = task.receivedBytes;
      await act('pause');
      await sleep(8000);
      await view();
      log(`paused for 8 s: state ${task.state}, bytes moved while paused: ${task.receivedBytes - before}`);
      await act('resume');
      phases.resumed = true;
    }
  }
  if (task.state === 'completed') {
    log(
      `completed: ${task.fileName}; peak download ${(peakSpeed / 1048576).toFixed(2)} MiB/s, peak upload ${(peakUpload / 1024).toFixed(0)} KiB/s (limit ${config.torrent.uploadLimitKb} KiB/s)`,
    );
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(env.FAMILY_FILES_DIR);
    for (const file of files) log(`  result file: ${file} (${statSync(file).size} bytes)`);
    const iso = files.find((file) => !file.endsWith('.torrent'));
    if (iso) {
      const digest = await sha256(iso);
      log(`  sha256: ${digest}`);
      if (expectedSha) {
        log(
          digest === expectedSha
            ? '  MATCHES the published checksum'
            : '  DOES NOT MATCH the published checksum',
        );
        if (digest !== expectedSha) exitCode = 1;
      }
    }
    log(`phases seen: ${JSON.stringify(phases)}`);
    const removed = await api('POST', `/api/downloads/${task.id}/remove`, {});
    log(`remove from the list: HTTP ${removed.status}`);
  } else if (exitCode === 0) {
    log('did not complete within the time limit');
    exitCode = 1;
  }
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  exitCode = 1;
} finally {
  await stopAll();
  log(`stopped; the folder is left for you to inspect or delete: ${root}`);
}
process.exit(exitCode);
