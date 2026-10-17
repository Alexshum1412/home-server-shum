import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

// The isolated test server has no printer configured (PRINTER_IPP_URL is empty): the page says so
// plainly and the API refuses uploads instead of pretending to print.
test('without a configured printer the page says so and nothing can be sent', async ({ page }) => {
  await signIn(page, 'admin', '/print');
  await expect(page.getByRole('heading', { level: 1, name: 'Печать' })).toBeVisible();
  await expect(page.getByText('Печать через портал не настроена на домашнем компьютере.')).toBeVisible();
  const res = await page.request.put('/api/print/jobs?name=a.pdf&size=8', {
    headers: { 'content-type': 'application/octet-stream', 'x-upload': '1' },
    data: Buffer.from('%PDF-1.4'),
  });
  expect(res.status()).toBe(503);
});

test('a family member without the print right is told how to get it', async ({ page }) => {
  await signIn(page, 'family', '/print');
  await expect(page.getByText('Печать через портал доступна по разрешению администратора.')).toBeVisible();
  const res = await page.request.put('/api/print/jobs?name=a.pdf&size=8', {
    headers: { 'content-type': 'application/octet-stream', 'x-upload': '1' },
    data: Buffer.from('%PDF-1.4'),
  });
  expect(res.status()).toBe(403);
});
