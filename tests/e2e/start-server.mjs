// Starts an isolated dashboard server for Playwright: fresh temp data dir, seeded test users,
// real system probes, built UI from dist/web. Usage: node tests/e2e/start-server.mjs <real|demo> <port>
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
};

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
