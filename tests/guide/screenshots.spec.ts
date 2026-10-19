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
  dmitry: { username: 'dmitry', password: 'guide-dmitry-password-1' },
  anna: { username: 'anna', password: 'guide-anna-password-1' },
  boris: { username: 'boris', password: 'guide-boris-password-1' },
  vera: { username: 'vera', password: 'guide-vera-password-1' },
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
    const anna = await person('anna');
    const dmitry = await person('dmitry');
    const boris = await person('boris');
    const vera = await person('vera');

    const list = await api<{
      me: { id: string };
      conversations: Conversation[];
      people: Array<{ id: string; displayName: string }>;
    }>(anna, 'get', '/api/chat/conversations');
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

    await say(anna, familyId, 'Всем привет! Ужин в семь, приготовлю лазанью.');
    await say(boris, familyId, 'Я после тренировки, буду к половине восьмого.');
    await say(vera, familyId, 'Мам, можно я позову Артёма?');
    await say(anna, familyId, 'Можно. Фотографии с дачи уже в разделе «Фото».');

    const direct = await api<Conversation>(anna, 'post', '/api/chat/conversations/direct', {
      userId: idOf('Дмитрий'),
    });
    await say(dmitry, direct.id, 'Аня, в «Кинотеатре» появился новый фильм — «Весёлые каникулы».');
    await say(anna, direct.id, 'Спасибо! Вечером посмотрим всей семьёй.');
    const scene = SCENES.at(1);
    if (!scene) throw new Error('no sample scene');
    const sunset = makePng(640, 420, scene);
    const attach = await anna.request.put(
      `/api/chat/conversations/${direct.id}/attachment?name=${encodeURIComponent('Закат на даче.png')}&size=${sunset.length}&text=${encodeURIComponent('Закат на даче')}`,
      { data: sunset, headers: { 'Content-Type': 'application/octet-stream', 'X-Upload': '1' } },
    );
    expect(attach.status(), await attach.text()).toBeLessThan(300);
    await say(dmitry, direct.id, 'Красота! Копия фотографий уже лежит и на запасном диске.');

    const dacha = await api<Conversation>(anna, 'post', '/api/chat/conversations/group', {
      title: 'Дача',
      memberIds: [idOf('Дмитрий'), idOf('Борис')],
    });
    await say(anna, dacha.id, 'Список на выходные: шторы, краска, рассада.');
    await say(boris, dacha.id, 'Краску куплю в субботу.');
  });

  test('seed: files, photos and a second device', async () => {
    const anna = await person('anna');
    await go(anna, '/files');
    await expect(anna.getByRole('heading', { level: 1, name: 'Файлы' })).toBeVisible();
    for (const [name, text] of [
      ['Рецепт лазаньи.txt', 'Слои: тесто, соус, сыр. Печь 40 минут.'],
      ['Список на дачу.txt', 'шторы, краска, рассада'],
      ['Школа — расписание.txt', 'Понедельник: математика, литература.'],
    ] as const) {
      await anna
        .getByLabel('Загрузить файлы')
        .setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
      await expect(anna.locator('.files__item').filter({ hasText: name })).toBeVisible();
    }

    await go(anna, '/photos');
    await expect(anna.getByRole('heading', { level: 1, name: 'Фото' })).toBeVisible();
    await anna.getByLabel('Добавить фото и видео').setInputFiles(
      SCENES.map((scene, index) => ({
        name: `Дача ${index + 1}.png`,
        mimeType: 'image/png',
        buffer: makePng(640, 420, scene),
      })),
    );
    await expect(anna.getByRole('status').filter({ hasText: /Загружено 6 файлов/ })).toBeVisible({
      timeout: 60_000,
    });

    // A second sign-in of the same person, from «a phone»: the list of devices has two lines.
    await person('anna', { key: 'anna-phone', userAgent: IPHONE_UA });
  });

  test('seed: a torrent in the queue, one finished and one running', async () => {
    const dmitry = await person('dmitry');
    await go(dmitry, '/downloads');
    await expect(dmitry.getByRole('heading', { level: 1, name: 'Загрузки' })).toBeVisible();
    const add = async (name: string, files: Array<{ path: string[]; length: number }>, folder: RegExp) => {
      const torrent = makeTorrent({ name, files, announce: 'udp://tracker.example.org:6969/announce' });
      await dmitry.locator('input[type="file"]').setInputFiles({
        name: 'раздача.torrent',
        mimeType: 'application/x-bittorrent',
        buffer: torrent.bytes,
      });
      const confirm = dmitry.getByRole('group', { name: 'Подтверждение загрузки' });
      await expect(confirm.getByText('Скачать эту раздачу?')).toBeVisible();
      await confirm.getByLabel(folder).check();
      return { confirm, torrent };
    };
    const first = await add(
      'Пример фильма для семьи',
      [{ path: ['Фильм.mp4'], length: 8_000_000 }],
      /Общая медиатека → Фильмы/,
    );
    await shot(dmitry, '06a-downloads-confirm');
    await first.confirm.getByRole('button', { name: 'Скачать' }).click();
    await expect(dmitry.locator('li.download').filter({ hasText: 'Пример фильма для семьи' })).toBeVisible();
    await expect(
      dmitry
        .locator('li.download')
        .filter({ hasText: 'Пример фильма для семьи' })
        .locator('.download__state'),
    ).toHaveText(/Готово/, { timeout: 40_000 });
    const second = await add(
      'Пример музыки для дороги',
      [{ path: ['Альбом', '01.mp3'], length: 40_000_000 }],
      /Общая медиатека → Музыка/,
    );
    await second.confirm.getByRole('button', { name: 'Скачать' }).click();
    await expect(dmitry.locator('li.download').filter({ hasText: 'Пример музыки для дороги' })).toBeVisible();
  });

  test('home, cinema, files, photos, Olivia, notifications, account: desktop', async () => {
    const anna = await person('anna');
    await go(anna, '/');
    await expect(anna.getByRole('heading', { level: 1 })).toBeVisible();
    await shot(anna, '01-home');

    await go(anna, '/cinema');
    await expect(anna.getByRole('heading', { level: 1, name: 'Кинотеатр' })).toBeVisible();
    await expect(anna.getByRole('link', { name: /Весёлые каникулы/ }).first()).toBeVisible();
    await shot(anna, '02-cinema');
    await anna
      .getByRole('link', { name: /Весёлые каникулы/ })
      .first()
      .click();
    await expect(anna.getByRole('dialog')).toBeVisible();
    await shot(anna, '03-cinema-film');

    await go(anna, '/files');
    await expect(anna.locator('.files__item').first()).toBeVisible();
    await shot(anna, '05-files');

    await go(anna, '/photos');
    await anna.locator('.months__item').first().click();
    await expect(anna.locator('.gallery__item img').first()).toBeVisible();
    await expect
      .poll(() =>
        anna
          .locator('.gallery__item img')
          .first()
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBeGreaterThan(0);
    await shot(anna, '06-photos');

    await go(anna, '/olivia');
    const ask = async (text: string) => {
      await anna.getByLabel('Вопрос Оливии').fill(text);
      await anna.getByRole('button', { name: 'Спросить' }).click();
    };
    await ask('найди фильм про каникулы');
    await expect(anna.locator('.olivia-card--poster').first()).toBeVisible();
    await ask('сколько места на диске?');
    await expect(anna.locator('.olivia-turn').filter({ hasText: /Диск / }).last()).toBeVisible();
    await shot(anna, '08-olivia');

    await go(anna, '/notifications');
    await expect(anna.getByRole('heading', { level: 1, name: 'Уведомления' })).toBeVisible();
    await shot(anna, '10-notifications');

    await go(anna, '/account');
    await expect(anna.getByRole('heading', { level: 1 })).toBeVisible();
    await shot(anna, '11-account', { fullPage: true });

    await go(anna, '/help');
    await expect(anna.getByRole('heading', { level: 1, name: 'Подключение' })).toBeVisible();
    await shot(anna, '12-remote-access', { fullPage: true });
  });

  test('search, tasks, cinema marks, albums, choosing files and the trash: desktop', async () => {
    const anna = await person('anna');
    const pad = (n: number) => String(n).padStart(2, '0');
    const day = (offset: number) => {
      const date = new Date();
      date.setDate(date.getDate() + offset);
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    };

    // Search (Ctrl+K) over films, photos, files, notes, events, tasks and chats.
    await anna.request.post('/api/notes/save', {
      data: { space: 'shared', name: 'Список для дачи', text: 'взять рассаду и лопату', revision: null },
    });
    await go(anna, '/');
    await anna.keyboard.press('Control+K');
    const search = anna.getByRole('dialog', { name: 'Поиск по порталу' });
    await expect(search).toBeVisible();
    await search.getByRole('searchbox', { name: 'Что найти' }).fill('дач');
    await expect(search.getByRole('status')).toContainText('Найдено', { timeout: 15_000 });
    await shot(anna, '15-search');
    await anna.keyboard.press('Escape');

    // Tasks: by date, one of them overdue.
    for (const body of [
      { title: 'Заплатить за свет', due: day(-2) },
      { title: 'Позвонить бабушке', due: day(0), dueTime: '19:00' },
      { title: 'Купить краску для дачи', due: day(1) },
      { title: 'Записаться к врачу' },
    ]) {
      const res = await anna.request.post('/api/tasks', { data: body });
      expect(res.status(), await res.text()).toBe(201);
    }
    await go(anna, '/tasks');
    await expect(anna.getByRole('heading', { level: 1, name: 'Дела' })).toBeVisible();
    await expect(anna.locator('.task').first()).toBeVisible();
    await shot(anna, '16-tasks', { fullPage: true });

    // Cinema: a heart and «watch later» build the person's own rows.
    await go(anna, '/cinema');
    await expect(anna.getByRole('link', { name: /Весёлые каникулы/ }).first()).toBeVisible();
    await anna.getByRole('button', { name: 'Избранное: Весёлые каникулы' }).first().click();
    await expect(anna.getByRole('button', { name: 'Избранное: Весёлые каникулы' }).first()).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await shot(anna, '20-cinema-marks');

    // Photos: the options of adding, and an album.
    await go(anna, '/photos');
    await anna.getByRole('button', { name: 'Новый альбом' }).click();
    await anna.getByLabel('Название альбома').fill('Дача, лето');
    await anna.getByRole('button', { name: 'Создать' }).click();
    await expect(anna.getByRole('heading', { level: 2, name: 'Дача, лето' })).toBeVisible();
    await anna.getByLabel('Добавить фото и видео').setInputFiles(
      SCENES.slice(0, 3).map((scene, index) => ({
        name: `Лето ${index + 1}.png`,
        mimeType: 'image/png',
        buffer: makePng(480, 320, scene),
      })),
    );
    await expect(anna.getByRole('status').filter({ hasText: /Загружено 3 файла/ })).toBeVisible({
      timeout: 60_000,
    });
    await expect(anna.locator('.gallery__item img').first()).toBeVisible();
    await go(anna, '/photos');
    await expect(anna.locator('.albums__item').first()).toBeVisible();
    await shot(anna, '17-photos-albums', { fullPage: true });

    // Files: several chosen at once, then the trash.
    await go(anna, '/files');
    await anna.getByLabel('Выбрать «Рецепт лазаньи.txt»').check();
    await anna.getByLabel('Выбрать «Список на дачу.txt»').check();
    await expect(anna.getByRole('group', { name: 'Действия с выбранным' })).toContainText(
      'Выбрано: 2 элемента',
    );
    await shot(anna, '18-files-select');
    anna.once('dialog', (d) => void d.accept());
    await anna
      .getByRole('group', { name: 'Действия с выбранным' })
      .getByRole('button', { name: /В корзину/ })
      .click();
    await expect(anna.getByRole('status').filter({ hasText: 'В корзину перемещено' })).toBeVisible();
    await anna.getByRole('button', { name: 'Корзина' }).click();
    const trash = anna.getByRole('dialog', { name: 'Корзина' });
    await expect(trash.locator('.trash-list__item').first()).toBeVisible();
    await shot(anna, '19-trash');
    // Put both back, so that the other pictures keep their files.
    for (const name of ['Рецепт лазаньи.txt', 'Список на дачу.txt']) {
      await trash.getByRole('button', { name: new RegExp(`Вернуть.*${name.replace('.', '\\.')}`) }).click();
      await expect(trash.locator('.trash-list__name', { hasText: name })).toHaveCount(0);
    }
    await trash.getByRole('button', { name: 'Закрыть' }).click();
  });
  test('downloads queue and the chat', async () => {
    const dmitry = await person('dmitry');
    await go(dmitry, '/downloads');
    await expect(dmitry.locator('li.download').first()).toBeVisible();
    await shot(dmitry, '07-downloads-queue', { fullPage: true });

    const anna = await person('anna');
    await go(anna, '/chat');
    await anna
      .getByRole('link', { name: /Дмитрий/ })
      .first()
      .click();
    await expect(
      anna
        .getByRole('region', { name: /^Чат: / })
        .getByText('Закат на даче')
        .first(),
    ).toBeVisible();
    await expect
      .poll(() =>
        anna
          .locator('img.msg__image')
          .first()
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBeGreaterThan(0);
    await shot(anna, '09-chat');
  });

  test('a video call', async () => {
    const anna = await person('anna');
    const dmitry = await person('dmitry');
    await go(dmitry, '/chat');
    await go(anna, '/chat');
    await anna
      .getByRole('link', { name: /Дмитрий/ })
      .first()
      .click();
    await anna.getByRole('button', { name: 'Видео' }).click();
    const ring = dmitry.getByRole('alertdialog');
    await expect(ring).toContainText('Анна');
    await shot(dmitry, '09b-call-incoming');
    await ring.getByRole('button', { name: 'Принять' }).click();
    const screen = anna.getByRole('region', { name: /Звонок: / });
    await expect(screen.getByRole('status')).toContainText(
      /Соединение напрямую|Соединение через Tailscale|Идёт разговор/,
      {
        timeout: 30_000,
      },
    );
    await expect
      .poll(() =>
        anna.evaluate(() => document.querySelector<HTMLVideoElement>('.call__tile video')?.videoWidth ?? 0),
      )
      .toBeGreaterThan(0);
    await anna.waitForTimeout(1200);
    await shot(anna, '09c-call');
    await screen.getByRole('button', { name: 'Завершить' }).click();
    await expect(screen).toBeHidden();
  });

  test('the phone: home, chat, cinema', async () => {
    const phone = await person('anna', { phone: true, key: 'anna-narrow' });
    await go(phone, '/');
    await shot(phone, '01m-home-phone');
    await go(phone, '/chat');
    await phone
      .getByRole('link', { name: /Дмитрий/ })
      .first()
      .click();
    await expect(phone.getByRole('region', { name: /^Чат: / })).toBeVisible();
    await shot(phone, '09m-chat-phone');
    await go(phone, '/cinema');
    await expect(phone.getByRole('heading', { level: 1, name: 'Кинотеатр' })).toBeVisible();
    await shot(phone, '02m-cinema-phone');
  });

  test('administrator: users and monitoring', async () => {
    const dmitry = await person('dmitry');
    await go(dmitry, '/admin');
    await expect(dmitry.getByRole('heading', { level: 1 })).toBeVisible();
    await shot(dmitry, '13-admin-users', { fullPage: true });

    // The history and the network speed need two readings of the server, a minute apart.
    await expect
      .poll(
        async () => {
          const body = await (await dmitry.request.get('/api/system')).json();
          const rate = body.hardware?.network?.value?.find(
            (a: { physical: boolean }) => a.physical,
          )?.rxBytesPerSec;
          return typeof rate === 'number';
        },
        { timeout: 150_000, intervals: [5_000] },
      )
      .toBe(true);
    await go(dmitry, '/system');
    await expect(dmitry.getByRole('heading', { level: 2, name: 'Оборудование' })).toBeVisible();
    const hostname = dmitry.locator('.facts__row').filter({ hasText: 'Имя компьютера' }).locator('dd');
    // The name of the computer in the tailnet, the printer (with a piece of its address) and the names of the network
    // adapters (a VPN product's name) belong to this house: they are painted over, as is the name of the computer.
    const tailnet = dmitry.locator('.facts__row').filter({ hasText: 'Имя в сети' }).locator('dd');
    const printer = dmitry
      .locator('.tile', { has: dmitry.getByText('Принтер', { exact: true }) })
      .locator('.tile__strong');
    const adapters = dmitry.locator('table.table--stack tbody th[scope="row"]');
    await shot(dmitry, '14-monitoring', { fullPage: true, mask: [hostname, tailnet, printer, adapters] });
  });
});
