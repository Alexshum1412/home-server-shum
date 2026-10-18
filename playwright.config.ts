import { defineConfig, devices } from '@playwright/test';

// Uses the installed Google Chrome (channel 'chrome'): no browser downloads.
// Two isolated servers with throwaway data dirs: real mode (8071) and demo mode (8072).
// They run on the same node.exe as Playwright itself: a `node` found on PATH may be another,
// stale copy (seen on this PC: an old AppData copy that crashed with an access violation).
const NODE = `"${process.execPath}"`;

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
    locale: 'ru-RU',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'real',
      testIgnore: /(demo|chat|calls|cinema)\.spec\.ts/,
      use: { baseURL: 'http://127.0.0.1:8071' },
    },
    // Chat and calls run one after the other, after everything else: both hold several browser
    // windows at once, and two such files side by side crashed the test runner now and then.
    {
      name: 'chat',
      testMatch: /chat\.spec\.ts/,
      dependencies: ['real'],
      use: { baseURL: 'http://127.0.0.1:8071' },
    },
    {
      name: 'calls',
      testMatch: /calls\.spec\.ts/,
      dependencies: ['chat'],
      use: { baseURL: 'http://127.0.0.1:8071' },
    },
    { name: 'demo', testMatch: /demo\.spec\.ts/, use: { baseURL: 'http://127.0.0.1:8072' } },
    { name: 'cinema', testMatch: /cinema\.spec\.ts/, use: { baseURL: 'http://127.0.0.1:8073' } },
  ],
  webServer: [
    {
      command: `${NODE} tests/e2e/start-server.mjs real 8071`,
      url: 'http://127.0.0.1:8071/api/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `${NODE} tests/e2e/start-server.mjs demo 8072`,
      url: 'http://127.0.0.1:8072/api/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `${NODE} tests/e2e/start-server.mjs cinema 8073`,
      url: 'http://127.0.0.1:8073/api/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
