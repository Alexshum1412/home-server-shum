import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { makeTorrent } from '../../server/test/fixtures/torrent-builder.ts';
import { expectNoHorizontalOverflow, signIn } from './helpers.ts';
import { E2E_TORRENT } from './torrent-fixture.ts';

/*
 * The downloads page with a torrent, against a stand-in for the torrent client that moves a
 * download forward every time the portal looks (tests/e2e/start-server.mjs, mode «cinema»).
 * It proves the portal's side: what is checked, what is shown, where the result goes. It does not
 * prove that a real client downloads from real peers — that is checked by hand (docs/runbooks/torrents.md).
 */
test.describe.configure({ mode: 'serial' });

const sample = makeTorrent(E2E_TORRENT);
const row = (page: Page, name: string | RegExp) => page.locator('li.download').filter({ hasText: name });

async function chooseFile(page: Page, bytes: Buffer = sample.bytes) {
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'раздача.torrent', mimeType: 'application/x-bittorrent', buffer: bytes });
}

test.describe('torrents', () => {
  test('a .torrent file: the list of files, the skipped program, the choice of the folder, progress and the end', async ({
    page,
  }) => {
    await signIn(page, 'admin', '/downloads');
    await expect(page.getByRole('heading', { level: 1, name: 'Загрузки' })).toBeVisible();
    await expect(page.getByText('Торренты сейчас недоступны')).toHaveCount(0);

    await chooseFile(page);
    const confirm = page.getByRole('group', { name: 'Подтверждение загрузки' });
    await expect(confirm.getByText('Скачать эту раздачу?')).toBeVisible();
    await expect(confirm).toContainText('Тестовая раздача');
    await expect(confirm).toContainText('файлов: 2');
    await expect(confirm).toContainText('Программы и скрипты не скачиваются: пропущено файлов — 1');
    await confirm.getByText(/Что внутри/).click();
    await expect(confirm.getByText('установка.exe')).toBeVisible();
    await expect(confirm.getByText('не будет скачан')).toBeVisible();
    // the default place is the private folder; the media folders are named as shared
    await expect(confirm.getByLabel(/Файлы → Личное → Загрузки/)).toBeChecked();
    await confirm.getByLabel(/Общая медиатека → Фильмы/).check();
    await confirm.getByRole('button', { name: 'Скачать' }).click();

    await expect(page.getByRole('status').filter({ hasText: 'добавлен в очередь' })).toBeVisible();
    const task = row(page, 'Тестовая раздача');
    await expect(task).toContainText('торрент');
    await expect(task).toContainText('Сохраняется: Общая медиатека → Фильмы');
    // the stand-in client advances at every look: the bar moves, then «Готово»
    await expect(task.locator('.download__state')).toHaveText(/Готово/, { timeout: 30_000 });
    await expect(task.getByRole('link', { name: 'Открыть в кинотеатре' })).toBeVisible();
    await expect(task.getByRole('button', { name: /Убрать из списка|Закончить раздачу/ })).toBeVisible();
    await task.getByRole('button', { name: /Убрать из списка|Закончить раздачу/ }).click();
    await expect(row(page, 'Тестовая раздача')).toHaveCount(0);
  });

  test('a magnet link: the portal waits for the contents, then shows them', async ({ page }) => {
    await signIn(page, 'admin', '/downloads');
    await page
      .getByLabel('Ссылка на файл или магнитная ссылка')
      .fill(`magnet:?xt=urn:btih:${sample.infoHash}&dn=x`);
    await page.getByRole('button', { name: 'Проверить' }).click();
    const confirm = page.getByRole('group', { name: 'Подтверждение загрузки' });
    await expect(confirm.getByText('Скачать эту раздачу?')).toBeVisible({ timeout: 30_000 });
    await expect(confirm).toContainText('Тестовая раздача');
    await confirm.getByRole('button', { name: 'Не скачивать' }).click();
    await expect(confirm).toHaveCount(0);
  });

  test('pause, resume and cancel', async ({ page }) => {
    await signIn(page, 'admin', '/downloads');
    // a big one so that it does not finish while we click
    const big = makeTorrent({ name: 'Длинная раздача', length: 40 * 1024 ** 3 });
    await chooseFile(page, big.bytes);
    await page
      .getByRole('group', { name: 'Подтверждение загрузки' })
      .getByRole('button', { name: 'Скачать' })
      .click();
    const task = row(page, 'Длинная раздача');
    await expect(task).toBeVisible();
    await task.getByRole('button', { name: 'Пауза' }).click();
    await expect(task.locator('.download__state')).toHaveText('На паузе');
    await task.getByRole('button', { name: 'Продолжить' }).click();
    await expect(task.locator('.download__state')).toHaveText(/Скачивается|В очереди/);
    page.once('dialog', (dialog) => void dialog.accept());
    await task.getByRole('button', { name: 'Отменить' }).click();
    await expect(row(page, 'Длинная раздача')).toHaveCount(0);
  });

  test('refuses a torrent of programs and a damaged file with a plain explanation', async ({ page }) => {
    await signIn(page, 'admin', '/downloads');
    await chooseFile(page, makeTorrent({ name: 'crack', files: [{ path: ['a.exe'], length: 5 }] }).bytes);
    await expect(page.getByRole('alert').filter({ hasText: 'программы и скрипты' })).toBeVisible();
    await chooseFile(page, Buffer.from('это не торрент'));
    await expect(page.getByRole('alert').filter({ hasText: /не файл \.torrent|\.torrent/ })).toBeVisible();
    await expect(page.getByText('Скачать эту раздачу?')).toHaveCount(0);
  });

  test('on a phone: no overflow, no serious accessibility problems', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'admin', '/downloads');
    await chooseFile(page);
    await expect(page.getByText('Скачать эту раздачу?')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.waitForLoadState('networkidle');
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(
      bad.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(' | ')})`),
    ).toEqual([]);
    await page.screenshot({ path: 'artifacts/ui-review/downloads-torrent-390.png', fullPage: true });
  });
});
