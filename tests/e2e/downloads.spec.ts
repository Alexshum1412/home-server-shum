import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test.describe('downloads', () => {
  test('a family member without the right sees how to get it, and the API refuses', async ({ page }) => {
    await signIn(page, 'family', '/downloads');
    await expect(page.getByRole('heading', { level: 1, name: 'Загрузки' })).toBeVisible();
    await expect(page.getByText('Загрузки доступны по разрешению администратора')).toBeVisible();
    await expect(page.getByLabel('Прямая ссылка на файл')).toHaveCount(0);
    const res = await page.request.post('/api/downloads/check', {
      data: { url: 'https://example.com/a.pdf' },
    });
    expect(res.status()).toBe(403);
  });

  test('the admin gets a clear refusal for links into the home network and wrong schemes', async ({
    page,
  }) => {
    await signIn(page, 'admin', '/downloads');
    const field = page.getByLabel('Прямая ссылка на файл');
    await field.fill('http://127.0.0.1:8071/api/health');
    await page.getByRole('button', { name: 'Проверить ссылку' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'внутрь домашней сети' })).toBeVisible();

    await field.fill('ftp://example.com/file.iso');
    await page.getByRole('button', { name: 'Проверить ссылку' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'только ссылки http' })).toBeVisible();
    await expect(page.getByText('Скачать этот файл?')).toHaveCount(0);
  });
});
