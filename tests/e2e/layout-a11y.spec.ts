import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { VIEWPORTS } from './fixtures.ts';
import { expectNoHorizontalOverflow, mainNav, signIn } from './helpers.ts';

const PAGES = ['/', '/cinema', '/photos', '/files', '/downloads', '/print', '/system', '/help', '/admin'];

test.describe('responsive layout', () => {
  for (const width of VIEWPORTS) {
    test(`no horizontal overflow and reachable navigation at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
      await signIn(page, 'admin');
      for (const path of PAGES) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expectNoHorizontalOverflow(page);
      }
      await page.goto('/');
      await expect(mainNav(page)).toBeVisible();
      await expect(mainNav(page).getByRole('link', { name: 'Главная' })).toBeVisible();
      if (width === 390 || width === 1440) {
        await page.screenshot({ path: `artifacts/ui-review/home-${width}.png`, fullPage: true });
        await page.goto('/system');
        await page.screenshot({ path: `artifacts/ui-review/system-${width}.png`, fullPage: true });
      }
    });
  }

  test('login page has no overflow on a narrow phone', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/login');
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: 'artifacts/ui-review/login-375.png' });
  });
});

test.describe('accessibility', () => {
  test('login page has no serious or critical axe violations', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible();
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(bad.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
  });

  for (const path of ['/', '/system', '/help', '/admin', '/photos']) {
    test(`${path} has no serious or critical axe violations`, async ({ page }) => {
      await signIn(page, 'admin', path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      // Let the first data load settle so the scan sees real content, not skeletons.
      await page.waitForLoadState('networkidle');
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(bad.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
    });
  }

  test('first Tab focuses the skip link, which is visible', async ({ page }) => {
    await signIn(page, 'family');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Перейти к содержимому' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
  });
});

test.describe('shell, headers and PWA', () => {
  test('security headers are present on the app shell and API', async ({ request }) => {
    const shell = await request.get('/');
    expect(shell.status()).toBe(200);
    const csp = shell.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(shell.headers()['x-content-type-options']).toBe('nosniff');
    const api = await request.get('/api/health');
    expect(api.headers()['cache-control']).toContain('no-store');
  });

  test('deep link returns the app shell and unknown API paths return JSON 404', async ({ request }) => {
    const deep = await request.get('/system');
    expect(deep.status()).toBe(200);
    expect(deep.headers()['content-type']).toContain('text/html');
    const missing = await request.get('/api/does-not-exist');
    expect(missing.status()).toBe(404);
    expect((await missing.json()).error).toBeTruthy();
  });

  test('manifest and service worker are served', async ({ request }) => {
    const manifest = await request.get('/manifest.webmanifest');
    expect(manifest.status()).toBe(200);
    const m = JSON.parse(await manifest.text());
    expect(m.name).toBe('Семейный сервер');
    expect(m.icons.length).toBeGreaterThanOrEqual(2);
    expect((await request.get('/sw.js')).status()).toBe(200);
  });

  test('the app makes no requests to third-party hosts', async ({ page }) => {
    const external: string[] = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (!['127.0.0.1', 'localhost'].includes(url.hostname) && url.protocol.startsWith('http'))
        external.push(req.url());
    });
    await signIn(page, 'admin');
    await page.waitForLoadState('networkidle');
    await page.goto('/system');
    await page.waitForLoadState('networkidle');
    expect(external).toEqual([]);
  });
});
