import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test('the admin sees «Оливия» with plain-language findings; family members cannot reach it', async ({
  page,
}) => {
  await signIn(page, 'admin', '/admin');
  const section = page.getByRole('region', { name: 'Оливия — помощник администратора' });
  await expect(section).toBeVisible();
  // The isolated test server has no supervisor and no backups yet: both are reported honestly.
  await expect(section.getByRole('heading', { name: 'Супервизор не работает' })).toBeVisible();
  await expect(section.getByRole('heading', { name: 'Резервное копирование не настроено' })).toBeVisible();
  const api = await page.request.get('/api/admin/olivia');
  expect(api.status()).toBe(200);
  // Actions need an explicit confirmation flag.
  const unconfirmed = await page.request.post('/api/admin/olivia/actions/recheck-services', { data: {} });
  expect(unconfirmed.status()).toBe(400);
});

test('family member: «Оливия» API is closed', async ({ page }) => {
  await signIn(page, 'family', '/');
  expect((await page.request.get('/api/admin/olivia')).status()).toBe(403);
});
