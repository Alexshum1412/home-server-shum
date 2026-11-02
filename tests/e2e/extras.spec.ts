import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, mainNav, signIn } from './helpers.ts';

test.describe.configure({ mode: 'serial' });

const day = (offset: number) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

test.describe('deadlines, digest, status, safety, switches', () => {
  test('a deadline is added, shown with the days left and removed', async ({ page }) => {
    await signIn(page, 'chatter', '/deadlines');
    await expect(page.getByRole('heading', { level: 1, name: 'Сроки и гарантии' })).toBeVisible();
    await page.getByLabel('Что это').fill('Страховка машины');
    await page.getByLabel('Дата окончания').fill(day(10));
    await page.getByRole('button', { name: 'Добавить', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Срок добавлен' })).toBeVisible();
    const item = page.locator('.deadline').filter({ hasText: 'Страховка машины' });
    await expect(item).toContainText('осталось 10 дн.');
    await expect(item).toContainText('личный');
    page.once('dialog', (d) => void d.accept());
    await item.getByRole('button', { name: /Убрать/ }).click();
    await expect(item).toHaveCount(0);
  });

  test('the morning digest can be made at once, from a template when no model answers', async ({ page }) => {
    await signIn(page, 'chatter', '/digest');
    await expect(page.getByRole('heading', { level: 1, name: 'Утренний дайджест' })).toBeVisible();
    await page.getByRole('button', { name: 'Сделать сейчас' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Дайджест готов' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('.digest')).toContainText('Доброе утро');
    await expect(page.locator('.digest')).toContainText('Хорошего дня');
    await expect(page.getByText('собран по шаблону')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Для администратора' })).toHaveCount(0);
  });

  test('«Что с сервером» is for everyone, «Безопасность» only for the administrator', async ({
    page,
    browser,
  }) => {
    await signIn(page, 'chatter', '/status');
    await expect(page.getByRole('heading', { level: 1, name: 'Что с сервером' })).toBeVisible();
    await expect(page.locator('.status-list__item').first()).toBeVisible();
    await page.goto('/safety');
    await expect(page.getByText('Раздел доступен только администраторам')).toBeVisible();
    const context = await browser.newContext();
    const admin = await context.newPage();
    await signIn(admin, 'admin', '/safety');
    await expect(admin.getByRole('heading', { level: 1, name: 'Безопасность' })).toBeVisible();
    await expect(admin.getByRole('heading', { level: 2, name: 'Журнал происшествий' })).toBeVisible();
    await admin.getByRole('button', { name: 'Создать приманки' }).click();
    await expect(admin.getByRole('status').filter({ hasText: 'Приманки созданы' })).toBeVisible();
    await expect(admin.getByText('Пароли от всего.txt')).toBeVisible();
    // opening a decoy is noticed
    const href = await (async () => {
      await admin.goto('/files?space=shared');
      return admin
        .locator('.files__item')
        .filter({ hasText: 'Пароли от всего.txt' })
        .locator('a.files__name')
        .getAttribute('href');
    })();
    expect((await admin.request.get(href ?? '')).status()).toBe(200);
    await admin.goto('/safety');
    await expect(admin.getByText(/Открыт файл-приманка/).first()).toBeVisible();
    await admin.getByRole('button', { name: 'Убрать приманки' }).click();
    await expect(admin.getByRole('status').filter({ hasText: 'Приманки убраны' })).toBeVisible();
    await context.close();
  });

  test('the administrator switches «Дела» off: the family loses the page and the menu entry, then it comes back', async ({
    page,
    browser,
  }) => {
    const context = await browser.newContext();
    const admin = await context.newPage();
    await signIn(admin, 'admin', '/admin');
    const box = admin.getByRole('checkbox', { name: /Дела/ }).first();
    await expect(box).toBeChecked();
    try {
      await box.click();
      await expect(admin.getByRole('status').filter({ hasText: 'выключена' })).toBeVisible();
      await signIn(page, 'family', '/tasks');
      await expect(page.getByText('Администратор отключил эту функцию')).toBeVisible();
      // the section stays (the calendar and the notes are on), but its tab «Дела и покупки» is gone
      await expect(mainNav(page).getByRole('link', { name: 'Дела' })).toHaveAttribute('href', '/calendar');
      await expect(
        page.getByRole('navigation', { name: 'Раздел «Дела»' }).getByRole('link', { name: 'Дела и покупки' }),
      ).toHaveCount(0);
      expect((await page.request.get('/api/tasks')).status()).toBe(403);
    } finally {
      if (!(await box.isChecked())) await box.click();
      await expect(box).toBeChecked();
    }
    await page.goto('/tasks');
    await expect(page.getByRole('heading', { level: 1, name: 'Дела' })).toBeVisible();
    await context.close();
  });

  test('the new pages fit a phone and have no serious accessibility violations', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'admin', '/deadlines');
    for (const path of ['/deadlines', '/digest', '/status', '/safety']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expectNoHorizontalOverflow(page);
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(bad.map((v) => `${path} ${v.id}: ${v.help}`)).toEqual([]);
    }
  });
});
