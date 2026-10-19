import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { E2E_USERS } from './fixtures.ts';
import { expectNoHorizontalOverflow, mainNav, signIn } from './helpers.ts';

test.describe('the administrator’s «Сервер» page', () => {
  test('is for administrators only: a family member neither sees it in the menu nor gets its data', async ({
    page,
  }) => {
    await signIn(page, 'family', '/server');
    await expect(page.getByRole('heading', { level: 1, name: 'Сервер' })).toBeVisible();
    await expect(page.getByText('Раздел доступен только администраторам')).toBeVisible();
    await expect(mainNav(page).getByRole('link', { name: 'Сервер' })).toHaveCount(0);
    expect((await page.request.get('/api/admin/server')).status()).toBe(403);
    expect(
      (await page.request.post('/api/admin/server/action', { data: { action: 'recheck' } })).status(),
    ).toBe(403);
  });

  test('says honestly that the supervisor is not running and keeps the program buttons off', async ({
    page,
  }) => {
    await signIn(page, 'admin', '/');
    await mainNav(page).getByRole('link', { name: 'Сервер' }).click();
    await expect(page).toHaveURL(/\/server$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Сервер' })).toBeVisible();
    const programs = page.getByRole('region', { name: 'Программы сервера' });
    await expect(programs.getByText(/Супервизор не запущен/).first()).toBeVisible();
    // The four programs are listed; none of them can be started or stopped from here without the supervisor.
    for (const title of [
      'Портал (этот сайт)',
      'Кинотеатр (Jellyfin)',
      'Торрент-клиент (aria2)',
      'Языковая модель Оливии',
    ]) {
      await expect(programs.getByRole('heading', { name: title })).toBeVisible();
    }
    for (const button of await programs.getByRole('button').all()) await expect(button).toBeDisabled();
    // The rest of the page still works without it.
    await expect(page.getByRole('region', { name: 'Диски и резервные копии' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Последние ошибки' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Сделать копию сейчас' })).toBeVisible();
  });

  test('makes a report that can be copied or saved, with the names taken out', async ({ page }) => {
    await signIn(page, 'admin', '/server');
    const section = page.getByRole('region', { name: 'Отчёт для помощи' });
    await section.getByRole('button', { name: 'Составить отчёт' }).click();
    const text = section.getByRole('region', { name: 'Текст отчёта' });
    await expect(text).toContainText('Семейный сервер: отчёт для помощи');
    await expect(text).toContainText('Диски:');
    await expect(section.getByRole('status')).toContainText(/Убрано из отчёта|Убирать было нечего/);
    const content = (await text.textContent()) ?? '';
    for (const user of Object.values(E2E_USERS)) expect(content).not.toContain(user.username);

    const download = page.waitForEvent('download');
    await section.getByRole('button', { name: 'Скачать' }).click();
    expect((await download).suggestedFilename()).toMatch(/^otchet-servera-\d{4}-\d{2}-\d{2}\.txt$/);

    await section.getByRole('button', { name: 'Скопировать' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: /скопирован|Не удалось скопировать/ }),
    ).toBeVisible();
  });

  test('works on a phone: nothing sticks out and axe finds nothing', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, 'admin', '/server');
    await expect(page.getByRole('region', { name: 'Программы сервера' })).toBeVisible();
    await page.getByRole('button', { name: 'Составить отчёт' }).click();
    await expect(page.getByRole('region', { name: 'Текст отчёта' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
  });
});
