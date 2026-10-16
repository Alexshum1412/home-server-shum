import { expect, test } from '@playwright/test';
import { E2E_USERS } from './fixtures.ts';
import { signIn } from './helpers.ts';

test.describe('sign-in', () => {
  test('anonymous visitor sees the login form with labelled fields', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByLabel('Имя пользователя')).toBeVisible();
    await expect(page.getByLabel('Пароль', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible();
  });

  test('wrong password shows a generic error', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Имя пользователя').fill(E2E_USERS.family.username);
    await page.getByLabel('Пароль', { exact: true }).fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(page.getByRole('alert')).toContainText('Неверное имя пользователя или пароль');
  });

  test('family member signs in through the form, is greeted, and can sign out', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Имя пользователя').fill(E2E_USERS.family.username);
    await page.getByLabel('Пароль', { exact: true }).fill(E2E_USERS.family.password);
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(E2E_USERS.family.displayName);

    // "Выйти" is either in the sidebar (wide) or behind the "Ещё" menu (narrow).
    const more = page.getByRole('button', { name: 'Ещё' });
    if (await more.isVisible()) await more.click();
    await page.getByRole('button', { name: 'Выйти' }).click();
    await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible();

    const session = await page.request.get('/api/session');
    expect(session.status()).toBe(401);
  });

  test('API rejects anonymous and cross-origin requests', async ({ request }) => {
    expect((await request.get('/api/services')).status()).toBe(401);
    expect((await request.get('/api/system')).status()).toBe(401);
    const foreign = await request.post('/api/login', {
      headers: { Origin: 'https://evil.example' },
      data: { username: 'x', password: 'y' },
    });
    expect(foreign.status()).toBe(403);
  });

  test('family member cannot use admin APIs or see the admin section', async ({ page }) => {
    await signIn(page, 'family', '/admin');
    await expect(page.getByText('Раздел доступен только администраторам')).toBeVisible();
    expect((await page.request.get('/api/admin/audit')).status()).toBe(403);
    expect((await page.request.get('/api/admin/diagnostics')).status()).toBe(403);
    await expect(page.getByRole('link', { name: 'Администрирование' })).toHaveCount(0);
  });

  test('admin sees the audit log with recent sign-ins', async ({ page }) => {
    await signIn(page, 'admin', '/admin');
    await expect(page.getByRole('heading', { level: 1, name: 'Администрирование' })).toBeVisible();
    const audit = await page.request.get('/api/admin/audit?limit=20');
    expect(audit.status()).toBe(200);
    const body = await audit.json();
    expect(body.entries.some((e: { action: string }) => e.action === 'login.success')).toBe(true);
    expect(JSON.stringify(body)).not.toContain(E2E_USERS.admin.password);
  });
});
