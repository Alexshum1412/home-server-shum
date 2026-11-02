import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, mainNav, signIn } from './helpers.ts';

test.describe.configure({ mode: 'serial' });

test.describe('the new menu, the first sign-in and the tour', () => {
  test('ten sections in the menu, tabs inside a section, old addresses still open', async ({ page }) => {
    await signIn(page, 'admin', '/notes');
    const names = await mainNav(page).getByRole('link').allTextContents();
    expect(names.map((name) => name.trim())).toEqual([
      'Главная',
      'Оливия',
      'Чат',
      'Уведомления',
      'Дела',
      'Медиа',
      'Загрузки',
      'Печать',
      'Сервер',
      'Мой профиль',
    ]);
    await expect(mainNav(page).getByRole('link', { name: 'Дела' })).toHaveAttribute('aria-current', 'page');
    const tabs = page.getByRole('navigation', { name: 'Раздел «Дела»' });
    await expect(tabs.getByRole('link')).toHaveText([
      'Дела и покупки',
      'Календарь',
      'Заметки',
      'Сроки и гарантии',
    ]);
    await expect(tabs.getByRole('link', { name: 'Заметки' })).toHaveAttribute('aria-current', 'page');
    await tabs.getByRole('link', { name: 'Календарь' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Календарь' })).toBeVisible();
    await page.goto('/server');
    await expect(
      page.getByRole('navigation', { name: 'Раздел «Сервер»' }).getByRole('link', { name: 'Безопасность' }),
    ).toBeVisible();
  });

  test('a family member sees fewer tabs in «Сервер» than an administrator', async ({ page }) => {
    await signIn(page, 'family', '/status');
    await expect(page.getByRole('navigation', { name: 'Раздел «Сервер»' }).getByRole('link')).toHaveText([
      'Что с сервером',
      'Подключение',
    ]);
  });

  test('the home page has the big buttons, not the status of the cinema', async ({ page }) => {
    await signIn(page, 'family', '/');
    const tiles = page.getByRole('navigation', { name: 'Разделы портала' });
    await expect(tiles.getByRole('link', { name: /Оливия/ })).toBeVisible();
    await expect(tiles.getByRole('link', { name: /Медиа/ })).toBeVisible();
    await expect(page.getByText('Сервисы', { exact: true })).toHaveCount(0);
  });

  test('at the first sign-in the person is asked about themselves, then the walk starts, and «Подсказки» shows it again', async ({
    page,
  }) => {
    await signIn(page, 'callee', '/', { firstTime: true });
    const dialog = page.getByRole('dialog', { name: 'Давайте познакомимся' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/Учу немецкий/).check();
    await dialog.getByRole('button', { name: 'Сохранить и продолжить' }).click();
    const tour = page.getByRole('dialog', { name: 'Добро пожаловать!' });
    await expect(tour).toBeVisible();
    await tour.getByRole('button', { name: 'Дальше' }).click();
    await expect(page.getByRole('dialog', { name: 'Главная' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // the answers were kept
    const profile = (await (await page.request.get('/api/profile')).json()) as {
      profile: { interests: string[]; onboarded: boolean };
    };
    expect(profile.profile).toMatchObject({ interests: ['german'], onboarded: true });
    // a second visit does not ask again, and the button brings the hints back
    await page.reload();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Подсказки: как пользоваться' }).click();
    await expect(page.getByRole('dialog', { name: 'Добро пожаловать!' })).toBeVisible();
  });

  test('on a phone the section hints name the tabs, and the pages fit', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'admin', '/photos');
    await page.getByRole('button', { name: 'Подсказки: как пользоваться' }).click();
    await expect(page.getByRole('dialog', { name: 'Раздел «Медиа»' })).toBeVisible();
    await page.getByRole('button', { name: 'Дальше' }).click();
    await expect(page.getByRole('dialog', { name: 'Кинотеатр' })).toBeVisible();
    await page.keyboard.press('Escape');
    for (const path of ['/', '/olivia', '/account', '/server']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expectNoHorizontalOverflow(page);
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(
        result.violations
          .filter((v) => v.impact === 'serious' || v.impact === 'critical')
          .map((v) => `${path} ${v.id}`),
      ).toEqual([]);
    }
  });

  test('Olivia talks: a server question gets an answer with cards, and a request to download by title is refused kindly', async ({
    page,
  }) => {
    await signIn(page, 'family', '/olivia');
    const box = page.getByLabel('Сообщение Оливии');
    await box.fill('Сколько места на диске?');
    await page.getByRole('button', { name: 'Отправить' }).click();
    await expect(page.locator('.olivia-turn').filter({ hasText: /Диск/ }).last()).toBeVisible({
      timeout: 20_000,
    });
    await box.fill('Скачай мне первый сезон Сумерек на русском');
    await page.keyboard.press('Enter');
    await expect(page.getByText(/не буду: так легко нарваться на пиратские копии/)).toBeVisible({
      timeout: 20_000,
    });
  });
});
