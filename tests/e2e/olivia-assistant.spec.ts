import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { makeTorrent } from '../../server/test/fixtures/torrent-builder.ts';
import { expectNoHorizontalOverflow, signIn } from './helpers.ts';
import { E2E_TORRENT } from './torrent-fixture.ts';

/*
 * «Оливия» for everybody: asked in plain words, she looks things up with the asking person's own
 * rights. Runs on the «cinema» test server (invented films, a stand-in torrent client); no language
 * model is connected there, so every answer comes from the built-in rules.
 */
test.describe.configure({ mode: 'serial' });

const log = (page: Page) => page.getByRole('log');
const say = async (page: Page, text: string) => {
  await page.getByLabel('Вопрос Оливии').fill(text);
  await page.getByRole('button', { name: 'Спросить' }).click();
};

test.describe('Olivia', () => {
  test('greets, says that no model is connected, and answers the clear questions at once', async ({
    page,
  }) => {
    await signIn(page, 'family', '/olivia');
    await expect(page.getByRole('heading', { level: 1, name: 'Оливия' })).toBeVisible();
    await expect(page.getByText('Языковая модель не подключена')).toBeVisible();
    await expect(log(page).getByText('Здравствуйте! Я Оливия')).toBeVisible();
    await page.getByRole('button', { name: 'Сколько места на диске?' }).click();
    await expect(page.locator('.olivia-turn').filter({ hasText: /Диск / }).last()).toBeVisible();
    await page.getByRole('button', { name: 'Что ты умеешь?' }).click();
    await expect(
      page.locator('.olivia-turn').filter({ hasText: 'Сама я ничего не удаляю' }).last(),
    ).toBeVisible();
  });

  test('finds a film and opens it in the cinema', async ({ page }) => {
    await signIn(page, 'family', '/olivia');
    await say(page, 'найди фильм про каникулы');
    const card = page.locator('.olivia-card--poster').getByRole('link', { name: /Весёлые каникулы/ });
    await expect(card).toBeVisible();
    await card.click();
    await expect(
      page.getByRole('dialog').getByRole('heading', { level: 2, name: 'Весёлые каникулы' }),
    ).toBeVisible();
  });

  test('a person without the right to download is told how to get it, and a link is only checked', async ({
    page,
  }) => {
    await signIn(page, 'chatter', '/olivia');
    await say(page, 'что с моими загрузками');
    await expect(
      page.locator('.olivia-turn').filter({ hasText: 'нет разрешения на загрузки' }),
    ).toBeVisible();
    await say(page, 'скачай https://example.org/film.mkv');
    await expect(page.locator('.olivia-turn').filter({ hasText: 'нет разрешения на загрузки' })).toHaveCount(
      2,
    );
  });

  test('prepares a magnet for the administrator; nothing starts until the button is pressed', async ({
    page,
  }) => {
    const sample = makeTorrent(E2E_TORRENT);
    await signIn(page, 'admin', '/olivia');
    await say(page, `скачай magnet:?xt=urn:btih:${sample.infoHash}`);
    const check = page.locator('.olivia-card--check');
    await expect(check.getByText('Тестовая раздача')).toBeVisible({ timeout: 30_000 });
    await expect(check).toContainText('программы и скрипты пропущены: 1');
    // not started yet
    await page.goto('/downloads');
    await expect(page.getByRole('heading', { level: 2, name: /Все загрузки семьи/ })).toBeVisible();
    await expect(page.locator('li.download').filter({ hasText: 'Тестовая раздача' })).toHaveCount(0);
  });

  test('on a phone: no overflow, no serious accessibility problems', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'family', '/olivia');
    await say(page, 'найди фильм про каникулы');
    await expect(page.locator('.olivia-card--poster')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.waitForLoadState('networkidle');
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(
      bad.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(' | ')})`),
    ).toEqual([]);
    await page.screenshot({ path: 'artifacts/ui-review/olivia-390.png' });
  });
});
