import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';
import type { E2EUserKey } from './fixtures.ts';
import { expectNoHorizontalOverflow, mainNav, signIn } from './helpers.ts';

const PHOTO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture-photo.jpg');

async function person(
  browser: Browser,
  who: E2EUserKey,
  to: string,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, who, to);
  return { page, close: () => context.close() };
}

/** The open conversation (not the list, whose previews repeat the same words). */
const thread = (page: Page) => page.getByRole('region', { name: /^Чат: / });

const composer = (page: Page) => page.getByRole('textbox', { name: 'Сообщение', exact: true });
const send = async (page: Page, text: string) => {
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Отправить' }).click();
};

test.describe('family chat', () => {
  test('a message reaches another person at once, with an unread badge, and reading clears it', async ({
    browser,
  }) => {
    const mama = await person(browser, 'family', '/files');
    const sasha = await person(browser, 'chatter', '/chat?c=family');
    try {
      await expect(sasha.page.getByRole('heading', { level: 2, name: 'Вся семья' })).toBeVisible();
      const text = `Привет всем, ужин готов ${Date.now()}`;
      await send(sasha.page, text);
      await expect(thread(sasha.page).getByText(text)).toBeVisible();

      // Mama is on another page and has not reloaded anything: the badge appears by itself.
      const chatLink = mainNav(mama.page).getByRole('link', { name: /Чат/ });
      await expect(chatLink).toContainText('новых');
      await expect.poll(() => mama.page.title()).toMatch(/^\(\d+\) /);

      await chatLink.click();
      await expect(thread(mama.page).getByText(text)).toBeVisible();
      // The room is read now (other tests may leave unread lines in other chats at the same time).
      await expect(mama.page.getByRole('link', { name: /Вся семья/ })).not.toContainText('непрочитанных');

      // The sender sees that it was read.
      await expect(sasha.page.getByText(/Прочитали: [1-9]\d* из/)).toBeVisible();
    } finally {
      await mama.close();
      await sasha.close();
    }
  });

  test('a direct chat with a photo and a file: the other person sees both, and nobody else can open them', async ({
    browser,
    request,
  }) => {
    const mama = await person(browser, 'family', '/chat');
    const sasha = await person(browser, 'chatter', '/chat');
    try {
      await mama.page.getByRole('button', { name: 'Новый чат' }).click();
      const dialog = mama.page.getByRole('dialog', { name: 'Новый чат' });
      await dialog.getByRole('button', { name: 'Собеседник' }).click();
      await expect(mama.page.getByRole('heading', { level: 2, name: 'Собеседник' })).toBeVisible();

      await mama.page.locator('input[type="file"]').setInputFiles(PHOTO);
      const photo = mama.page.locator('img.msg__image');
      await expect(photo).toBeVisible();
      await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

      await mama.page.locator('input[type="file"]').setInputFiles({
        name: 'список покупок.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('молоко\nхлеб\n'),
      });
      await expect(thread(mama.page).getByRole('link', { name: /список покупок\.txt/ })).toBeVisible();

      // Sasha opens the same chat and sees the photo, loaded.
      await sasha.page.reload();
      await sasha.page.getByRole('link', { name: /Тестовая семья/ }).click();
      const seen = sasha.page.locator('img.msg__image');
      await expect(seen).toBeVisible();
      await expect.poll(() => seen.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

      // An administrator outside the chat gets «not found» for the very same address.
      const src = await seen.getAttribute('src');
      expect(src).toContain('/api/chat/conversations/');
      const adminLogin = await request.post('/api/login', {
        data: { username: 'e2e-admin', password: 'e2e-admin-password-1' },
      });
      expect(adminLogin.status()).toBe(200);
      const denied = await request.get((src as string).replace(/\?inline=1$/, ''));
      expect(denied.status()).toBe(404);
    } finally {
      await mama.close();
      await sasha.close();
    }
  });

  test('a group: created from the dialog, seen by its members only, renamed and left', async ({
    browser,
  }) => {
    const mama = await person(browser, 'family', '/chat');
    const sasha = await person(browser, 'chatter', '/chat');
    const papa = await person(browser, 'admin', '/chat');
    try {
      const title = `Дача ${Date.now()}`;
      await mama.page.getByRole('button', { name: 'Новый чат' }).click();
      const dialog = mama.page.getByRole('dialog', { name: 'Новый чат' });
      await dialog.getByRole('button', { name: 'Группа' }).click();
      await dialog.getByLabel('Название группы').fill(title);
      await dialog.getByLabel('Собеседник').check();
      await dialog.getByRole('button', { name: 'Создать группу' }).click();
      await expect(mama.page.getByRole('heading', { level: 2, name: title })).toBeVisible();
      await send(mama.page, 'Выезжаем в субботу');

      // Members get it live; the administrator does not see the group at all.
      await expect(sasha.page.getByRole('link', { name: new RegExp(title) })).toBeVisible();
      await sasha.page.getByRole('link', { name: new RegExp(title) }).click();
      await expect(thread(sasha.page).getByText('Выезжаем в субботу')).toBeVisible();
      await papa.page.reload();
      await expect(papa.page.getByRole('link', { name: new RegExp(title) })).toHaveCount(0);

      // The creator renames it; the member cannot manage it.
      await mama.page.getByRole('button', { name: 'Группа', exact: true }).click();
      const manage = mama.page.getByRole('dialog', { name: 'Группа' });
      await manage.getByLabel('Название').fill(`${title} (лето)`);
      await manage.getByRole('button', { name: 'Сохранить' }).click();
      await expect(mama.page.getByRole('heading', { level: 2, name: `${title} (лето)` })).toBeVisible();
      await manage.getByRole('button', { name: 'Закрыть' }).click();

      await sasha.page.getByRole('button', { name: 'Группа', exact: true }).click();
      const info = sasha.page.getByRole('dialog', { name: 'Группа' });
      await expect(info.getByLabel('Название')).toHaveCount(0);
      sasha.page.once('dialog', (d) => void d.accept());
      await info.getByRole('button', { name: 'Выйти из группы' }).click();
      await expect(sasha.page.getByRole('link', { name: new RegExp(title) })).toHaveCount(0);
    } finally {
      await mama.close();
      await sasha.close();
      await papa.close();
    }
  });

  test('a message that cannot be sent is kept with «Повторить»', async ({ page }) => {
    await signIn(page, 'family', '/chat?c=family');
    await expect(composer(page)).toBeVisible();
    let blocked = true;
    await page.route('**/api/chat/conversations/family/messages', (route) =>
      blocked && route.request().method() === 'POST' ? route.abort('failed') : route.continue(),
    );
    const text = `Не уйдёт сразу ${Date.now()}`;
    await send(page, text);
    await expect(page.getByText('Нет связи с домашним сервером. Сообщение не отправлено.')).toBeVisible();
    await expect(thread(page).getByText(text)).toBeVisible();
    blocked = false;
    await page.getByRole('button', { name: 'Повторить' }).click();
    await expect(page.getByText('Отправляется…')).toHaveCount(0);
    await expect(thread(page).getByText(text)).toHaveCount(1);
  });
});

test.describe('chat on a phone', () => {
  test('list → conversation → back, no overflow, no serious accessibility problems', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'family', '/chat');
    await expect(page.getByRole('heading', { level: 1, name: 'Чат' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const scan = async () => {
      await page.waitForLoadState('networkidle');
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(
        bad.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(' | ')})`),
      ).toEqual([]);
    };
    await scan();
    await page.getByRole('link', { name: /Вся семья/ }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Вся семья' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Вся семья/ })).toBeHidden();
    await expectNoHorizontalOverflow(page);
    await scan();
    await page.getByRole('button', { name: 'К списку чатов' }).click();
    await expect(page.getByRole('link', { name: /Вся семья/ })).toBeVisible();
    await page.screenshot({ path: 'artifacts/ui-review/chat-390.png' });
  });

  test('the notification page opens and keeps the choices', async ({ page }) => {
    await signIn(page, 'family', '/notifications');
    await expect(page.getByRole('heading', { level: 1, name: 'Уведомления' })).toBeVisible();
    const previews = page.getByLabel('Показывать текст сообщений');
    await expect(previews).not.toBeChecked();
    await previews.check();
    await page.reload();
    await expect(page.getByLabel('Показывать текст сообщений')).toBeChecked();
    await page.getByLabel('Показывать текст сообщений').uncheck();
    await expect(page.getByRole('heading', { level: 2, name: 'Это устройство' })).toBeVisible();
  });
});
