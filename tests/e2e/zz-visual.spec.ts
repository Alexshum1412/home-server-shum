import { test } from '@playwright/test';
import { signIn } from './helpers.ts';

const OUT = 'C:/Users/PC/AppData/Local/Temp/claude/C--/e1ff23e8-997a-47ac-8eee-0220fded2b6b/scratchpad/shots';
test('visual tour', async ({ page }) => {
  test.setTimeout(120_000);
  for (const [name, width, height] of [
    ['d', 1280, 800],
    ['m', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await signIn(page, 'admin', '/');
    for (const path of ['/', '/tasks', '/notes', '/cinema', '/status', '/system', '/account', '/digest']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await page.screenshot({
        path: OUT + '/' + name + path.replace(/\//g, '_') + '.png',
        fullPage: path === '/',
      });
    }
  }
});
