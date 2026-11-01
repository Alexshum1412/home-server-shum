import { expect, type Page } from '@playwright/test';
import { E2E_USERS, type E2EUserKey } from './fixtures.ts';

/** Signs in through the API (shares cookies with the page context), then opens `path`. */
export async function signIn(\n  page: Page,\n  who: E2EUserKey,\n  path = '/',\n  options: { firstTime?: boolean } = {},\n): Promise<void> {\n  const user = E2E_USERS[who];\n  // Most tests are not about the first-sign-in questions and the tour: they are answered and seen beforehand.\n  if (!options.firstTime) {\n    await page.addInitScript(() => {\n      try {\n        localStorage.setItem('fs-tour-seen-v1', '1');\n      } catch {\n        // no storage: the tour is simply offered\n      }\n    });\n  }
  const res = await page.request.post('/api/login', {
    data: { username: user.username, password: user.password },
  });
  expect(res.status(), `login as ${user.username}`).toBe(200);
  if (!options.firstTime) await page.request.post('/api/profile', { data: { onboarded: true } });
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
