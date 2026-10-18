import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, signIn } from './helpers.ts';

test.describe.configure({ mode: 'serial' });

const NOTE = 'Список для дачи';
const SECRET_NOTE = 'Личная заметка про дачу';
const EVENT = 'Поездка на дачу';

test.describe('unified search (Ctrl+K)', () => {
  test('finds notes and events from any page, opens the result, and keeps private things private', async ({
    page,
    browser,
  }) => {
    await signIn(page, 'family', '/files');
    const save = (space: string, name: string, text: string) =>
      page.request.post('/api/notes/save', { data: { space, name, text, revision: null } });
    // A retry of this test meets the notes of the first run (409 «уже есть»): that is fine.
    expect([200, 409]).toContain((await save('shared', NOTE, 'взять рассаду и лопату')).status());
    expect([200, 409]).toContain((await save('personal', SECRET_NOTE, 'подарок на день рождения')).status());
    const event = await page.request.post('/api/calendar', {
      data: { title: EVENT, date: '2026-12-20', time: '09:00' },
    });
    expect(event.status()).toBe(201);

    // Ctrl+K from the files page.
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Файлы' })).toBeVisible();
    await page.keyboard.press('Control+K');
    const dialog = page.getByRole('dialog', { name: 'Поиск по порталу' });
    await expect(dialog).toBeVisible();
    const box = dialog.getByRole('searchbox', { name: 'Что найти' });
    await expect(box).toBeFocused();
    // Before typing: quick navigation to the pages.
    await expect(dialog.getByRole('link', { name: /Календарь/ })).toBeVisible();

    await box.fill('на даче');
    await expect(dialog.getByRole('status')).toContainText('Найдено');
    const notes = dialog.getByRole('region', { name: 'Заметки' });
    await expect(notes.getByRole('link', { name: new RegExp(NOTE) })).toBeVisible();
    await expect(notes.getByRole('link', { name: new RegExp(SECRET_NOTE) })).toBeVisible();
    const events = dialog.getByRole('region', { name: 'События календаря' });
    await expect(events.getByRole('link', { name: new RegExp(EVENT) }).first()).toBeVisible();
    await expect(events.getByText('20 декабря 2026, 09:00').first()).toBeVisible();

    // Only one place: the chip narrows the answer.
    await dialog.getByRole('button', { name: 'События календаря' }).click();
    await expect(dialog.getByRole('region', { name: 'Заметки' })).toHaveCount(0);
    await expect(events.getByRole('link', { name: new RegExp(EVENT) }).first()).toBeVisible();
    await dialog.getByRole('button', { name: 'Везде' }).click();

    // The arrow keys walk through the results and Enter opens the one in focus.
    await box.focus();
    await page.keyboard.press('ArrowDown');
    await expect(dialog.locator('a.search__item').first()).toBeFocused();
    await notes.getByRole('link', { name: new RegExp(NOTE) }).focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/notes\?space=shared&note=/);
    await expect(
      page.getByRole('region', { name: 'Заметка' }).getByRole('heading', { name: NOTE }),
    ).toBeVisible();

    // Another person (the administrator) neither finds the private note nor sees that it exists.
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signIn(adminPage, 'admin', '/');
    await adminPage.keyboard.press('Control+K');
    const adminDialog = adminPage.getByRole('dialog', { name: 'Поиск по порталу' });
    await adminDialog.getByRole('searchbox', { name: 'Что найти' }).fill('на даче');
    await expect(
      adminDialog.getByRole('region', { name: 'Заметки' }).getByRole('link', { name: new RegExp(NOTE) }),
    ).toBeVisible();
    await expect(adminDialog.getByText(SECRET_NOTE)).toHaveCount(0);
    await adminContext.close();
  });

  test('says plainly when nothing is found, jumps to a page by its name, closes with Escape', async ({
    page,
  }) => {
    await signIn(page, 'family', '/');
    // «/» opens it when no field has the focus.
    await page.keyboard.press('/');
    const dialog = page.getByRole('dialog', { name: 'Поиск по порталу' });
    await expect(dialog).toBeVisible();
    const box = dialog.getByRole('searchbox', { name: 'Что найти' });

    await box.fill('ъъъъъъъъ');
    await expect(dialog.getByText('Ничего не нашлось по «ъъъъъъъъ»')).toBeVisible();
    await expect(
      dialog.getByText('чужие личные записи, события и переписка в поиске не показываются'),
    ).toBeVisible();

    await box.fill('принтер');
    await expect(dialog.getByRole('link', { name: /Печать/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/print$/);
    await expect(dialog).toBeHidden();

    await page.keyboard.press('Control+K');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // The administration page is not offered to a family member.
    await page.keyboard.press('Control+K');
    await dialog.getByRole('searchbox', { name: 'Что найти' }).fill('администрирование');
    await expect(dialog.getByRole('link', { name: /Администрирование/ })).toHaveCount(0);
  });

  test('is usable on a phone: nothing sticks out, the trigger has a name, and axe finds nothing', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'family', '/');
    await expectNoHorizontalOverflow(page);
    await page.getByRole('button', { name: /Поиск/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Поиск по порталу' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('searchbox', { name: 'Что найти' }).fill('дач');
    await expect(dialog.getByRole('status')).toContainText('Найдено');
    await expectNoHorizontalOverflow(page);
    const box = await dialog.boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(390);
    const results = await new AxeBuilder({ page }).include('dialog[open]').analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
