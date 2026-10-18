// Starts an isolated dashboard server for Playwright: fresh temp data dir, seeded test users,
// real system probes, built UI from dist/web. Usage: node tests/e2e/start-server.mjs <real|demo> <port>
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode = 'real', port = '8071'] = process.argv.slice(2);
const root = fileURLToPath(new URL('../..', import.meta.url));

if (!existsSync(join(root, 'dist', 'web', 'index.html'))) {
  console.error('dist/web is missing: run "npm.cmd run build" before the e2e tests.');
  process.exit(1);
}

const dataDir = mkdtempSync(join(tmpdir(), `family-dashboard-e2e-${mode}-`));
const guideBackups = join(tmpdir(), `${basename(dataDir)}-backups`);
// «cinema» is the real mode plus a stand-in for Jellyfin (fake data, a generated test video): the
// catalogue page is checked against it. Every other mode never reaches any Jellyfin.
// «guide» is the cinema mode with family-like names: the pictures of docs/FAMILY_USER_GUIDE.md are taken on it.
const cinemaLike = mode === 'cinema' || mode === 'guide';
const fakeJellyfinPort = 8097;
const fakeAria2Port = 8098;
if (cinemaLike) {
  const { startFakeJellyfin, FAKE_KEY } = await import('./fake-jellyfin.mjs');
  await startFakeJellyfin({
    port: fakeJellyfinPort,
    videoFile: join(root, 'tests', 'e2e', 'fixture-video.mp4'),
  });
  writeFileSync(join(dataDir, 'jellyfin-api.json'), JSON.stringify({ apiKey: FAKE_KEY }));
  // The cinema service is «set up»: Jellyfin's own page for the family has an address (never opened by a test).
  const { DEFAULT_SERVICES } = await import('../../server/src/services/config.ts');
  const services = DEFAULT_SERVICES.map((service) =>
    service.kind === 'media'
      ? {
          ...service,
          openUrl: 'https://jellyfin.example.test:8443',
          healthUrl: `http://127.0.0.1:${fakeJellyfinPort}/health`,
        }
      : service,
  );
  writeFileSync(join(dataDir, 'services.json'), JSON.stringify({ version: 1, services }, null, 2));
  // The torrent client is a stand-in too: it moves a download forward every time the portal looks.
  const { startFakeAria2 } = await import('../../server/test/fixtures/fake-aria2.ts');
  const { makeTorrent } = await import('../../server/test/fixtures/torrent-builder.ts');
  const { E2E_TORRENT } = await import('./torrent-fixture.ts');
  const secret = 'e'.repeat(64);
  writeFileSync(join(dataDir, 'aria2-rpc.json'), JSON.stringify({ secret }));
  const sample = makeTorrent(E2E_TORRENT);
  await startFakeAria2({
    secret,
    port: fakeAria2Port,
    autoAdvance: true,
    metadata: [{ infoHash: sample.infoHash, torrent: sample.bytes }],
  });
}
const env = {
  ...process.env,
  DASHBOARD_DATA_DIR: dataDir,
  HOST: '127.0.0.1',
  PORT: port,
  DASHBOARD_DEMO: mode === 'demo' ? '1' : '0',
  // Never the real Jellyfin of this PC (a test data folder has no key for it anyway).
  JELLYFIN_URL: cinemaLike ? `http://127.0.0.1:${fakeJellyfinPort}` : 'http://127.0.0.1:8099',
  // The torrent client of the cinema mode is the stand-in below; nobody else reaches a real one.
  TORRENT_RPC_URL: `http://127.0.0.1:${cinemaLike ? fakeAria2Port : 8100}/jsonrpc`,
  TORRENT_HOME: join(dataDir, 'no-torrent-client'),
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
  // The chat keeps its messages and attachments in the throwaway folder too.
  CHAT_DIR: join(dataDir, 'chat'),
  // No home-network listener, no language model in tests.
  LAN_BIND: '',
  OLIVIA_LLM_URL: '',
  // Never the real backup places either: a test snapshot would count against their retention.
  BACKUP_TARGETS: join(dataDir, 'backups'),
  BACKUP_GIT_PUSH: 'none',
  // Nothing of this PC is copied by the backup of the screenshot server: its own empty folders only.
  JELLYFIN_DATA_DIR: join(dataDir, 'jellyfin-data'),
  BACKUP_EXTRA_FILES: 'none',
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
const users =
  mode === 'guide'
    ? [
        // Throwaway accounts of the screenshot server: the passwords exist only in this temp folder.
        ['alex', 'Алекс', 'admin', 'guide-alex-password-1'],
        ['yulia', 'Юлия', 'family', 'guide-yulia-password-1'],
        ['vitalik', 'Виталик', 'family', 'guide-vitalik-password-1'],
        ['sasha', 'Саша', 'family', 'guide-sasha-password-1'],
      ]
    : [
        ['e2e-admin', 'Тестовый админ', 'admin', 'e2e-admin-password-1'],
        ['e2e-family', 'Тестовая семья', 'family', 'e2e-family-password-1'],
        ['e2e-temp', 'Новичок', 'family', 'e2e-temp-password-1'],
        ['e2e-change', 'Меняющий', 'family', 'e2e-change-password-1'],
        ['e2e-chat', 'Собеседник', 'family', 'e2e-chat-password-1'],
        // Two more people who only call each other: calls and chat tests run in parallel and must not share accounts.
        ['e2e-caller', 'Звонящий', 'family', 'e2e-caller-password-1'],
        ['e2e-callee', 'Отвечающий', 'family', 'e2e-callee-password-1'],
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

// The screenshot server shows a backup that really ran (into its own temp folder), like the family's server does.
if (mode === 'guide') {
  mkdirSync(env.JELLYFIN_DATA_DIR, { recursive: true });
  // A backup folder may not lie inside the data folder (a rule of the portal): a sibling temp folder.
  env.BACKUP_TARGETS = guideBackups;
  for (const command of ['run', 'test-restore']) {
    const r = spawnSync(process.execPath, ['server/src/cli/backup.ts', command], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (r.status !== 0)
      console.error(`guide: backup ${command} did not finish cleanly (${r.status}):`, r.stdout, r.stderr);
  }
}

// The screenshot server runs under a real supervisor of its own (own data folder, own pipe), as the family's
// server does: the monitoring page then shows the programs honestly. Jellyfin, the torrent client and the
// language model of this PC are never started by it.
const supervised = mode === 'guide';
if (supervised) {
  env.SUPERVISE_JELLYFIN = '0';
  env.SUPERVISE_ARIA2 = '0';
  env.SUPERVISE_LLAMA = '0';
}
const server = spawn(
  process.execPath,
  [supervised ? 'server/src/supervisor/main.ts' : 'server/src/index.ts'],
  {
    cwd: root,
    env,
    stdio: 'inherit',
  },
);

const cleanup = () => {
  if (supervised) {
    // Ask the supervisor to stop its dashboard first: killing only the supervisor would leave the portal running.
    spawnSync(process.execPath, ['server/src/supervisor/main.ts', 'shutdown'], {
      cwd: root,
      env,
      timeout: 30_000,
    });
  }
  if (server.exitCode === null) server.kill();
  try {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(guideBackups, { recursive: true, force: true });
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
