import { expect, type Page } from '@playwright/test';
import { E2E_USERS, type E2EUserKey } from './fixtures.ts';

/** Signs in through the API (shares cookies with the page context), then opens `path`. */
export async function signIn(page: Page, who: E2EUserKey, path = '/'): Promise<void> {
  const user = E2E_USERS[who];
  const res = await page.request.post('/api/login', {
    data: { username: user.username, password: user.password },
  });
  expect(res.status(), `login as ${user.username}`).toBe(200);
  await page.goto(path);
}

/** Asserts there is no horizontal page overflow at the current viewport. */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth, `document is ${scrollWidth}px wide in a ${innerWidth}px viewport`).toBeLessThanOrEqual(
    innerWidth,
  );
}

/** The primary navigation landmark (sidebar on wide screens, tab bar on narrow ones). */
export function mainNav(page: Page) {
  return page.getByRole('navigation', { name: 'Основная навигация' });
}
