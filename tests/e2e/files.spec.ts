import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

const PHOTO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture-photo.jpg');

// One server for all tests: files are added once and checked from several accounts in order.
test.describe.configure({ mode: 'serial' });

test.describe('family files', () => {
  test('a family member uploads a private file, renames it and moves it to the trash', async ({ page }) => {
    await signIn(page, 'family', '/files');
    await expect(page.getByRole('heading', { level: 1, name: 'Файлы' })).toBeVisible();
    await page.getByLabel('Загрузить файлы').setInputFiles({
      name: 'список-покупок.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('молоко, хлеб'),
    });
    const item = page.locator('.files__item').filter({ hasText: 'список-покупок.txt' });
    await expect(item).toBeVisible();
    // The file comes back exactly as uploaded.
    const href = await item.locator('a.files__name').getAttribute('href');
    const res = await page.request.get(href ?? '');
    expect(await res.text()).toBe('молоко, хлеб');
    expect(res.headers()['content-disposition']).toMatch(/^attachment/);

    page.once('dialog', (d) => d.accept('покупки.txt'));
    await item.getByRole('button', { name: /Переименовать/ }).click();
    await expect(page.locator('.files__item').filter({ hasText: 'покупки.txt' })).toBeVisible();

    // A program is refused with an explanation.
    await page.getByLabel('Загрузить файлы').setInputFiles({
      name: 'игра.exe',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('MZ'),
    });
    await expect(page.getByText(/Программы и скрипты/)).toBeVisible();

    page.once('dialog', (d) => d.accept());
    await page
      .locator('.files__item')
      .filter({ hasText: 'покупки.txt' })
      .getByRole('button', { name: /В корзину/ })
      .click();
    await expect(page.getByRole('status').filter({ hasText: 'перемещён в корзину' })).toBeVisible();
    await expect(page.locator('.files__item').filter({ hasText: 'покупки.txt' })).toHaveCount(0);
  });

  test('a shared file is visible to everyone, a personal one only to its owner', async ({
    page,
    browser,
  }) => {
    await signIn(page, 'family', '/files');
    await page.getByRole('group', { name: 'Чьи файлы' }).getByRole('button', { name: 'Личное' }).click();
    await page.getByLabel('Загрузить файлы').setInputFiles({
      name: 'дневник.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('личное'),
    });
    await expect(page.locator('.files__item').filter({ hasText: 'дневник.txt' })).toBeVisible();
    await page.getByRole('group', { name: 'Чьи файлы' }).getByRole('button', { name: 'Общее' }).click();
    await page.getByLabel('Загрузить файлы').setInputFiles({
      name: 'расписание.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('общее'),
    });
    await expect(page.locator('.files__item').filter({ hasText: 'расписание.txt' })).toBeVisible();

    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    await signIn(admin, 'admin', '/files');
    await expect(admin.getByText('Здесь пока пусто')).toBeVisible();
    await expect(admin.locator('.files__item').filter({ hasText: 'дневник.txt' })).toHaveCount(0);
    await admin.getByRole('group', { name: 'Чьи файлы' }).getByRole('button', { name: 'Общее' }).click();
    await expect(admin.locator('.files__item').filter({ hasText: 'расписание.txt' })).toBeVisible();
    await adminContext.close();
  });
});

test.describe('family photos', () => {
  test('a photo is added from the device, gets a thumbnail and opens in the viewer', async ({ page }) => {
    await signIn(page, 'family', '/photos');
    await expect(page.getByRole('heading', { level: 1, name: 'Фото' })).toBeVisible();
    await page.getByLabel('Добавить фото и видео').setInputFiles(PHOTO);
    await expect(page.getByRole('status').filter({ hasText: 'Загружено 1 из 1' })).toBeVisible();
    // A month folder appears; inside it, the thumbnail made by this browser.
    await page.locator('.months__item').first().click();
    const thumb = page.locator('.gallery__item img');
    await expect(thumb).toBeVisible();
    await expect.poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await page.locator('.gallery__item').first().click();
    const viewer = page.getByRole('dialog');
    await expect(viewer.locator('img')).toBeVisible();
    await expect
      .poll(() => viewer.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(320);
    await viewer.getByRole('button', { name: 'Закрыть' }).click();
    await expect(viewer).toHaveCount(0);

    // Text pretending to be a photo is refused.
    await page.getByLabel('Добавить фото и видео').setInputFiles({
      name: 'fake.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('not really a photo'),
    });
    await expect(page.getByRole('status').filter({ hasText: 'только фотографии и видео' })).toBeVisible();
  });
});
