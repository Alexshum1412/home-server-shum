import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test.describe.configure({ mode: 'serial' });

test.describe('accounts from the portal', () => {
  test('an administrator adds a person, hands out the one-time password and removes the account', async ({
    page,
    browser,
  }) => {
    await signIn(page, 'admin', '/admin');
    await page.getByText('Добавить человека', { exact: true }).click();
    await page.locator('form.user-form').getByLabel('Логин').fill('e2e-new');
    await page.locator('form.user-form').getByLabel('Имя для приветствия').fill('Бабушка');
    await page.locator('form.user-form').getByLabel('Печать').check();
    await page.getByRole('button', { name: 'Создать и выдать временный пароль' }).click();

    const secret = page.getByRole('region', { name: /Временный пароль для «Бабушка»/ });
    await expect(secret).toBeVisible();
    const password = (await secret.locator('code').first().textContent())?.trim() ?? '';
    expect(password).toMatch(/^[A-Za-z2-9]{5}(-[A-Za-z2-9]{5}){3}$/);
    await expect(secret.getByText('один раз')).toBeVisible();

    // The new person signs in with it once and must choose an own password.
    const newcomer = await browser.newContext();
    const newcomerPage = await newcomer.newPage();
    const login = await newcomerPage.request.post('/api/login', { data: { username: 'e2e-new', password } });
    expect(login.status()).toBe(200);
    expect((await login.json()).mustChangePassword).toBe(true);
    await newcomer.close();

    await secret.getByRole('button', { name: 'Готово, скрыть пароль' }).click();
    await expect(secret).toBeHidden();
    await expect(page.getByText(password)).toHaveCount(0);

    // The audit journal says who did what, without the password.
    await page.reload();
    await expect(page.getByRole('cell', { name: 'Создан пользователь' }).first()).toBeVisible();
    await expect(page.getByText(password)).toHaveCount(0);

    // Remove: needs the confirmation dialog; the files stay (the dialog says so).
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('они переносятся в корзину на сервере');
      await dialog.accept();
    });
    const usersTable = page.locator('table', { hasText: 'Последний вход' });
    const row = usersTable.locator('tr', { hasText: 'e2e-new' });
    await row.locator('summary').click();
    await row.getByRole('button', { name: 'Удалить' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'удалён' })).toBeVisible();
    await expect(usersTable.locator('tr', { hasText: 'e2e-new' })).toHaveCount(0);
  });

  test('the administrator cannot remove themselves and a family member does not see the user list', async ({
    page,
  }) => {
    await signIn(page, 'admin', '/admin');
    const row = page.locator('table', { hasText: 'Последний вход' }).locator('tr', { hasText: 'e2e-admin' });
    await row.locator('summary').click();
    await expect(row.getByText('Это вы')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Удалить' })).toHaveCount(0);

    await signIn(page, 'family', '/admin');
    await expect(page.getByText('Раздел доступен только администраторам')).toBeVisible();
    expect((await page.request.get('/api/admin/users')).status()).toBe(403);
  });
});

test.describe('folders in the address', () => {
  test('opening a folder puts it in the address, Back goes up one level, and an old list never stays under a new heading', async ({
    page,
  }) => {
    await signIn(page, 'family', '/files');
    page.once('dialog', (d) => d.accept('Школа'));
    await page.getByRole('button', { name: 'Новая папка' }).click();
    await expect(page.locator('.files__item').filter({ hasText: 'Школа' })).toBeVisible();
    await page.getByLabel('Загрузить файлы').setInputFiles({
      name: 'в-корне.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('корень'),
    });
    await expect(page.locator('.files__item').filter({ hasText: 'в-корне.txt' })).toBeVisible();

    // Slow answers for the new folder: the root list must not be shown under the heading «Школа».
    await page.route('**/api/storage/files/list**', async (route) => {
      if (route.request().url().includes('path=%D0%A8')) await new Promise((r) => setTimeout(r, 1200));
      await route.continue();
    });
    await page.locator('.files__item').filter({ hasText: 'Школа' }).getByRole('button').first().click();
    await expect(page).toHaveURL(/\/files\?path=/);
    await expect(page.getByRole('heading', { level: 2, name: 'Школа' })).toBeVisible();
    await expect(page.locator('.files__item').filter({ hasText: 'в-корне.txt' })).toHaveCount(0);
    await expect(page.getByText('Здесь пока пусто')).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/files$/);
    await expect(page.locator('.files__item').filter({ hasText: 'в-корне.txt' })).toBeVisible();
  });

  test('a folder that cannot be opened shows the problem, not the previous folder', async ({ page }) => {
    await signIn(page, 'family', '/files');
    await expect(page.locator('.files__item').filter({ hasText: 'Школа' })).toBeVisible();
    await page.route('**/api/storage/files/list**', (route) =>
      route.request().url().includes('path=') ? route.abort('connectionrefused') : route.continue(),
    );
    await page.locator('.files__item').filter({ hasText: 'Школа' }).getByRole('button').first().click();
    await expect(page.getByText('Нет связи с домашним сервером')).toBeVisible();
    await expect(page.locator('.files__item').filter({ hasText: 'в-корне.txt' })).toHaveCount(0);
  });
});

test.describe('media fallback', () => {
  test('the cinema page can play library files without Jellyfin, remembers the audiobook position and says honestly when a file cannot be played', async ({
    page,
  }) => {
    await signIn(page, 'family', '/cinema');
    const fallback = page.locator('details.fallback');
    await expect(fallback).toBeVisible();
    // Jellyfin is not installed in the test server: the fallback is open at once.
    await expect(fallback).toHaveAttribute('open', '');
    await fallback.getByRole('button', { name: 'Аудиокниги' }).click();
    await expect(page).toHaveURL(/media=/);
    await fallback.getByRole('button', { name: 'Тестовая книга' }).click();
    await fallback.getByRole('button', { name: /Глава 01\.wav/ }).click();
    const player = page.getByRole('dialog', { name: 'Глава 01.wav' });
    await expect(player).toBeVisible();
    await expect(player.locator('audio')).toBeVisible();
    await expect
      .poll(() => player.locator('audio').evaluate((el) => (el as HTMLAudioElement).readyState))
      .toBeGreaterThan(0);
    await player.getByRole('button', { name: 'Закрыть' }).click();

    await fallback.getByRole('button', { name: 'Медиатека' }).click();
    await fallback.getByRole('button', { name: 'Фильмы' }).click();
    await fallback.getByRole('button', { name: /сломанный\.mp4/ }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'не смог воспроизвести' })).toBeVisible();
  });

  test('files are served with Range requests only to signed-in users, never outside the library', async ({
    page,
    request,
  }) => {
    const path = encodeURIComponent('Аудиокниги/Тестовая книга/Глава 01.wav');
    expect((await request.get(`/api/media/file?path=${path}`)).status()).toBe(401);
    await signIn(page, 'family', '/');
    const part = await page.request.get(`/api/media/file?path=${path}`, { headers: { range: 'bytes=0-9' } });
    expect(part.status()).toBe(206);
    expect(part.headers()['content-range']).toMatch(/^bytes 0-9\//);
    expect(
      (await page.request.get(`/api/media/file?path=${encodeURIComponent('../start-server.mjs')}`)).status(),
    ).toBe(400);
  });
});
