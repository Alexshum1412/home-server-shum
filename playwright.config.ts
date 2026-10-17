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
  retries: 0,
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
    { name: 'real', testIgnore: /demo\.spec\.ts/, use: { baseURL: 'http://127.0.0.1:8071' } },
    { name: 'demo', testMatch: /demo\.spec\.ts/, use: { baseURL: 'http://127.0.0.1:8072' } },
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
  ],
});
