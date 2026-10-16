import { expect, test } from '@playwright/test';
import { signIn } from './helpers.ts';

// Demo mode server (port 8072): fake service states must be clearly labelled.
test.describe('demo mode', () => {
  test('shows a persistent demo banner and a working cinema link', async ({ page }) => {
    await signIn(page, 'family');
    await expect(page.getByText('Демо-режим', { exact: false }).first()).toBeVisible();
    const cinema = page.getByRole('link', { name: 'Открыть кинотеатр' });
    await expect(cinema).toBeVisible();
    await expect(cinema).toHaveAttribute('href', /^http:\/\/127\.0\.0\.1:8096/);
    await expect(cinema).toHaveAttribute('target', '_blank');
  });

  test('every service is flagged as demo in the API', async ({ page }) => {
    await signIn(page, 'family');
    const body = await (await page.request.get('/api/services')).json();
    expect(body.services.length).toBeGreaterThan(0);
    for (const s of body.services) expect(s.demo).toBe(true);
  });
});
