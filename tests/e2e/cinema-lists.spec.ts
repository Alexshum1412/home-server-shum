import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import type { CatalogShelvesResponse } from '../../shared/api.ts';
import { expectNoHorizontalOverflow, signIn } from './helpers.ts';

/*
 * The personal rows of the cinema (marks, «Для вас», «Новое», history) and the family's suggestions, against the
 * stand-in for Jellyfin (tests/e2e/fake-jellyfin.mjs): two of its titles are «new», the rest is two months old.
 */
test.describe.configure({ mode: 'serial' });

const dialog = (page: Page) => page.getByRole('dialog');
const mark = (page: Page, name: string, title: string) =>
  page.getByRole('button', { name: `${name}: ${title}` }).first();

/** A retry of a test meets the marks of the first run: every mark of this person is taken off first. */
async function resetMarks(page: Page) {
  const shelves = (await (await page.request.get('/api/catalog/shelves')).json()) as CatalogShelvesResponse;
  const { favourites, later, watched } = shelves.marks;
  for (const id of new Set([...favourites, ...later, ...watched])) {
    await page.request.post('/api/catalog/marks', {
      data: { id, favourite: false, later: false, watched: false },
    });
  }
}
test.describe('cinema: marks, rows and suggestions', () => {
  test('«Новое» shows what came in lately, with the day it was added', async ({ page }) => {
    await signIn(page, 'family', '/cinema');
    const news = page.getByRole('region', { name: 'Новое' });
    await expect(news.getByRole('link', { name: /Звёздный курьер/ })).toBeVisible();
    await expect(news.getByRole('link', { name: /Семейные песни/ })).toBeVisible();
    await expect(news.getByText(/^Добавлено \d+ \S+/).first()).toBeVisible();
    // «Недавно добавлено» does not repeat what «Новое» already shows.
    const latest = page.getByRole('region', { name: 'Недавно добавлено' });
    await expect(latest.getByRole('link', { name: /Звёздный курьер/ })).toHaveCount(0);
    await expect(latest.getByRole('link', { name: /Весёлые каникулы/ })).toBeVisible();
  });

  test('a heart, «later» and «watched» on a poster change the person’s own rows and give «Для вас» a reason', async ({
    page,
  }) => {
    await signIn(page, 'family', '/cinema');
    await resetMarks(page);
    await page.reload();
    await expect(mark(page, 'Избранное', 'Звёздный курьер')).toHaveAttribute('aria-pressed', 'false');
    await mark(page, 'Избранное', 'Звёздный курьер').click();
    await expect(mark(page, 'Избранное', 'Звёздный курьер')).toHaveAttribute('aria-pressed', 'true');
    await mark(page, 'Посмотреть позже', 'Семейные песни').click();
    await expect(mark(page, 'Посмотреть позже', 'Семейные песни')).toHaveAttribute('aria-pressed', 'true');

    const chips = page.getByRole('navigation', { name: 'Мои подборки' });
    await expect(chips.getByRole('link', { name: /Избранное · 1/ })).toBeVisible();
    await expect(chips.getByRole('link', { name: /Мой список · 1/ })).toBeVisible();

    // The suggestions are for films not seen yet and say why.
    const forYou = page.getByRole('region', { name: 'Для вас' });
    await expect(forYou.getByText(/В избранном есть „Звёздный курьер“/).first()).toBeVisible();
    await expect(forYou.getByRole('link', { name: /Звёздный курьер/ })).toHaveCount(0);

    // Reload: the marks are kept on the server.
    await page.reload();
    await expect(mark(page, 'Избранное', 'Звёздный курьер')).toHaveAttribute('aria-pressed', 'true');
  });

  test('a row opens as a page that search, genre and type narrow, and «watched» goes into the history', async ({
    page,
  }) => {
    await signIn(page, 'family', '/cinema');
    await page
      .getByRole('navigation', { name: 'Мои подборки' })
      .getByRole('link', { name: /Избранное/ })
      .click();
    await expect(page).toHaveURL(/view=favourites/);
    const list = page.getByRole('region', { name: 'Избранное' });
    await expect(list.getByRole('link', { name: /Звёздный курьер/ })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Поиск по названию' }).fill('нет такого');
    await expect(page.getByRole('heading', { level: 3, name: 'Ничего не найдено' })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Поиск по названию' }).fill('курьер');
    await expect(list.getByRole('link', { name: /Звёздный курьер/ })).toBeVisible();

    // The film's own window has the marks as words; «watched» is also a state.
    await list.getByRole('link', { name: /Звёздный курьер/ }).click();
    await expect(dialog(page).getByRole('heading', { level: 2, name: 'Звёздный курьер' })).toBeVisible();
    await expect(dialog(page).getByText('В избранном').first()).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Отметить просмотренным' }).click();
    await expect(dialog(page).getByText('Просмотрено').first()).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Закрыть' }).click();

    await page.goto('/cinema?view=history');
    const history = page.getByRole('region', { name: 'История: что я смотрел' });
    await expect(history.getByRole('link', { name: /Звёздный курьер/ })).toBeVisible();
    await expect(history.getByText(/сегодня в \d{2}:\d{2}/).first()).toBeVisible();
    // A watched film is no longer offered under «Для вас».
    await page.goto('/cinema');
    await expect(
      page.getByRole('region', { name: 'Для вас' }).getByRole('link', { name: /Звёздный курьер/ }),
    ).toHaveCount(0);
  });

  test('nobody else sees these marks, the history or the rows — not even an administrator', async ({
    page,
    browser,
  }) => {
    await signIn(page, 'family', '/cinema');
    const mine = await page.request.get('/api/catalog/shelves');
    expect(((await mine.json()) as CatalogShelvesResponse).marks.favourites.length).toBeGreaterThan(0);

    for (const who of ['chatter', 'admin'] as const) {
      const context = await browser.newContext();
      const other = await context.newPage();
      await signIn(other, who, '/cinema');
      const shelves = (await (
        await other.request.get('/api/catalog/shelves')
      ).json()) as CatalogShelvesResponse;
      expect(shelves.marks).toEqual({ favourites: [], later: [], watched: [] });
      expect(shelves.favourites).toEqual([]);
      expect(shelves.later).toEqual([]);
      expect(shelves.history).toEqual([]);
      await expect(
        other.getByRole('navigation', { name: 'Мои подборки' }).getByRole('link', { name: /Избранное · 0/ }),
      ).toBeVisible();
      await context.close();
    }
  });

  test('a family member suggests a film, everybody sees it, the administrator answers and is told', async ({
    page,
    browser,
  }) => {
    await signIn(page, 'family', '/cinema');
    await page.getByRole('button', { name: 'Предложить фильм' }).click();
    const box = dialog(page);
    await expect(box.getByRole('heading', { level: 2, name: 'Предложить фильм' })).toBeVisible();
    await box.getByRole('button', { name: 'Отправить предложение' }).click();
    await expect(box.getByRole('alert')).toContainText('Напишите название');
    await box.getByLabel('Название фильма или сериала').fill('Пираты Карибского моря');
    await box.getByLabel('Пояснение').fill('Хочется посмотреть всей семьёй в выходные');
    await box.getByRole('button', { name: 'Отправить предложение' }).click();
    await expect(box.getByRole('status')).toContainText('Предложение добавлено');
    const entry = box.getByRole('listitem').filter({ hasText: 'Пираты Карибского моря' });
    await expect(entry).toContainText('Ждёт ответа');
    await expect(entry).toContainText('(вы)');
    // The author may take it back; nobody else gets a button.
    await expect(entry.getByRole('button', { name: /Отозвать/ })).toBeVisible();
    await expect(entry.getByRole('button', { name: /Добавлено/ })).toHaveCount(0);
    await box.getByRole('button', { name: 'Закрыть' }).click();
    await expect(page.getByText(/ждут ответа: 1/)).toBeVisible();

    // Another member sees the suggestion, but cannot answer it.
    const otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    await signIn(other, 'chatter', '/cinema');
    await other.getByRole('button', { name: 'Предложить фильм' }).click();
    const theirEntry = dialog(other).getByRole('listitem').filter({ hasText: 'Пираты Карибского моря' });
    await expect(theirEntry).toContainText('Предлагает: Тестовая семья');
    await expect(theirEntry.getByRole('button')).toHaveCount(0);
    await otherContext.close();

    // The administrator was told, and answers.
    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    await signIn(admin, 'admin', '/cinema');
    const notifications = (await (await admin.request.get('/api/notifications')).json()) as {
      notifications: Array<{ title: string; body: string }>;
    };
    expect(
      notifications.notifications.some(
        (item) => item.title === 'Предложен фильм' && item.body.includes('Пираты Карибского моря'),
      ),
    ).toBe(true);
    await admin.getByRole('button', { name: 'Предложить фильм' }).click();
    const adminEntry = dialog(admin).getByRole('listitem').filter({ hasText: 'Пираты Карибского моря' });
    await adminEntry.getByRole('button', { name: /Добавлено/ }).click();
    await expect(dialog(admin).getByRole('status')).toContainText('добавлено');
    await expect(adminEntry).toContainText('Добавлено');
    await adminContext.close();

    // The author sees the answer.
    await page.reload();
    await page.getByRole('button', { name: 'Предложить фильм' }).click();
    await expect(
      dialog(page).getByRole('listitem').filter({ hasText: 'Пираты Карибского моря' }),
    ).toContainText('Добавлено');
  });

  test('on a phone: nothing sticks out, the marks keep a comfortable target and axe finds nothing', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'family', '/cinema');
    await expect(page.getByRole('region', { name: 'Новое' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const heart = mark(page, 'Избранное', 'Звёздный курьер');
    const box = await heart.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
    await page.getByRole('button', { name: 'Предложить фильм' }).click();
    await expectNoHorizontalOverflow(page);
    const dialogResults = await new AxeBuilder({ page }).include('dialog[open]').analyze();
    expect(dialogResults.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
  });
});
