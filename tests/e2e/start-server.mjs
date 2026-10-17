// Starts an isolated dashboard server for Playwright: fresh temp data dir, seeded test users,
// real system probes, built UI from dist/web. Usage: node tests/e2e/start-server.mjs <real|demo> <port>
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode = 'real', port = '8071'] = process.argv.slice(2);
const root = fileURLToPath(new URL('../..', import.meta.url));

if (!existsSync(join(root, 'dist', 'web', 'index.html'))) {
  console.error('dist/web is missing: run "npm.cmd run build" before the e2e tests.');
  process.exit(1);
}

const dataDir = mkdtempSync(join(tmpdir(), `family-dashboard-e2e-${mode}-`));
const env = {
  ...process.env,
  DASHBOARD_DATA_DIR: dataDir,
  HOST: '127.0.0.1',
  PORT: port,
  DASHBOARD_DEMO: mode === 'demo' ? '1' : '0',
  LOG_LEVEL: 'warn',
  LAN_URL: '',
  // No real printer for tests.
  PRINTER_IPP_URL: '',
  // Never the real family folders (C:/FamilyData): everything stays in the throwaway data dir.
  FAMILY_FILES_DIR: join(dataDir, 'files'),
  FAMILY_PHOTOS_DIR: join(dataDir, 'photos'),
  MIN_FREE_GB: '1',
  // The media library of the fallback player is a throwaway folder as well (see below).
  MEDIA_DIR: join(dataDir, 'media'),
  // No home-network listener, no language model in tests.
  LAN_BIND: '',
  OLIVIA_LLM_URL: '',
  // Never the real backup places either: a test snapshot would count against their retention.
  BACKUP_TARGETS: join(dataDir, 'backups'),
  BACKUP_GIT_PUSH: 'none',
};

// A tiny media library: one valid one-second WAV (every browser plays it) as an audiobook chapter,
// and a file the browser cannot decode (to see the honest message).
function silentWav(seconds) {
  const rate = 8000;
  const data = Buffer.alloc(rate * seconds);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, Buffer.alloc(0), Buffer.alloc(data.length, 128)]);
}
mkdirSync(join(dataDir, 'media', 'Аудиокниги', 'Тестовая книга'), { recursive: true });
writeFileSync(join(dataDir, 'media', 'Аудиокниги', 'Тестовая книга', 'Глава 01.wav'), silentWav(1));
mkdirSync(join(dataDir, 'media', 'Фильмы'), { recursive: true });
writeFileSync(join(dataDir, 'media', 'Фильмы', 'сломанный.mp4'), 'not really a video');

// Same values as tests/e2e/fixtures.ts (kept in sync manually; plain JS cannot import the .ts file here).
const users = [
  ['e2e-admin', 'Тестовый админ', 'admin', 'e2e-admin-password-1'],
  ['e2e-family', 'Тестовая семья', 'family', 'e2e-family-password-1'],
  ['e2e-temp', 'Новичок', 'family', 'e2e-temp-password-1'],
  ['e2e-change', 'Меняющий', 'family', 'e2e-change-password-1'],
];
for (const [username, name, role, password] of users) {
  const r = spawnSync(
    process.execPath,
    ['server/src/cli/users.ts', 'add', username, '--name', name, '--role', role, '--password-stdin'],
    { cwd: root, env, input: `${password}\n`, encoding: 'utf8' },
  );
  if (r.status !== 0) {
    console.error(`Failed to seed user ${username}:`, r.stdout, r.stderr);
    process.exit(1);
  }
}

// e2e-temp behaves like an account made with --generate-password: it must pick an own password.
const usersFile = join(dataDir, 'users.json');
const stored = JSON.parse(readFileSync(usersFile, 'utf8'));
for (const user of stored.users) {
  if (user.username === 'e2e-temp') {
    user.mustChangePassword = true;
    user.passwordExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  }
}
writeFileSync(usersFile, JSON.stringify(stored, null, 2));

const server = spawn(process.execPath, ['server/src/index.ts'], { cwd: root, env, stdio: 'inherit' });

const cleanup = () => {
  if (server.exitCode === null) server.kill();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // best effort: the temp dir may still be locked on Windows
  }
};
server.on('exit', (code) => {
  cleanup();
  process.exit(code ?? 0);
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(signal, () => {
    cleanup();
    process.exit(0);
  });
}
