import { defineConfig, devices } from '@playwright/test';

// Uses the installed Google Chrome (channel 'chrome'): no browser downloads.
// Three isolated servers with throwaway data dirs: real mode (8071), demo mode (8072) and cinema mode (8073,
// with a stand-in for Jellyfin on 8097 and for the torrent client on 8098).
// E2E_PORT_OFFSET moves all of them (for example by 100) so that two test runs, such as the checkouts of
// parallel workers, never fight over the same ports.
// They run on the same node.exe as Playwright itself: a `node` found on PATH may be another,
// stale copy (seen on this PC: an old AppData copy that crashed with an access violation).
const NODE = `"${process.execPath}"`;
const OFFSET = Number(process.env.E2E_PORT_OFFSET ?? 0);
const PORT = { real: 8071 + OFFSET, demo: 8072 + OFFSET, cinema: 8073 + OFFSET };
const url = (port: number) => `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 2,
  // A runner crash on this PC (the Windows antivirus engine and the memory service crash now and then) must not
  // fail a test that is fine; a test that only passes on retry is listed as «flaky».
  retries: 1,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    ...devices['Desktop Chrome'],
    channel: 'chrome',
    // Headless Chrome on this PC sometimes never opens a page while its graphics process starts (seen on
    // 19.10.2026 after a Chrome update: «setting up "page"» timed out); the tests need no graphics card.
    launchOptions: { args: ['--disable-gpu'] },
    locale: 'ru-RU',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'real',
      testIgnore: /(demo|chat|calls|cinema|torrents|olivia-assistant)\.spec\.ts/,
      use: { baseURL: url(PORT.real) },
    },
    // Chat and calls run one after the other, after everything else: both hold several browser
    // windows at once, and two such files side by side crashed the test runner now and then.
    {
      name: 'chat',
      testMatch: /chat\.spec\.ts/,
      dependencies: ['real'],
      use: { baseURL: url(PORT.real) },
    },
    {
      name: 'calls',
      testMatch: /calls\.spec\.ts/,
      dependencies: ['chat'],
      use: { baseURL: url(PORT.real) },
    },
    { name: 'demo', testMatch: /demo\.spec\.ts/, use: { baseURL: url(PORT.demo) } },
    {
      name: 'cinema',
      testMatch: /(cinema|torrents|olivia-assistant)\.spec\.ts/,
      use: { baseURL: url(PORT.cinema) },
    },
  ],
  webServer: [
    {
      command: `${NODE} tests/e2e/start-server.mjs real ${PORT.real}`,
      url: `${url(PORT.real)}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `${NODE} tests/e2e/start-server.mjs demo ${PORT.demo}`,
      url: `${url(PORT.demo)}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `${NODE} tests/e2e/start-server.mjs cinema ${PORT.cinema}`,
      url: `${url(PORT.cinema)}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
