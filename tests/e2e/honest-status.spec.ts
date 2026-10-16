import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

// Real mode: no services are configured on the fresh test data dir, so the UI must say so
// instead of pretending anything works.
test.describe('honest states (real mode)', () => {
  test('cinema is not offered as a working link when it is not configured', async ({ page }) => {
    await signIn(page, 'family');
    await expect(page.getByRole('link', { name: 'Открыть кинотеатр' })).toHaveCount(0);
    await expect(page.getByText('Не настроено').first()).toBeVisible();
    await expect(page.getByText('Демо-режим')).toHaveCount(0);
  });

  test('missing backups are reported to the family', async ({ page }) => {
    await signIn(page, 'family');
    await expect(page.getByRole('region', { name: 'Важные сообщения' })).toContainText(
      'Резервные копии не настроены',
    );
  });

  test('system page shows "Нет данных" for the temperature, never 0', async ({ page }) => {
    await signIn(page, 'admin', '/system');
    await expect(page.getByRole('heading', { level: 1, name: 'Состояние системы' })).toBeVisible();
    const api = await (await page.request.get('/api/system')).json();
    expect(api.temperatureC.value).toBeNull();
    expect(api.backup.state).toBe('not_configured');
    expect(api.backup.restoreTested).toBe(false);
    await expect(page.getByText('Датчик температуры недоступен', { exact: false })).toBeVisible();
  });

  test('service API never marks unconfigured services as online or demo', async ({ page }) => {
    await signIn(page, 'family');
    const body = await (await page.request.get('/api/services')).json();
    for (const s of body.services) {
      expect(s.demo).toBe(false);
      if (s.openUrl === null) expect(s.state).toBe('not_configured');
    }
  });
});
