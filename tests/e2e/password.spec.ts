import { expect, test } from '@playwright/test';
import { E2E_USERS } from './fixtures.ts';
import { mainNav } from './helpers.ts';

// Each test uses its own seeded account and changes its password once, so the file runs serially.
test.describe.configure({ mode: 'serial' });

async function signInWithForm(page: import('@playwright/test').Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Имя пользователя').fill(username);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
}

test('a temporary password must be replaced before the portal opens', async ({ page }) => {
  const user = E2E_USERS.temporary;
  await signInWithForm(page, user.username, user.password);
  await expect(page.getByRole('heading', { level: 1, name: 'Придумайте свой пароль' })).toBeVisible();
  await expect(mainNav(page)).toHaveCount(0);
  // The API refuses everything else meanwhile.
  const blocked = await page.request.get('/api/services');
  expect(blocked.status()).toBe(403);

  await page.getByLabel('Временный пароль').fill(user.password);
  await page.getByLabel('Новый пароль', { exact: true }).fill('короткий');
  await page.getByLabel('Новый пароль ещё раз').fill('короткий');
  await page.getByRole('button', { name: 'Сохранить и открыть портал' }).click();
  await expect(page.getByRole('alert')).toContainText('слишком короткий');

  const own = 'свой-пароль-новичка-2026';
  await page.getByLabel('Новый пароль', { exact: true }).fill(own);
  await page.getByLabel('Новый пароль ещё раз').fill(own);
  await page.getByRole('button', { name: 'Сохранить и открыть портал' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(user.displayName);
  await expect(mainNav(page).first()).toBeVisible();
  expect((await page.request.get('/api/services')).status()).toBe(200);

  // The temporary password no longer works; the own one does.
  const old = await page.request.post('/api/login', {
    data: { username: user.username, password: user.password },
  });
  expect(old.status()).toBe(401);
  const fresh = await page.request.post('/api/login', { data: { username: user.username, password: own } });
  expect(fresh.status()).toBe(200);
});

test('a family member changes the own password in «Мой профиль»', async ({ page, browser }) => {
  const user = E2E_USERS.changer;
  // A second device signed in before the change must be signed out by it.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  const otherLogin = await otherPage.request.post('/api/login', {
    data: { username: user.username, password: user.password },
  });
  expect(otherLogin.status()).toBe(200);

  await signInWithForm(page, user.username, user.password);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(user.displayName);
  await page.goto('/account');
  await expect(page.getByRole('heading', { level: 1, name: 'Мой профиль' })).toBeVisible();

  await page.getByLabel('Текущий пароль').fill('неверный-пароль-123');
  const next = 'новый-пароль-меняющего-1';
  await page.getByLabel('Новый пароль', { exact: true }).fill(next);
  await page.getByLabel('Новый пароль ещё раз').fill(next);
  await page.getByRole('button', { name: 'Сменить пароль' }).click();
  await expect(page.getByRole('alert')).toContainText('Текущий пароль указан неверно');

  await page.getByLabel('Текущий пароль').fill(user.password);
  await page.getByLabel('Новый пароль', { exact: true }).fill(next);
  await page.getByLabel('Новый пароль ещё раз').fill(next);
  await page.getByRole('button', { name: 'Сменить пароль' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Пароль изменён' })).toBeVisible();

  // This device stays signed in, the other one is signed out.
  expect((await page.request.get('/api/session')).status()).toBe(200);
  expect((await otherPage.request.get('/api/session')).status()).toBe(401);
  await other.close();
});
