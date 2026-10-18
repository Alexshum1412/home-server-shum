import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { expectNoHorizontalOverflow, signIn } from './helpers.ts';

/*
 * The cinema page against a stand-in for Jellyfin (tests/e2e/fake-jellyfin.mjs): invented titles,
 * generated posters, a 3-second test video. It proves the portal's side — catalogue, search, posters,
 * playback through the portal, the saved place — not Jellyfin itself.
 */
test.describe.configure({ mode: 'serial' });

const dialog = (page: Page) => page.getByRole('dialog');

async function open(page: Page, title: string) {
  await page
    .getByRole('link', { name: new RegExp(title) })
    .first()
    .click();
  await expect(dialog(page).getByRole('heading', { level: 2, name: title })).toBeVisible();
}

test.describe('cinema', () => {
  test('posters, libraries, genres and search', async ({ page }) => {
    await signIn(page, 'family', '/cinema');
    await expect(page.getByRole('heading', { level: 1, name: 'Кинотеатр' })).toBeVisible();
    const latest = page.getByRole('region', { name: 'Недавно добавлено' });
    await expect(latest.getByRole('link', { name: /Весёлые каникулы/ })).toBeVisible();
    // A poster arrives as a real picture; an item without one gets a plate with its title.
    const poster = latest.getByRole('link', { name: /Весёлые каникулы/ }).locator('img');
    await expect.poll(() => poster.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await expect(
      latest.getByRole('link', { name: /Фильм без обложки/ }).locator('.poster__plate'),
    ).toBeVisible();

    const libraries = page.getByRole('navigation', { name: 'Разделы медиатеки' });
    await libraries.getByRole('link', { name: 'Фильмы' }).click();
    const results = page.getByRole('region', { name: 'Найденное' });
    await expect(results.getByRole('link')).toHaveCount(4);

    await page.getByLabel('Жанр').selectOption('Приключения');
    await expect(results.getByRole('link')).toHaveCount(2);

    await page.getByRole('searchbox', { name: 'Поиск по названию' }).fill('курьер');
    await expect(results.getByRole('link')).toHaveCount(1);
    await expect(results.getByRole('link', { name: /Звёздный курьер/ })).toBeVisible();

    await page.getByRole('searchbox', { name: 'Поиск по названию' }).fill('такого нет');
    await expect(page.getByRole('heading', { level: 2, name: 'Ничего не найдено' })).toBeVisible();
  });

  test('a film plays through the portal, remembers the place and offers «Продолжить»', async ({ page }) => {
    await signIn(page, 'family', '/cinema');
    await open(page, 'Весёлые каникулы');
    await expect(dialog(page)).toContainText('Семья едет на море');
    await expect(dialog(page)).toContainText('h264');
    await dialog(page)
      .getByRole('button', { name: /^(Смотреть|Продолжить с .+)$/ })
      .click();

    const video = dialog(page).locator('video');
    await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
    // Seek (the portal passes Range on), play on, and stop: the place goes to the portal.
    await video.evaluate((v: HTMLVideoElement) => {
      v.currentTime = 1.5;
    });
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(1.4);
    const saved = page.waitForRequest((request) => request.url().endsWith('/api/catalog/progress'));
    await video.evaluate((v: HTMLVideoElement) => v.pause());
    expect((await saved).postDataJSON()).toMatchObject({ positionSec: 1 });
  });

  test('a file the browser cannot play is not offered to it; Jellyfin is', async ({ page }) => {
    await signIn(page, 'family', '/cinema?lib=&q=');
    await open(page, 'Звёздный курьер');
    await expect(dialog(page).getByRole('button', { name: 'Смотреть' })).toHaveCount(0);
    await expect(dialog(page)).toContainText('перекодирует');
    await expect(dialog(page)).toContainText(/hevc/);
    const link = dialog(page).getByRole('link', { name: /Открыть в Jellyfin/ });
    await expect(link).toHaveAttribute('href', /\/web\/index\.html#!\/details\?id=[0-9a-f]{32}$/);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);

    await open(page, 'Тайна старого маяка');
    await expect(dialog(page)).toContainText('MKV');
    await expect(dialog(page).getByRole('button', { name: /^(Смотреть|Продолжить с .+)$/ })).toBeVisible();
  });

  test('a series: seasons, episodes, and an episode plays', async ({ page }) => {
    await signIn(page, 'family', '/cinema');
    await page
      .getByRole('navigation', { name: 'Разделы медиатеки' })
      .getByRole('link', { name: 'Сериалы' })
      .click();
    await open(page, 'Приключения кота Мурзика');
    await dialog(page)
      .getByRole('link', { name: /Сезон 1/ })
      .click();
    await expect(dialog(page).getByRole('heading', { level: 2, name: 'Сезон 1' })).toBeVisible();
    await dialog(page)
      .getByRole('link', { name: /Дождливый вторник/ })
      .click();
    await expect(dialog(page).getByRole('heading', { level: 2, name: 'Дождливый вторник' })).toBeVisible();
    await dialog(page)
      .getByRole('button', { name: /^(Смотреть|Продолжить с .+)$/ })
      .click();
    await expect
      .poll(() =>
        dialog(page)
          .locator('video')
          .evaluate((v: HTMLVideoElement) => v.readyState),
      )
      .toBeGreaterThanOrEqual(2);
  });

  test('an audiobook: the book, its chapters, and a chapter plays as audio', async ({ page }) => {
    await signIn(page, 'family', '/cinema');
    await page
      .getByRole('navigation', { name: 'Разделы медиатеки' })
      .getByRole('link', { name: 'Аудиокниги' })
      .click();
    await open(page, 'Сказки на ночь');
    await expect(dialog(page).getByRole('link', { name: /Глава 1\. Лесной гость/ })).toBeVisible();
    await dialog(page)
      .getByRole('link', { name: /Глава 2\. Река/ })
      .click();
    await expect(dialog(page).getByRole('heading', { level: 2, name: 'Глава 2. Река' })).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Слушать' }).click();
    const audio = dialog(page).locator('audio');
    await expect(audio).toBeVisible();
    await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.readyState)).toBeGreaterThanOrEqual(2);
  });

  test('«Продолжить просмотр» shows the film at the saved place, only for this person', async ({
    page,
    browser,
  }) => {
    await signIn(page, 'family', '/cinema');
    // The test clip lasts 3 seconds, too short to leave a place worth keeping: the place is set through the API.
    const saved = await page.request.post('/api/catalog/progress', {
      data: { id: '00000000000000000000000000000001', positionSec: 1800, durationSec: 5760 },
    });
    expect(saved.status()).toBe(204);
    await page.reload();
    const rail = page.getByRole('region', { name: 'Продолжить просмотр' });
    await expect(rail.getByRole('link', { name: /Весёлые каникулы/ })).toBeVisible();
    await expect(rail.getByRole('link', { name: /просмотрено 31 %/ })).toBeVisible();
    await open(page, 'Весёлые каникулы');
    await expect(dialog(page).getByRole('button', { name: 'Продолжить с 30:00' })).toBeVisible();

    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await signIn(otherPage, 'admin', '/cinema');
    await expect(otherPage.getByRole('region', { name: 'Недавно добавлено' })).toBeVisible();
    await expect(otherPage.getByRole('region', { name: 'Продолжить просмотр' })).toHaveCount(0);
    await other.close();
  });

  test('the fallback page is one click away and still works', async ({ page }) => {
    await signIn(page, 'family', '/cinema');
    await page.getByRole('link', { name: /Запасной просмотр без Jellyfin/ }).click();
    // The page that always worked: its fallback list is unfolded and shows the library's folders.
    await expect(page.getByRole('heading', { level: 1, name: 'Кинотеатр' })).toBeVisible();
    await expect(page.getByText('Это запасной путь', { exact: false })).toBeVisible();
    await page.getByRole('link', { name: /К афишам кинотеатра/ }).click();
    await expect(page.getByRole('region', { name: 'Недавно добавлено' })).toBeVisible();
  });

  test('on a phone: no overflow, readable, no serious accessibility problems', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'family', '/cinema');
    await expect(page.getByRole('region', { name: 'Недавно добавлено' })).toBeVisible();
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
    await page.screenshot({ path: 'artifacts/ui-review/cinema-390.png' });
    await open(page, 'Звёздный курьер');
    await expectNoHorizontalOverflow(page);
    await scan();
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 900 });
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: 'artifacts/ui-review/cinema-1440.png' });
  });
});
