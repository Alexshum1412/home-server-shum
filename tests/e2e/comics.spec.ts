import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test.describe.configure({ mode: 'serial' });

test.describe('the comics reader', () => {
  test('is switched off until the administrator switches it on; then a .cbz is read page by page', async ({
    page,
  }) => {
    await signIn(page, 'admin', '/comics');
    await expect(page.getByText('Администратор отключил эту функцию')).toBeVisible();
    expect(
      (await page.request.post('/api/admin/features', { data: { id: 'comics', enabled: true } })).ok(),
    ).toBe(true);
    try {
      await page.goto('/comics');
      await expect(page.getByRole('heading', { level: 1, name: /Комиксы/ })).toBeVisible();
      await page.getByRole('button', { name: /Тестовый том/ }).click();
      const reader = page.getByRole('dialog', { name: /Чтение: Тестовый том/ });
      await expect(reader).toBeVisible();
      const picture = reader.getByRole('img', { name: 'Страница 1 из 2' });
      await expect(picture).toBeVisible();
      await expect
        .poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth))
        .toBeGreaterThan(0);
      await reader.getByRole('button', { name: 'Следующая страница' }).click();
      await expect(reader.getByRole('img', { name: 'Страница 2 из 2' })).toBeVisible();
      await expect(reader.getByRole('button', { name: 'Следующая страница' })).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(reader).toHaveCount(0);
      // the place is remembered on this device
      await expect(page.getByText(/стр\. 2/)).toBeVisible();
    } finally {
      await page.request.post('/api/admin/features', { data: { id: 'comics', enabled: false } });
    }
  });

  test('a file outside the comics folder cannot be asked for', async ({ page }) => {
    await signIn(page, 'admin', '/');
    await page.request.post('/api/admin/features', { data: { id: 'comics', enabled: true } });
    try {
      const outside = Buffer.from('..\\..\\secret.cbz').toString('base64url');
      expect((await page.request.get(`/api/comics/${outside}/pages`)).status()).toBe(404);
    } finally {
      await page.request.post('/api/admin/features', { data: { id: 'comics', enabled: false } });
    }
  });
});
