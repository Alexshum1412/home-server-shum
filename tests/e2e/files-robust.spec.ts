import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { expectNoHorizontalOverflow, signIn } from './helpers.ts';

const PHOTO = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture-photo.jpg'));

// Only this person is used here: the other specs of the «real» server count on «family» and «admin» being untouched.
const WHO = 'chatter' as const;

// One server for all tests: the steps depend on each other (what was added is then moved, removed, brought back).
test.describe.configure({ mode: 'serial' });

/** The same picture with one more comment inside: another file, with another fingerprint. */
function photoNumber(n: number): Buffer {
  const text = Buffer.from(`robust test ${n}`, 'latin1');
  const segment = Buffer.alloc(4);
  segment[0] = 0xff;
  segment[1] = 0xfe;
  segment.writeUInt16BE(text.length + 2, 2);
  return Buffer.concat([PHOTO.subarray(0, 2), segment, text, PHOTO.subarray(2)]);
}

/** A JPEG whose notes hold a marker, as a camera's place of shooting would; `n` makes the files differ. */
function photoWithNotes(n: number): Buffer {
  const payload = Buffer.concat([
    Buffer.from('Exif\0\0MM\0*\0\0\0\x08', 'latin1'),
    Buffer.from('SECRETGPSMARK'),
  ]);
  const segment = Buffer.alloc(4);
  segment[0] = 0xff;
  segment[1] = 0xe1;
  segment.writeUInt16BE(payload.length + 2, 2);
  const numbered = photoNumber(n);
  return Buffer.concat([numbered.subarray(0, 2), segment, payload, numbered.subarray(2)]);
}

const jpeg = (name: string, buffer: Buffer) => ({ name, mimeType: 'image/jpeg', buffer });

async function openFirstMonth(page: Page) {
  await page.getByRole('heading', { level: 1, name: 'Фото' }).waitFor();
  await page.locator('.months__item').first().click();
  await expect(page.locator('.gallery__item').first()).toBeVisible();
}

test.describe('photos: adding in bulk', () => {
  test('a photo that is already there is skipped, and can still be added on purpose', async ({ page }) => {
    await signIn(page, WHO, '/photos');
    const add = page.getByLabel('Добавить фото и видео');
    await add.setInputFiles(jpeg('первое.jpg', photoNumber(1)));
    await expect(page.getByRole('status').filter({ hasText: 'Загружено 1 файл.' })).toBeVisible();
    await page.getByRole('button', { name: 'Убрать из списка' }).click();

    // The same bytes under another name are still the same photo.
    await add.setInputFiles(jpeg('копия-первого.jpg', photoNumber(1)));
    const summary = page.getByRole('status').filter({ hasText: 'пропущено 1 файл' });
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('уже есть на сервере');
    await page.getByText('Уже есть на сервере: 1 файл').click();
    await expect(page.getByText('копия-первого.jpg')).toBeVisible();

    await page.getByRole('button', { name: 'Всё равно загрузить повторы' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Загружено 1 файл.' })).toBeVisible();
    await openFirstMonth(page);
    await expect(page.locator('.gallery__item')).toHaveCount(2);
  });

  test('several photos at once go through one queue with one summary', async ({ page }) => {
    await signIn(page, WHO, '/photos');
    await page
      .getByLabel('Добавить фото и видео')
      .setInputFiles([
        jpeg('а.jpg', photoNumber(11)),
        jpeg('б.jpg', photoNumber(12)),
        jpeg('в.jpg', photoNumber(13)),
      ]);
    await expect(page.getByRole('status').filter({ hasText: 'Загружено 3 файла.' })).toBeVisible();
    await openFirstMonth(page);
    await expect(page.locator('.gallery__item')).toHaveCount(5);
  });

  test('the place of shooting is taken out of a JPEG, unless the box is unticked', async ({ page }) => {
    await signIn(page, WHO, '/photos');
    const add = page.getByLabel('Добавить фото и видео');
    const strip = page.getByLabel(/Убирать место съёмки/);
    await expect(strip).toBeChecked();
    await add.setInputFiles(jpeg('со-следами.jpg', photoWithNotes(31)));
    await expect(page.getByRole('status').filter({ hasText: 'Загружено 1 файл.' })).toBeVisible();
    await page.getByRole('button', { name: 'Убрать из списка' }).click();
    await strip.uncheck();
    await add.setInputFiles(jpeg('без-очистки.jpg', photoWithNotes(32)));
    await expect(page.getByRole('status').filter({ hasText: /Загружено 1 файл|пропущено/ })).toBeVisible();
    await openFirstMonth(page);

    const stored = async (name: string) => {
      const link = page.locator('.gallery__item').filter({ has: page.locator(`img[alt="${name}"]`) });
      await link.click();
      const src = await page.locator('img.viewer__media').getAttribute('src');
      const body = await (await page.request.get(src ?? '')).body();
      await page.getByRole('dialog').getByRole('button', { name: 'Закрыть' }).click();
      return body;
    };
    expect((await stored('со-следами.jpg')).includes('SECRETGPSMARK')).toBe(false);
    expect((await stored('без-очистки.jpg')).includes('SECRETGPSMARK')).toBe(true);
  });

  test('an album: made, filled, renamed, a photo taken out to the trash and brought back', async ({
    page,
  }) => {
    await signIn(page, WHO, '/photos');
    await page.getByRole('button', { name: 'Новый альбом' }).click();
    await page.getByLabel('Название альбома').fill('Поездка');
    await page.getByRole('button', { name: 'Создать' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Поездка' })).toBeVisible();
    await expect(page.getByText('В этом альбоме пока пусто.')).toBeVisible();

    await page.getByLabel('Добавить фото и видео').setInputFiles(jpeg('вид.jpg', photoNumber(21)));
    await expect(page.getByRole('status').filter({ hasText: 'Загружено 1 файл.' })).toBeVisible();
    await expect(page.locator('.gallery__item')).toHaveCount(1);

    page.once('dialog', (d) => d.accept('Дача'));
    await page.getByRole('button', { name: 'Переименовать альбом' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Дача' })).toBeVisible();
    await expect(page.locator('.gallery__item')).toHaveCount(1);

    await page.locator('.gallery__item').first().click();
    page.once('dialog', (d) => d.accept());
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /В корзину/ })
      .click();
    await expect(page.getByRole('status').filter({ hasText: 'перемещён в корзину' })).toBeVisible();
    await expect(page.getByText('В этом альбоме пока пусто.')).toBeVisible();

    await page.getByRole('button', { name: 'Корзина' }).click();
    const trash = page.getByRole('dialog', { name: 'Корзина' });
    await expect(trash.locator('.trash-list__name', { hasText: 'вид.jpg' })).toBeVisible();
    await trash.getByRole('button', { name: /Вернуть/ }).click();
    await expect(trash.getByText('Корзина пуста.')).toBeVisible();
    await trash.getByRole('button', { name: 'Закрыть' }).click();
    await expect(page.locator('.gallery__item')).toHaveCount(1);

    // The album list knows about it too.
    await page.getByRole('button', { name: 'Все фото' }).click();
    await expect(page.locator('.albums__item').filter({ hasText: 'Дача' })).toContainText('1 фото');
  });
});

test.describe('files: queue, resume, bulk actions, viewer', () => {
  test('a large file survives a dropped connection and arrives intact', async ({ page }) => {
    test.setTimeout(90_000);
    const size = 12 * 1024 * 1024;
    const body = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) body[i] = (i * 31 + (i >> 8)) & 0xff;
    const sha = createHash('sha256').update(body).digest('hex');

    await signIn(page, WHO, '/files');
    let dropped = 0;
    await page.route('**/api/storage/files/session/**', async (route) => {
      if (route.request().method() === 'PUT' && dropped === 0) {
        dropped += 1;
        await route.abort('connectionreset');
        return;
      }
      await route.continue();
    });
    await page.getByLabel('Загрузить файлы').setInputFiles({
      name: 'большой-архив.txt',
      mimeType: 'text/plain',
      buffer: body,
    });
    await expect(page.getByRole('status').filter({ hasText: 'Загружено 1 файл.' })).toBeVisible({
      timeout: 60_000,
    });
    expect(dropped).toBe(1);

    const item = page.locator('.files__item').filter({ hasText: 'большой-архив.txt' });
    await expect(item).toBeVisible();
    const href = await item.locator('a.files__name').getAttribute('href');
    const received = await (await page.request.get(href ?? '')).body();
    expect(received.length).toBe(size);
    expect(createHash('sha256').update(received).digest('hex')).toBe(sha);
  });

  test('several files are chosen, moved into a folder, thrown away together and brought back', async ({
    page,
  }) => {
    await signIn(page, WHO, '/files');
    await page.getByLabel('Загрузить файлы').setInputFiles(
      ['один.txt', 'два.txt', 'три.txt'].map((name) => ({
        name,
        mimeType: 'text/plain',
        buffer: Buffer.from(name),
      })),
    );
    await expect(page.getByRole('status').filter({ hasText: 'Загружено 3 файла.' })).toBeVisible();
    page.once('dialog', (d) => d.accept('Бумаги'));
    await page.getByRole('button', { name: 'Новая папка' }).click();
    await expect(page.locator('.files__item').filter({ hasText: 'Бумаги' })).toBeVisible();

    await page.getByLabel('Выбрать «один.txt»').check();
    await page.getByLabel('Выбрать «два.txt»').check();
    const bar = page.getByRole('group', { name: 'Действия с выбранным' });
    await expect(bar).toContainText('Выбрано: 2 элемента');
    await bar.getByRole('button', { name: /Переместить/ }).click();

    const move = page.getByRole('dialog', { name: /Куда переместить/ });
    // The folder where the files already are is not a destination.
    await expect(move.getByRole('button', { name: /Переместить сюда/ })).toBeDisabled();
    await move.getByRole('button', { name: 'Бумаги' }).click();
    await move.getByRole('button', { name: /Переместить сюда: «Бумаги»/ }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Перемещено в папку «Бумаги»: 2 элемента' }),
    ).toBeVisible();
    await expect(page.locator('.files__item').filter({ hasText: 'один.txt' })).toHaveCount(0);
    await expect(page.locator('.files__item').filter({ hasText: 'три.txt' })).toBeVisible();

    await page
      .locator('.files__item')
      .filter({ hasText: 'Бумаги' })
      .getByRole('button', { name: 'Бумаги' })
      .first()
      .click();
    await expect(page.locator('.files__item').filter({ hasText: 'один.txt' })).toBeVisible();
    await expect(page.locator('.files__item').filter({ hasText: 'два.txt' })).toBeVisible();

    await page.getByLabel('Выбрать «один.txt»').check();
    await page.getByLabel('Выбрать «два.txt»').check();
    page.once('dialog', (d) => {
      expect(d.message()).toContain('2 элемента');
      void d.accept();
    });
    await page
      .getByRole('group', { name: 'Действия с выбранным' })
      .getByRole('button', { name: /В корзину/ })
      .click();
    await expect(
      page.getByRole('status').filter({ hasText: 'В корзину перемещено: 2 элемента' }),
    ).toBeVisible();
    await expect(page.getByText('Здесь пока пусто')).toBeVisible();

    await page.getByRole('button', { name: 'Корзина' }).click();
    const trash = page.getByRole('dialog', { name: 'Корзина' });
    await expect(trash.locator('.trash-list__name', { hasText: 'один.txt' })).toBeVisible();
    await trash.getByRole('button', { name: /Вернуть.*один\.txt/ }).click();
    await expect(trash.locator('.trash-list__name', { hasText: 'один.txt' })).toHaveCount(0);
    await trash.getByRole('button', { name: 'Закрыть' }).click();
    await expect(page.locator('.files__item').filter({ hasText: 'один.txt' })).toBeVisible();
  });

  test('a text file opens in a window of the page, a PDF is served so that the browser can show it', async ({
    page,
    context,
  }) => {
    await signIn(page, WHO, '/files');
    const pdf = Buffer.from(
      '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
    );
    await page.getByLabel('Загрузить файлы').setInputFiles([
      { name: 'записка.txt', mimeType: 'text/plain', buffer: Buffer.from('купить хлеб и молоко') },
      { name: 'документ.pdf', mimeType: 'application/pdf', buffer: pdf },
    ]);
    await expect(page.getByRole('status').filter({ hasText: 'Загружено 2 файла.' })).toBeVisible();

    await page
      .locator('.files__item')
      .filter({ hasText: 'записка.txt' })
      .getByRole('button', { name: /Открыть/ })
      .click();
    const viewer = page.getByRole('dialog', { name: 'записка.txt' });
    await expect(viewer.getByText('купить хлеб и молоко')).toBeVisible();
    await viewer.getByRole('button', { name: 'Закрыть' }).click();

    await page
      .locator('.files__item')
      .filter({ hasText: 'документ.pdf' })
      .getByRole('button', { name: /Открыть/ })
      .click();
    const pdfViewer = page.getByRole('dialog', { name: 'документ.pdf' });
    const link = pdfViewer.getByRole('link', { name: /Открыть в новой вкладке/ });
    const href = (await link.getAttribute('href')) ?? '';
    const response = await page.request.get(href);
    expect(response.headers()['content-type']).toBe('application/pdf');
    expect(response.headers()['content-disposition']).toMatch(/^inline/);
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
    // Even a PDF opened on its own can never run a script inside the portal.
    expect(response.headers()['content-security-policy']).toContain("default-src 'none'");

    const [popup] = await Promise.all([context.waitForEvent('page'), link.click()]);
    await popup.waitForLoadState();
    // Chrome's own viewer took the file (seen on screen on 20.10.2026): it puts the file into its embedded viewer.
    await expect
      .poll(() =>
        popup
          .frames()
          .map((frame) => frame.url())
          .join(' | '),
      )
      .toContain('chrome-extension://');
    await popup.close();
  });

  test('the page fits a phone with the choice bar, the trash and the move window open', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, WHO, '/files');
    await expect(page.locator('.files__item').first()).toBeVisible();
    await page.locator('.files__item').first().getByRole('checkbox').check();
    await expectNoHorizontalOverflow(page);
    await page
      .getByRole('group', { name: 'Действия с выбранным' })
      .getByRole('button', { name: /Переместить/ })
      .click();
    const move = page.getByRole('dialog', { name: /Куда переместить/ });
    await expect(move).toBeVisible();
    const moveResult = await new AxeBuilder({ page }).include('dialog[open]').analyze();
    expect(moveResult.violations, JSON.stringify(moveResult.violations.map((v) => v.id))).toEqual([]);
    await move.getByRole('button', { name: 'Закрыть' }).click();
    await page.getByRole('button', { name: 'Корзина' }).click();
    const trash = page.getByRole('dialog', { name: 'Корзина' });
    await expect(trash).toBeVisible();
    const trashResult = await new AxeBuilder({ page }).include('dialog[open]').analyze();
    expect(trashResult.violations, JSON.stringify(trashResult.violations.map((v) => v.id))).toEqual([]);
    await expectNoHorizontalOverflow(page);
  });
});
