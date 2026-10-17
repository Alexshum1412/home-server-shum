import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

test.describe.configure({ mode: 'serial' });

test.describe('family calendar', () => {
  test('a family member adds an event, sees it under «Ближайшие», and an admin sees it too', async ({
    page,
    browser,
  }) => {
    await signIn(page, 'family', '/calendar');
    await expect(page.getByRole('heading', { level: 1, name: 'Календарь' })).toBeVisible();
    await page.getByRole('button', { name: 'Добавить событие' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Новое событие' });
    await expect(dialog).toBeVisible();
    // The title field has the focus, an empty title is explained.
    await expect(dialog.getByLabel('Название')).toBeFocused();
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Напишите название');

    await dialog.getByLabel('Название').fill('Родительское собрание');
    await dialog.getByLabel('Весь день').uncheck();
    await dialog.getByLabel('Начало').fill('18:30');
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'Событие добавлено' })).toBeVisible();

    const upcoming = page.getByRole('region', { name: 'Ближайшие две недели' });
    await expect(upcoming.locator('.agenda__title', { hasText: 'Родительское собрание' })).toBeVisible();
    await expect(upcoming.getByText('18:30')).toBeVisible();

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signIn(adminPage, 'admin', '/calendar');
    await expect(
      adminPage
        .getByRole('region', { name: 'Ближайшие две недели' })
        .locator('.agenda__title', { hasText: 'Родительское собрание' }),
    ).toBeVisible();
    await adminContext.close();
  });

  test('a private event is not shown to others; the calendar can be downloaded as .ics', async ({
    page,
    browser,
  }) => {
    await signIn(page, 'family', '/calendar');
    await page.getByRole('button', { name: 'Добавить событие' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Новое событие' });
    await dialog.getByLabel('Название').fill('Сюрприз ко дню рождения');
    await dialog.getByLabel('Только для меня').check();
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.locator('.agenda__title', { hasText: 'Сюрприз ко дню рождения' }).first(),
    ).toBeVisible();
    await expect(page.getByText('только для вас').first()).toBeVisible();

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signIn(adminPage, 'admin', '/calendar');
    await expect(
      adminPage.locator('.agenda__title', { hasText: 'Родительское собрание' }).first(),
    ).toBeVisible();
    await expect(adminPage.locator('.agenda__title', { hasText: 'Сюрприз ко дню рождения' })).toHaveCount(0);
    await adminContext.close();

    const ics = await page.request.get('/api/calendar/export.ics');
    expect(ics.status()).toBe(200);
    expect(ics.headers()['content-type']).toContain('text/calendar');
    const text = await ics.text();
    expect(text).toContain('SUMMARY:Родительское собрание');
    expect(text).toContain('SUMMARY:Сюрприз ко дню рождения');
  });

  test('the home page shows today’s events', async ({ page }) => {
    await signIn(page, 'family', '/');
    await expect(page.getByRole('heading', { level: 2, name: 'Сегодня и завтра' })).toBeVisible();
  });
});

test.describe('family notes', () => {
  test('a note is created, changed, shared with the family and found in the files', async ({
    page,
    browser,
  }) => {
    await signIn(page, 'family', '/notes');
    await expect(page.getByRole('heading', { level: 1, name: 'Заметки' })).toBeVisible();
    await page.getByRole('button', { name: 'Новая заметка' }).click();
    await page.getByLabel('Название').fill('Список покупок');
    await page.getByLabel('Текст').fill('молоко\nхлеб');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Заметка создана' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Список покупок' })).toBeVisible();

    await page.getByLabel('Текст').fill('молоко\nхлеб\nсыр');
    await expect(page.getByText('Есть несохранённые изменения')).toBeVisible();
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Заметка сохранена' })).toBeVisible();
    await page.getByRole('button', { name: 'К списку заметок' }).click();
    await expect(page.getByRole('link', { name: /Список покупок/ })).toBeVisible();

    // The same text is an ordinary file in «Файлы».
    await page.goto('/files?space=shared&path=%D0%97%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B8');
    await expect(page.locator('.files__item').filter({ hasText: 'Список покупок.txt' })).toBeVisible();

    // Another person opens it from the shared notes and sees the change.
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await signIn(otherPage, 'admin', '/notes');
    await otherPage.getByRole('link', { name: /Список покупок/ }).click();
    await expect(otherPage.getByLabel('Текст')).toHaveValue('молоко\nхлеб\nсыр');
    await other.close();
  });

  test('a note somebody else changed meanwhile is not overwritten', async ({ page, browser }) => {
    await signIn(
      page,
      'family',
      '/notes?note=%D0%A1%D0%BF%D0%B8%D1%81%D0%BE%D0%BA%20%D0%BF%D0%BE%D0%BA%D1%83%D0%BF%D0%BE%D0%BA',
    );
    await expect(page.getByLabel('Текст')).toHaveValue('молоко\nхлеб\nсыр');
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await signIn(
      otherPage,
      'admin',
      '/notes?note=%D0%A1%D0%BF%D0%B8%D1%81%D0%BE%D0%BA%20%D0%BF%D0%BE%D0%BA%D1%83%D0%BF%D0%BE%D0%BA',
    );
    await otherPage.getByLabel('Текст').fill('молоко\nхлеб\nсыр\nяйца');
    await otherPage.getByRole('button', { name: 'Сохранить' }).click();
    await expect(otherPage.getByRole('status').filter({ hasText: 'Заметка сохранена' })).toBeVisible();
    await other.close();

    await page.getByLabel('Текст').fill('своё');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'только что изменил кто-то другой' }),
    ).toBeVisible();
    await expect(page.getByLabel('Текст')).toHaveValue('своё');
  });
});
