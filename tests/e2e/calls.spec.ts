import { type Browser, expect, type Page, test } from '@playwright/test';
import type { E2EUserKey } from './fixtures.ts';
import { signIn } from './helpers.ts';

/*
 * Real WebRTC between two browser windows on this PC: Chrome supplies a test camera and microphone,
 * the media goes directly between the two pages, the portal only introduces them. This proves the
 * signalling, the offer/answer exchange, ICE and the call screen. It does NOT prove a call between
 * two networks or countries — that needs two real devices (see docs/runbooks/calls.md).
 */
test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      // Real local addresses instead of .local names: the two windows find each other directly.
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  },
});

async function person(browser: Browser, who: E2EUserKey, to = '/chat') {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  await signIn(page, who, to);
  return { page, close: () => context.close() };
}

/** The open conversation (the list repeats the last line of every chat). */
const thread = (page: Page) => page.getByRole('region', { name: /^Чат: / });

async function openDirect(page: Page, name: string) {
  await page.getByRole('button', { name: 'Новый чат' }).click();
  await page.getByRole('dialog', { name: 'Новый чат' }).getByRole('button', { name }).click();
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
}

/** Both pages show a remote picture that really moves (width > 0 and the time advances). */
async function expectMedia(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const video = document.querySelector<HTMLVideoElement>('.call__tile video');
          return video ? video.videoWidth : 0;
        }),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  const moved = await page.evaluate(async () => {
    const video = document.querySelector<HTMLVideoElement>('.call__tile video');
    if (!video) return false;
    const before = video.currentTime;
    await new Promise((resolve) => setTimeout(resolve, 800));
    return video.currentTime > before;
  });
  expect(moved).toBe(true);
}

test.describe('calls between two people', () => {
  test('a video call: ringing, answering, picture both ways, mute, hang up, and a line in the chat', async ({
    browser,
  }) => {
    const mama = await person(browser, 'caller');
    const sasha = await person(browser, 'callee');
    try {
      await openDirect(mama.page, 'Отвечающий');
      await mama.page.getByRole('button', { name: 'Видео' }).click();

      // The caller sees that it is ringing; the other person gets a full-screen ring.
      await expect(mama.page.getByRole('region', { name: /Звонок: / }).getByText('Вызываем…')).toBeVisible();
      const ring = sasha.page.getByRole('alertdialog');
      await expect(ring).toContainText('Звонящий');
      await expect(ring).toContainText('Видеозвонок');
      await ring.getByRole('button', { name: 'Принять' }).click();

      const screenA = mama.page.getByRole('region', { name: /Звонок: / });
      const screenB = sasha.page.getByRole('region', { name: /Звонок: / });
      await expect(screenA.getByRole('status')).toContainText(/Соединение|Идёт разговор/, {
        timeout: 20_000,
      });
      await expect(screenB.getByRole('status')).toContainText(/Соединение|Идёт разговор/, {
        timeout: 20_000,
      });
      await expectMedia(mama.page);
      await expectMedia(sasha.page);
      // The self-view shows only for a video call and is muted (nobody hears themselves).
      await expect(mama.page.locator('.call__self video')).toHaveJSProperty('muted', true);

      const mute = screenA.getByRole('button', { name: 'Выключить звук' });
      await mute.click();
      await expect(screenA.getByRole('button', { name: 'Включить звук' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await screenA.getByRole('button', { name: 'Выключить камеру' }).click();
      await expect(screenA.getByRole('button', { name: 'Включить камеру' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      await screenA.getByRole('button', { name: 'Завершить' }).click();
      await expect(screenA).toBeHidden();
      await expect(sasha.page.getByRole('status').filter({ hasText: 'Звонок завершён.' })).toBeVisible();
      await expect(screenB).toBeHidden();
      await expect(thread(mama.page).getByText(/Видеозвонок завершён, длился/)).toBeVisible();
      await sasha.page.getByRole('link', { name: /Звонящий/ }).click();
      await expect(thread(sasha.page).getByText(/Видеозвонок завершён, длился/)).toBeVisible();
    } finally {
      await mama.close();
      await sasha.close();
    }
  });

  test('a voice call has no pictures; declining ends it for the caller with a note', async ({ browser }) => {
    const mama = await person(browser, 'caller');
    const sasha = await person(browser, 'callee');
    try {
      await openDirect(mama.page, 'Отвечающий');
      await mama.page.getByRole('button', { name: 'Позвонить' }).click();
      const ring = sasha.page.getByRole('alertdialog');
      await expect(ring).toContainText('Голосовой звонок');
      await ring.getByRole('button', { name: 'Отклонить' }).click();
      await expect(mama.page.getByRole('status').filter({ hasText: 'Звонок отклонён.' })).toBeVisible();
      await expect(thread(mama.page).getByText('Звонок отклонён.', { exact: true })).toBeVisible();

      // A second call, answered: no camera button, no self-view.
      await mama.page.getByRole('button', { name: 'Позвонить' }).click();
      await sasha.page.getByRole('alertdialog').getByRole('button', { name: 'Принять' }).click();
      const screen = mama.page.getByRole('region', { name: /Звонок: / });
      await expect(screen.getByRole('status')).toContainText(/Соединение|Идёт разговор/, { timeout: 20_000 });
      await expect(screen.getByRole('button', { name: /камеру/ })).toHaveCount(0);
      await expect(mama.page.locator('.call__self')).toHaveCount(0);
      await screen.getByRole('button', { name: 'Завершить' }).click();
      await expect(thread(mama.page).getByText(/Звонок завершён, длился/)).toBeVisible();
    } finally {
      await mama.close();
      await sasha.close();
    }
  });

  test('refuses politely when the camera and microphone are blocked, and the other person keeps ringing', async ({
    browser,
  }) => {
    const mama = await browser.newContext({ permissions: [] });
    const page = await mama.newPage();
    try {
      await page.addInitScript(() => {
        // The browser says «no» to the microphone.
        const denied = () =>
          Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
        Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: denied });
      });
      await signIn(page, 'caller', '/chat?c=family');
      await page.getByRole('button', { name: 'Позвонить' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'Нет доступа к микрофону' })).toBeVisible();
      await expect(page.getByRole('region', { name: /Звонок: / })).toHaveCount(0);
    } finally {
      await mama.close();
    }
  });
});
