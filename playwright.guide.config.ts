import { defineConfig, devices } from '@playwright/test';

// Takes the pictures of docs/FAMILY_USER_GUIDE.md (docs/images/family-guide/) on a throwaway test server:
// invented people, films, files and messages; the monitoring page shows this PC's real readings.
// Run it with `npm.cmd run guide:screenshots` (the UI must be built: `npm.cmd run build`).
const NODE = `"${process.execPath}"`;

export default defineConfig({
  testDir: 'tests/guide',
  outputDir: 'test-results/guide',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    channel: 'chrome',
    locale: 'ru-RU',
    viewport: { width: 1280, height: 800 },
    baseURL: 'http://127.0.0.1:8074',
    launchOptions: {
      args: [
        // A test camera and microphone, so the call screen shows moving pictures.
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
      ],
    },
  },
  webServer: {
    command: `${NODE} tests/e2e/start-server.mjs guide 8074`,
    url: 'http://127.0.0.1:8074/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
