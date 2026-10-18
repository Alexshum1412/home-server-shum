import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';
import { makeTorrent } from '../../server/test/fixtures/torrent-builder.ts';
import { makePng, SCENES } from './png.ts';

/*
 * The pictures of docs/FAMILY_USER_GUIDE.md. They are taken on a throwaway test server (mode «guide» of
 * tests/e2e/start-server.mjs): invented people, films, files and messages, a stand-in for Jellyfin and for
 * the torrent client. The «Состояние системы» page shows this PC's real readings. Nothing here touches the
 * real family data, and no real password, key or message is on any picture.
 *
 * Run: npm.cmd run build; npm.cmd run guide:screenshots
 */
test.describe.configure({ mode: 'serial' });

const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'docs',
  'images',
  'family-guide',
);
mkdirSync(OUT, { recursive: true });

const PEOPLE = {
  alex: { username: 'alex', password: 'guide-alex-password-1' },
  yulia: { username: 'yulia', password: 'guide-yulia-password-1' },
  vitalik: { username: 'vitalik', password: 'guide-vitalik-password-1' },
  sasha: { username: 'sasha', password: 'guide-sasha-password-1' },
} as const;
type Who = keyof typeof PEOPLE;

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

let browserRef: Browser;
const contexts = new Map<string, BrowserContext>();
const pages = new Map<string, Page>();

async function person(
  who: Who,
  options: { phone?: boolean; key?: string; userAgent?: string } = {},
): Promise<Page> {
  const key = options.key ?? who;
  const known = pages.get(key);
  if (known && !known.isClosed()) return known;
  const context = await browserRef.newContext({
    permissions: ['camera', 'microphone', 'notifications'],
    viewport: options.phone ? PHONE : DESKTOP,
    userAgent: options.userAgent,
    deviceScaleFactor: options.phone ? 2 : 1,
  });
  const page = await context.newPage();
  const res = await page.request.post('/api/login', { data: PEOPLE[who] });
  expect(res.status(), `login as ${who}`).toBe(200);
  contexts.set(key, context);
  pages.set(key, page);
  return page;
}

async function go(page: Page, to: string) {
  await page.goto(to);
  await page.waitForLoadState('networkidle');
}

async function shot(
  page: Page,
  name: string,
  options: { fullPage?: boolean; mask?: ReturnType<Page['locator']>[] } = {},
) {
  await page.screenshot({
    path: path.join(OUT, `${name}.png`),
    fullPage: options.fullPage ?? false,
    mask: options.mask,
  });
}

interface Conversation {
  id: string;
  kind: string;
  title: string;
}

async function api<T>(page: Page, method: 'get' | 'post' | 'put', url: string, data?: unknown): Promise<T> {
  const res = await page.request[method](url, { data });
  expect(res.status(), `${method} ${url}: ${await res.text()}`).toBeLessThan(300);
  return (await res.json()) as T;
}

test.beforeAll(async ({ browser }) => {
  browserRef = browser;
});

test.afterAll(async () => {
  for (const context of contexts.values()) await context.close();
});

test.describe('family guide pictures', () => {
  test('seed: messages, a photo in the chat, a group', async () => {
    const yulia = await person('yulia');
    const alex = await person('alex');
    const vitalik = await person('vitalik');
    const sasha = await person('sasha');

    const list = await api<{
      me: { id: string };
      conversations: Conversation[];
      people: Array<{ id: string; displayName: string }>;
    }>(yulia, 'get', '/api/chat/conversations');
    const idOf = (name: string) => {
      const found = list.people.find((item) => item.displayName === name);
      if (!found) throw new Error(`no person ${name}`);
      return found.id;
    };
    const family = list.conversations.find((item) => item.title === 'Вся семья' || item.id === 'family');
    expect(family, 'the family chat exists').toBeTruthy();
    const familyId = family?.id ?? 'family';
    const say = (page: Page, id: string, text: string) =>
      api(page, 'post', `/api/chat/conversations/${id}/messages`, { text });

    await say(yulia, familyId, 'Всем привет! Ужин в семь, приготовлю лазанью.');
    await say(vitalik, familyId, 'Я после тренировки, буду к половине восьмого.');
    await say(sasha, familyId, 'Мам, можно я позову Артёма?');
    await say(yulia, familyId, 'Можно. Фотографии с дачи уже в разделе «Фото».');

    const direct = await api<Conversation>(yulia, 'post', '/api/chat/conversations/direct', {
      userId: idOf('Алекс'),
    });
    await say(alex, direct.id, 'Юля, в «Кинотеатре» появился новый фильм — «Весёлые каникулы».');
    await say(yulia, direct.id, 'Спасибо! Вечером посмотрим всей семьёй.');
    const scene = SCENES.at(1);
    if (!scene) throw new Error('no sample scene');
    const sunset = makePng(640, 420, scene);
    const attach = await yulia.request.put(
      `/api/chat/conversations/${direct.id}/attachment?name=${encodeURIComponent('Закат на даче.png')}&size=${sunset.length}&text=${encodeURIComponent('Закат на даче')}`,
      { data: sunset, headers: { 'Content-Type': 'application/octet-stream', 'X-Upload': '1' } },
    );
    expect(attach.status(), await attach.text()).toBeLessThan(300);
    await say(alex, direct.id, 'Красота! Копия фотографий уже лежит и на запасном диске.');

    const dacha = await api<Conversation>(yulia, 'post', '/api/chat/conversations/group', {
      title: 'Дача',
      memberIds: [idOf('Алекс'), idOf('Виталик')],
    });
    await say(yulia, dacha.id, 'Список на выходные: шторы, краска, рассада.');
    await say(vitalik, dacha.id, 'Краску куплю в субботу.');
  });

  test('seed: files, photos and a second device', async () => {
    const yulia = await person('yulia');
    await go(yulia, '/files');
    await expect(yulia.getByRole('heading', { level: 1, name: 'Файлы' })).toBeVisible();
    for (const [name, text] of [
      ['Рецепт лазаньи.txt', 'Слои: тесто, соус, сыр. Печь 40 минут.'],
      ['Список на дачу.txt', 'шторы, краска, рассада'],
      ['Школа — расписание.txt', 'Понедельник: математика, литература.'],
    ] as const) {
      await yulia
        .getByLabel('Загрузить файлы')
        .setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
      await expect(yulia.locator('.files__item').filter({ hasText: name })).toBeVisible();
    }

    await go(yulia, '/photos');
    await expect(yulia.getByRole('heading', { level: 1, name: 'Фото' })).toBeVisible();
    await yulia.getByLabel('Добавить фото и видео').setInputFiles(
      SCENES.map((scene, index) => ({
        name: `Дача ${index + 1}.png`,
        mimeType: 'image/png',
        buffer: makePng(640, 420, scene),
      })),
    );
    await expect(yulia.getByRole('status').filter({ hasText: /Готово: 6 из 6/ })).toBeVisible({
      timeout: 60_000,
    });

    // A second sign-in of the same person, from «a phone»: the list of devices has two lines.
    await person('yulia', { key: 'yulia-phone', userAgent: IPHONE_UA });
  });

  test('seed: a torrent in the queue, one finished and one running', async () => {
    const alex = await person('alex');
    await go(alex, '/downloads');
    await expect(alex.getByRole('heading', { level: 1, name: 'Загрузки' })).toBeVisible();
    const add = async (name: string, files: Array<{ path: string[]; length: number }>, folder: RegExp) => {
      const torrent = makeTorrent({ name, files, announce: 'udp://tracker.example.org:6969/announce' });
      await alex.locator('input[type="file"]').setInputFiles({
        name: 'раздача.torrent',
        mimeType: 'application/x-bittorrent',
        buffer: torrent.bytes,
      });
      const confirm = alex.getByRole('group', { name: 'Подтверждение загрузки' });
      await expect(confirm.getByText('Скачать эту раздачу?')).toBeVisible();
      await confirm.getByLabel(folder).check();
      return { confirm, torrent };
    };
    const first = await add(
      'Пример фильма для семьи',
      [{ path: ['Фильм.mp4'], length: 8_000_000 }],
      /Общая медиатека → Фильмы/,
    );
    await shot(alex, '06a-downloads-confirm');
    await first.confirm.getByRole('button', { name: 'Скачать' }).click();
    await expect(alex.locator('li.download').filter({ hasText: 'Пример фильма для семьи' })).toBeVisible();
    await expect(
      alex.locator('li.download').filter({ hasText: 'Пример фильма для семьи' }).locator('.download__state'),
    ).toHaveText(/Готово/, { timeout: 40_000 });
    const second = await add(
      'Пример музыки для дороги',
      [{ path: ['Альбом', '01.mp3'], length: 40_000_000 }],
      /Общая медиатека → Музыка/,
    );
    await second.confirm.getByRole('button', { name: 'Скачать' }).click();
    await expect(alex.locator('li.download').filter({ hasText: 'Пример музыки для дороги' })).toBeVisible();
  });

  test('home, cinema, files, photos, Olivia, notifications, account: desktop', async () => {
    const yulia = await person('yulia');
    await go(yulia, '/');
    await expect(yulia.getByRole('heading', { level: 1 })).toBeVisible();
    await shot(yulia, '01-home');

    await go(yulia, '/cinema');
    await expect(yulia.getByRole('heading', { level: 1, name: 'Кинотеатр' })).toBeVisible();
    await expect(yulia.getByRole('link', { name: /Весёлые каникулы/ }).first()).toBeVisible();
    await shot(yulia, '02-cinema');
    await yulia
      .getByRole('link', { name: /Весёлые каникулы/ })
      .first()
      .click();
    await expect(yulia.getByRole('dialog')).toBeVisible();
    await shot(yulia, '03-cinema-film');

    await go(yulia, '/files');
    await expect(yulia.locator('.files__item').first()).toBeVisible();
    await shot(yulia, '05-files');

    await go(yulia, '/photos');
    await yulia.locator('.months__item').first().click();
    await expect(yulia.locator('.gallery__item img').first()).toBeVisible();
    await expect
      .poll(() =>
        yulia
          .locator('.gallery__item img')
          .first()
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBeGreaterThan(0);
    await shot(yulia, '06-photos');

    await go(yulia, '/olivia');
    const ask = async (text: string) => {
      await yulia.getByLabel('Вопрос Оливии').fill(text);
      await yulia.getByRole('button', { name: 'Спросить' }).click();
    };
    await ask('найди фильм про каникулы');
    await expect(yulia.locator('.olivia-card--poster').first()).toBeVisible();
    await ask('сколько места на диске?');
    await expect(yulia.locator('.olivia-turn').filter({ hasText: /Диск / }).last()).toBeVisible();
    await shot(yulia, '08-olivia');

    await go(yulia, '/notifications');
    await expect(yulia.getByRole('heading', { level: 1, name: 'Уведомления' })).toBeVisible();
    await shot(yulia, '10-notifications');

    await go(yulia, '/account');
    await expect(yulia.getByRole('heading', { level: 1 })).toBeVisible();
    await shot(yulia, '11-account', { fullPage: true });

    await go(yulia, '/help');
    await expect(yulia.getByRole('heading', { level: 1, name: 'Подключение' })).toBeVisible();
    await shot(yulia, '12-remote-access', { fullPage: true });
  });

  test('downloads queue and the chat', async () => {
    const alex = await person('alex');
    await go(alex, '/downloads');
    await expect(alex.locator('li.download').first()).toBeVisible();
    await shot(alex, '07-downloads-queue', { fullPage: true });

    const yulia = await person('yulia');
    await go(yulia, '/chat');
    await yulia.getByRole('link', { name: /Алекс/ }).first().click();
    await expect(
      yulia
        .getByRole('region', { name: /^Чат: / })
        .getByText('Закат на даче')
        .first(),
    ).toBeVisible();
    await expect
      .poll(() =>
        yulia
          .locator('img.msg__image')
          .first()
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBeGreaterThan(0);
    await shot(yulia, '09-chat');
  });

  test('a video call', async () => {
    const yulia = await person('yulia');
    const alex = await person('alex');
    await go(alex, '/chat');
    await go(yulia, '/chat');
    await yulia.getByRole('link', { name: /Алекс/ }).first().click();
    await yulia.getByRole('button', { name: 'Видео' }).click();
    const ring = alex.getByRole('alertdialog');
    await expect(ring).toContainText('Юлия');
    await shot(alex, '09b-call-incoming');
    await ring.getByRole('button', { name: 'Принять' }).click();
    const screen = yulia.getByRole('region', { name: /Звонок: / });
    await expect(screen.getByRole('status')).toContainText(/Соединение напрямую|Идёт разговор/, {
      timeout: 30_000,
    });
    await expect
      .poll(() =>
        yulia.evaluate(() => document.querySelector<HTMLVideoElement>('.call__tile video')?.videoWidth ?? 0),
      )
      .toBeGreaterThan(0);
    await yulia.waitForTimeout(1200);
    await shot(yulia, '09c-call');
    await screen.getByRole('button', { name: 'Завершить' }).click();
    await expect(screen).toBeHidden();
  });

  test('the phone: home, chat, cinema', async () => {
    const phone = await person('yulia', { phone: true, key: 'yulia-narrow' });
    await go(phone, '/');
    await shot(phone, '01m-home-phone');
    await go(phone, '/chat');
    await phone.getByRole('link', { name: /Алекс/ }).first().click();
    await expect(phone.getByRole('region', { name: /^Чат: / })).toBeVisible();
    await shot(phone, '09m-chat-phone');
    await go(phone, '/cinema');
    await expect(phone.getByRole('heading', { level: 1, name: 'Кинотеатр' })).toBeVisible();
    await shot(phone, '02m-cinema-phone');
  });

  test('administrator: users and monitoring', async () => {
    const alex = await person('alex');
    await go(alex, '/admin');
    await expect(alex.getByRole('heading', { level: 1 })).toBeVisible();
    await shot(alex, '13-admin-users', { fullPage: true });

    // The history and the network speed need two readings of the server, a minute apart.
    await expect
      .poll(
        async () => {
          const body = await (await alex.request.get('/api/system')).json();
          const rate = body.hardware?.network?.value?.find(
            (a: { physical: boolean }) => a.physical,
          )?.rxBytesPerSec;
          return typeof rate === 'number';
        },
        { timeout: 150_000, intervals: [5_000] },
      )
      .toBe(true);
    await go(alex, '/system');
    await expect(alex.getByRole('heading', { level: 2, name: 'Оборудование' })).toBeVisible();
    const hostname = alex.locator('.facts__row').filter({ hasText: 'Имя компьютера' }).locator('dd');
    await shot(alex, '14-monitoring', { fullPage: true, mask: [hostname] });
  });
});
