/**
 * The family's Telegram bot: a second way to the server from a phone. Long polling (the PC calls Telegram; nothing is
 * opened to the internet). A chat is served only after the person linked it with a one-time code made in the portal;
 * strangers are told nothing. The bot can talk to Olivia, prepare downloads (the button still decides), save photos and
 * files into the person's own folders, show the digest, the tasks of the day and the state of the server, and carries the
 * portal's notifications to the phone. Everything stays plain text: no markup that a name or a link could break.
 */
import { randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { DownloadCheckResponse, DownloadDestination, OliviaCard } from '../../../shared/api.ts';
import { hasPermission, type StoredUser, type UserStore } from '../auth/users.ts';
import type { Dossier } from '../family/dossier.ts';
import type { FamilyQuestion } from '../family/questions.ts';
import type { Clock } from '../lib/time.ts';
import type { OliviaChat } from '../olivia/chat.ts';
import type { ProfileStore } from '../profile/profiles.ts';

type Fetch = typeof fetch;

interface TgUser {
  id: number;
}
interface TgChat {
  id: number;
  type: string;
}
interface TgFile {
  file_id: string;
  file_size?: number;
  file_name?: string;
  mime_type?: string;
}
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  caption?: string;
  photo?: TgFile[];
  document?: TgFile;
  video?: TgFile;
  audio?: TgFile;
  voice?: TgFile;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; message?: TgMessage; data?: string };
}

type Button = { text: string; callback_data?: string; url?: string };

export interface BotDeps {
  tokenFile: string;
  clock: Clock;
  publicUrl: string;
  profiles: ProfileStore;
  users: Pick<UserStore, 'list' | 'findByUsername'>;
  chat: OliviaChat;
  /** The checks and starts of downloads (the same functions as the portal's buttons). */
  downloads: {
    isTorrentCheck: (id: string) => boolean;
    getCheck: (owner: string, id: string) => DownloadCheckResponse | null;
    add: (owner: string, checkId: string, destination: DownloadDestination) => Promise<unknown>;
  };
  storage: {
    mkdir: (
      loc: { root: 'files' | 'photos'; space: 'personal' | 'shared'; path: string },
      username: string,
      name: string,
    ) => Promise<unknown>;
    upload: (
      loc: { root: 'files' | 'photos'; space: 'personal' | 'shared'; path: string },
      username: string,
      name: string,
      size: number,
      body: NodeJS.ReadableStream,
      options?: { strip?: boolean },
    ) => Promise<{ name: string }>;
  };
  /** The family archive: questions and answers by voice, text and photos. */
  family: Dossier;
  /** Search and saving of the person's own knowledge: notes, saved pages, files. */
  knowledge: {
    search: (user: StoredUser, query: string) => Promise<string>;
    note: (user: StoredUser, text: string) => Promise<string>;
    save: (user: StoredUser, url: string) => Promise<string>;
    saved: (user: StoredUser) => Promise<string>;
  };
  deadlinesText: (user: StoredUser) => Promise<string>;
  /** Forgets the talk with Olivia. */
  resetChat: (user: StoredUser) => Promise<void>;
  /** Switches the morning digest of the person; returns the new state. */
  digestToggle: (user: StoredUser) => Promise<boolean>;
  digest: (user: StoredUser) => Promise<string>;
  tasksToday: (user: StoredUser) => Promise<string>;
  statusText: () => Promise<string>;
  fetch?: Fetch;
  onError?: (message: string) => void;
}

type MenuId =
  | 'main'
  | 'today'
  | 'olivia'
  | 'media'
  | 'downloads'
  | 'knowledge'
  | 'family'
  | 'server'
  | 'settings';

const BACK: Button = { text: '⬅ В главное меню', callback_data: 'm:main' };

/** The menus of the bot: the main one leads to the others (a button edits the same message, so the chat stays tidy). */
const MENUS: Record<MenuId, { title: string; rows: Button[][] }> = {
  main: {
    title: 'Что сделать? Выберите раздел или просто напишите мне.',
    rows: [
      [
        { text: '📰 Сегодня', callback_data: 'm:today' },
        { text: '🤖 Оливия', callback_data: 'm:olivia' },
      ],
      [
        { text: '🎬 Кино и музыка', callback_data: 'm:media' },
        { text: '📥 Загрузки', callback_data: 'm:downloads' },
      ],
      [
        { text: '📚 Знания и заметки', callback_data: 'm:knowledge' },
        { text: '👪 Семейный архив', callback_data: 'm:family' },
      ],
      [
        { text: '🖥 Сервер', callback_data: 'm:server' },
        { text: '⚙ Настройки', callback_data: 'm:settings' },
      ],
    ],
  },
  today: {
    title: '📰 Сегодня',
    rows: [
      [
        { text: '☀ Дайджест', callback_data: 'a:digest' },
        { text: '✅ Дела на сегодня', callback_data: 'a:tasks' },
      ],
      [
        { text: '📅 Календарь', callback_data: 'a:calendar' },
        { text: '🗞 Новости', callback_data: 'a:news' },
      ],
      [{ text: '⏳ Сроки и гарантии', callback_data: 'a:deadlines' }],
      [BACK],
    ],
  },
  olivia: {
    title: '🤖 Оливия: спросите о чём угодно. Выберите, с чего начать:',
    rows: [
      [
        { text: '🌐 Найти в интернете', callback_data: 'h:web' },
        { text: '🍲 Рецепт', callback_data: 'h:recipe' },
      ],
      [
        { text: '📖 Помощь с уроками', callback_data: 'h:homework' },
        { text: '✉ Написать текст', callback_data: 'h:write' },
      ],
      [{ text: '🧹 Начать разговор заново', callback_data: 'a:reset' }],
      [BACK],
    ],
  },
  media: {
    title: '🎬 Кино и музыка',
    rows: [
      [
        { text: '🔎 Найти в медиатеке', callback_data: 'h:film' },
        { text: '🆕 Что нового', callback_data: 'a:newmedia' },
      ],
      [
        { text: '▶ Открыть кинотеатр', callback_data: 'a:cinema' },
        { text: '📺 Как смотреть на ТВ', callback_data: 'a:tv' },
      ],
      [BACK],
    ],
  },
  downloads: {
    title: '📥 Загрузки',
    rows: [
      [
        { text: '⬇ Мои загрузки', callback_data: 'a:downloads' },
        { text: '🔗 Как скачать', callback_data: 'a:howdl' },
      ],
      [BACK],
    ],
  },
  knowledge: {
    title: '📚 Знания и заметки: найду в сохранённых страницах, заметках и файлах.',
    rows: [
      [
        { text: '🔍 Найти в моих знаниях', callback_data: 'h:kb' },
        { text: '📝 Новая заметка', callback_data: 'h:note' },
      ],
      [
        { text: '💾 Сохранить страницу', callback_data: 'h:save' },
        { text: '🗂 Что сохранено', callback_data: 'a:saved' },
      ],
      [BACK],
    ],
  },
  family: {
    title: '👪 Семейный архив: Оливия задаёт вопросы о жизни, а ответы остаются в памяти семьи.',
    rows: [
      [
        { text: '❓ Задать мне вопрос', callback_data: 'f:ask' },
        { text: '🔀 Другой вопрос', callback_data: 'f:another' },
      ],
      [
        { text: '✍ Ответить', callback_data: 'f:answer' },
        { text: '📜 Мои ответы', callback_data: 'f:mine' },
      ],
      [{ text: '🔕 Вопросы вкл/выкл', callback_data: 'f:toggle' }],
      [BACK],
    ],
  },
  server: {
    title: '🖥 Сервер',
    rows: [
      [
        { text: '📊 Что с сервером', callback_data: 'a:status' },
        { text: '💽 Место на диске', callback_data: 'a:disk' },
      ],
      [{ text: '💾 Резервные копии', callback_data: 'a:backup' }],
      [BACK],
    ],
  },
  settings: {
    title: '⚙ Настройки',
    rows: [
      [
        { text: '🔔 Уведомления сюда', callback_data: 'menu:notify' },
        { text: '☀ Дайджест вкл/выкл', callback_data: 'a:digesttoggle' },
      ],
      [{ text: '❓ Что я умею', callback_data: 'menu:help' }],
      [BACK],
    ],
  },
};
const MENU: Button[][] = MENUS.main.rows;

/** What a hint button asks the person to write; the next text is handled accordingly. */
const HINTS: Record<string, { ask: string; prefix: (text: string) => string | null; once?: true }> = {
  web: { ask: 'Что найти в интернете? Напишите вопрос.', prefix: (t) => `найди в интернете ${t}` },
  recipe: { ask: 'Что хотите приготовить или из чего? Напишите.', prefix: (t) => `Предложи рецепт: ${t}` },
  homework: {
    ask: 'Пришлите задание текстом — решим по шагам и объясним.',
    prefix: (t) => `Помоги с домашним заданием, объясни по шагам: ${t}`,
  },
  write: {
    ask: 'Что написать? Например: «письмо в школу о болезни ребёнка».',
    prefix: (t) => `Напиши: ${t}`,
  },
  film: { ask: 'Что искать в медиатеке? Название или тема.', prefix: (t) => `найди фильм ${t}` },
  kb: { ask: 'Что искать в ваших заметках, сохранённых страницах и файлах?', prefix: () => null },
  note: { ask: 'Пришлите текст заметки — я её сохраню.', prefix: () => null },
  save: { ask: 'Пришлите ссылку на страницу — сохраню её в архив.', prefix: () => null },
};

const HELP =
  'Я Оливия, помощница семейного сервера. Что можно:\n' +
  '• написать мне вопрос — отвечу (рецепт, объяснение, задача, «найди в интернете …», «что в новостях»);\n' +
  '• прислать ссылку на файл или магнитную ссылку — проверю и скачаю по вашей кнопке «Скачать»;\n' +
  '• прислать ссылку на страницу — перескажу её;\n' +
  '• прислать фото, видео или файл — сохраню у вас в портале (папка «Из Telegram»); подпись «в альбом Дача» положит фото в этот альбом, «общее» — в общие файлы;\n' +
  '• /menu — кнопки: дайджест, дела, состояние сервера, загрузки.\n' +
  'Торренты сама по названию я не ищу: пришлите ссылку или магнитную ссылку.';

const URL_RE = /(magnet:\?[^\s<>"']+|https?:\/\/[^\s<>"']+)/i;

/** The digest as Telegram HTML: the heading line of every block in bold; everything else is escaped text. */
export function digestHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n');
      const heading = lines[0] ?? '';
      return lines.length > 1 && (lines[1] ?? '').startsWith('•')
        ? [`<b>${esc(heading)}</b>`, ...lines.slice(1).map(esc)].join('\n')
        : esc(block);
    })
    .join('\n\n');
}

export function splitMessage(text: string, size = 3800): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = rest.lastIndexOf(' ', size);
    if (cut < size / 2) cut = size;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest !== '') parts.push(rest);
  return parts;
}

/** The first line of a caption that names a place: «в альбом Дача», «общее». */
export function placeFromCaption(caption: string): { shared: boolean; album: string | null } {
  const album =
    /в\s+альбом\s+(.{1,60})/i
      .exec(caption)?.[1]
      ?.trim()
      .replace(/[\\/:*?"<>|]/g, '') || null;
  return { shared: /(?:^|\s)общ/i.test(caption), album };
}

export function createTelegramBot(deps: BotDeps) {
  const fetchImpl = deps.fetch ?? fetch;
  let token: string | null = null;
  let botName: string | null = null;
  let running = false;
  let controller: AbortController | null = null;
  const codes = new Map<string, { username: string; expires: number }>();
  const attempts = new Map<number, { count: number; since: number }>();
  const pending = new Map<string, { chatId: number; url: string }>();
  const recent = new Map<number, number[]>();
  let pendingSeq = 0;
  /** One-shot «the next text is …» (a hint button) and the family answer in progress. */
  const modes = new Map<number, { kind: string; until: number }>();
  const answering = new Map<number, { entryId: string | null; until: number }>();

  async function api<T>(method: string, body: object, signal?: AbortSignal, ms = 30_000): Promise<T | null> {
    if (!token) return null;
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(ms),
      });
      const json = (await response.json()) as { ok: boolean; result: T };
      return json.ok ? json.result : null;
    } catch {
      return null;
    }
  }

  async function send(
    chatId: number | string,
    text: string,
    rows?: Button[][],
    html = false,
  ): Promise<boolean> {
    const parts = splitMessage(text === '' ? '…' : text);
    let ok = true;
    for (const [index, part] of parts.entries()) {
      const last = index === parts.length - 1;
      const result = await api('sendMessage', {
        chat_id: chatId,
        text: part,
        disable_web_page_preview: true,
        ...(html ? { parse_mode: 'HTML' } : {}),
        ...(last && rows ? { reply_markup: { inline_keyboard: rows } } : {}),
      });
      ok = ok && result !== null;
      // Markup that Telegram refuses is not lost: the same text goes once more as plain words.
      if (html && result === null) {
        const plain = await api('sendMessage', {
          chat_id: chatId,
          text: part.replace(/<\/?b>/g, ''),
          disable_web_page_preview: true,
        });
        ok = ok || plain !== null;
      }
    }
    return ok;
  }

  const typing = (chatId: number) => {
    void api('sendChatAction', { chat_id: chatId, action: 'typing' });
    const timer = setInterval(() => void api('sendChatAction', { chat_id: chatId, action: 'typing' }), 4500);
    return () => clearInterval(timer);
  };

  /** A menu: new message, or (when the tap came from a menu message) the same message edited. */
  async function showMenu(chatId: number | string, id: MenuId, messageId?: number): Promise<void> {
    const menu = MENUS[id];
    if (messageId !== undefined) {
      const edited = await api('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: menu.title,
        reply_markup: { inline_keyboard: menu.rows },
      });
      if (edited !== null) return;
    }
    await send(chatId, menu.title, menu.rows);
  }

  const FAMILY_ROWS: Button[][] = [
    [
      { text: '✍ Ответить', callback_data: 'f:answer' },
      { text: '🔀 Другой вопрос', callback_data: 'f:another' },
    ],
    [{ text: '⏸ Не сейчас', callback_data: 'f:later' }],
  ];

  async function sendQuestion(chatId: number | string, question: FamilyQuestion, reminder: boolean) {
    await send(
      chatId,
      `${reminder ? '🕊 Напоминаю о вопросе' : '🕊 Вопрос от Оливии'}\n\n${question.text}\n\nМожно ответить текстом, голосовым сообщением или фото, когда будет время: нажмите «Ответить».`,
      FAMILY_ROWS,
    );
  }

  /** Bytes of a file of the chat (a photo, a voice message) into the archive entry. */
  async function attachFromTelegram(
    user: StoredUser,
    chatId: number,
    message: TgMessage,
    entryId: string,
  ): Promise<boolean> {
    const photo = message.photo?.at(-1);
    const doc = message.voice ?? message.audio ?? message.video ?? message.document;
    const file = photo ?? doc;
    if (!file) return false;
    if ((file.file_size ?? 0) > 20 * 1024 * 1024) {
      await send(
        chatId,
        'Эта запись больше 20 МБ: Telegram не даёт боту её скачать. Запишите покороче или загрузите через портал («Семейный архив»).',
      );
      return false;
    }
    const info = await api<{ file_path: string }>('getFile', { file_id: file.file_id });
    if (!info?.file_path) return false;
    const stamp = deps.clock().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const ext = info.file_path.includes('.')
      ? info.file_path.slice(info.file_path.lastIndexOf('.'))
      : photo
        ? '.jpg'
        : '.oga';
    const name = `${doc?.file_name ?? `telegram-${stamp}`}${doc?.file_name ? '' : ext}`;
    try {
      const response = await fetchImpl(`https://api.telegram.org/file/bot${token}/${info.file_path}`, {
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok || !response.body) throw new Error('download failed');
      const size = file.file_size ?? Number(response.headers.get('content-length') ?? 0);
      await deps.family.attach(user.username, entryId, name, size, Readable.fromWeb(response.body as never));
      return true;
    } catch (error) {
      await send(chatId, `Не получилось сохранить: ${error instanceof Error ? error.message : 'ошибка'}`);
      return false;
    }
  }

  /** A text, a voice message or a photo while the person is answering: the first creates the entry, the others join it. */
  async function takeAnswer(user: StoredUser, chatId: number, message: TgMessage): Promise<void> {
    const state = answering.get(chatId);
    if (!state) return;
    state.until = deps.clock().getTime() + 60 * 60_000;
    const text = (message.text ?? message.caption ?? '').trim();
    try {
      if (state.entryId === null) {
        const entry = await deps.family.answer(user.username, { text, source: 'telegram' });
        state.entryId = entry.id;
      } else if (text !== '') {
        await deps.family.addText(user.username, state.entryId, text);
      }
      let stored = text !== '';
      if (message.photo || message.voice || message.audio || message.video || message.document)
        stored = (await attachFromTelegram(user, chatId, message, state.entryId)) || stored;
      if (stored)
        await send(
          chatId,
          'Записала ✅ Можно добавить ещё голосовое, фото или слова. Когда закончите — «Готово».',
          [[{ text: '✅ Готово', callback_data: 'f:done' }]],
        );
    } catch (error) {
      answering.delete(chatId);
      await send(chatId, error instanceof Error ? error.message : 'Не получилось сохранить ответ.');
    }
  }

  /** Not more than 20 messages a minute from one chat. */
  function tooFast(chatId: number): boolean {
    const now = deps.clock().getTime();
    const list = (recent.get(chatId) ?? []).filter((at) => now - at < 60_000);
    list.push(now);
    recent.set(chatId, list);
    return list.length > 20;
  }

  async function userOfChat(chatId: number): Promise<StoredUser | null> {
    const username = await deps.profiles.findByChat(String(chatId));
    return username ? ((await deps.users.findByUsername(username)) ?? null) : null;
  }

  function cardsToText(cards: OliviaCard[]): { text: string; rows: Button[][] } {
    const lines: string[] = [];
    const rows: Button[][] = [];
    for (const card of cards.slice(0, 8)) {
      if (card.kind === 'download-check') {
        const check = card.check;
        lines.push(
          `⬇ ${check.fileName}${check.sizeBytes ? `, ${(check.sizeBytes / 1024 ** 2).toFixed(0)} МБ` : ''}`,
        );
        if (check.status === 'ready') {
          rows.push([
            { text: `⬇ Скачать «${check.fileName.slice(0, 40)}»`, callback_data: `dl:${check.checkId}` },
          ]);
        } else if (check.status === 'failed') lines.push(check.error ?? 'Проверка не удалась.');
        else lines.push('Раздача ещё проверяется, спросите ещё раз через минуту.');
      } else if (card.kind === 'event') lines.push(`📅 ${card.when}: ${card.title}`);
      else if (card.kind === 'link') lines.push(`🔗 ${card.label}: ${deps.publicUrl}${card.href}`);
      else if ('title' in card && typeof card.title === 'string') lines.push(`• ${card.title}`);
    }
    return { text: lines.join('\n'), rows };
  }

  async function ask(user: StoredUser, chatId: number, message: string) {
    const stop = typing(chatId);
    try {
      const result = await deps.chat.converse(user, message, { smart: true });
      if (result.kind === 'tool') {
        const extra = cardsToText(result.answer.cards);
        await send(
          chatId,
          [result.answer.reply, extra.text].filter(Boolean).join('\n\n'),
          extra.rows.length > 0 ? extra.rows : undefined,
        );
      } else {
        await send(chatId, result.text);
      }
    } catch (error) {
      deps.onError?.(`Бот Telegram: ответ не получился: ${String(error)}`);
      await send(chatId, 'Не получилось ответить: что-то пошло не так. Попробуйте ещё раз чуть позже.');
    } finally {
      stop();
    }
  }

  async function startDownload(user: StoredUser, chatId: number, checkId: string) {
    if (!hasPermission(user, 'downloads')) {
      await send(chatId, 'У вас нет права на загрузки. Попросите администратора выдать его.');
      return;
    }
    try {
      const check = deps.downloads.getCheck(user.username, checkId);
      const destination = (check?.destinations[0]?.id ?? 'personal') as DownloadDestination;
      await deps.downloads.add(user.username, checkId, destination);
      await send(chatId, 'Поставила в очередь загрузок. Когда будет готово, пришлю уведомление.');
    } catch (error) {
      await send(chatId, error instanceof Error ? error.message : 'Не получилось начать загрузку.');
    }
  }

  async function saveFile(user: StoredUser, chatId: number, message: TgMessage) {
    const photo = message.photo?.at(-1);
    const doc = message.document ?? message.video ?? message.audio ?? message.voice;
    const file = photo ?? doc;
    if (!file) return;
    if ((file.file_size ?? 0) > 20 * 1024 * 1024) {
      await send(
        chatId,
        'Этот файл больше 20 МБ: Telegram не позволяет боту его скачать. Загрузите его через портал (раздел «Медиа»).',
      );
      return;
    }
    const info = await api<{ file_path: string }>('getFile', { file_id: file.file_id });
    if (!info?.file_path) {
      await send(chatId, 'Telegram не отдал файл. Попробуйте прислать его ещё раз.');
      return;
    }
    const mime = doc?.mime_type ?? (photo ? 'image/jpeg' : '');
    const isMedia = photo !== undefined || /^(image|video)\//.test(mime);
    const place = placeFromCaption(message.caption ?? '');
    const space = place.shared ? 'shared' : 'personal';
    const stamp = deps.clock().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const ext = info.file_path.includes('.')
      ? info.file_path.slice(info.file_path.lastIndexOf('.'))
      : photo
        ? '.jpg'
        : '';
    const name = doc?.file_name ?? `telegram-${stamp}${ext}`;
    const root = isMedia ? 'photos' : 'files';
    const folder = isMedia ? ['Альбомы', place.album ?? 'Из Telegram'] : ['Из Telegram'];
    let at = '';
    for (const part of folder) {
      await deps.storage.mkdir({ root, space, path: at }, user.username, part).catch(() => undefined);
      at = at === '' ? part : `${at}/${part}`;
    }
    try {
      const response = await fetchImpl(`https://api.telegram.org/file/bot${token}/${info.file_path}`, {
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok || !response.body) throw new Error('download failed');
      const size = file.file_size ?? Number(response.headers.get('content-length') ?? 0);
      const saved = await deps.storage.upload(
        { root, space, path: at },
        user.username,
        name,
        size,
        Readable.fromWeb(response.body as never),
        { strip: true },
      );
      await send(
        chatId,
        `Сохранила: «${saved.name}» → ${isMedia ? 'Фото' : 'Файлы'} → ${space === 'shared' ? 'Общее' : 'Личное'} → ${folder.join(' → ')}.`,
      );
    } catch (error) {
      await send(
        chatId,
        `Не получилось сохранить файл: ${error instanceof Error ? error.message : 'ошибка'}`,
      );
    }
  }

  async function onText(user: StoredUser, chatId: number, text: string) {
    if (/^\/(start|menu|меню)\b/i.test(text) || /^меню$/i.test(text)) {
      modes.delete(chatId);
      await send(chatId, `Здравствуйте, ${user.displayName}! ${MENUS.main.title}`, MENU);
      return;
    }
    if (/^\/family\b/i.test(text)) {
      await onFamily(user, chatId, 'ask');
      return;
    }
    if (answering.has(chatId)) {
      await takeAnswer(user, chatId, { message_id: 0, chat: { id: chatId, type: 'private' }, text });
      return;
    }
    const mode = modes.get(chatId);
    if (mode) {
      modes.delete(chatId);
      if (mode.until > deps.clock().getTime()) {
        if (mode.kind === 'kb') return void (await send(chatId, await deps.knowledge.search(user, text)));
        if (mode.kind === 'note') return void (await send(chatId, await deps.knowledge.note(user, text)));
        if (mode.kind === 'save') {
          const stop = typing(chatId);
          try {
            return void (await send(chatId, await deps.knowledge.save(user, text)));
          } finally {
            stop();
          }
        }
        const prefix = HINTS[mode.kind]?.prefix(text);
        if (prefix) return void (await ask(user, chatId, prefix));
      }
    }
    if (/^\/help\b/i.test(text)) {
      await send(chatId, HELP, MENU);
      return;
    }
    const link = URL_RE.exec(text)?.[0];
    if (link && !/^magnet:/i.test(link) && !/\.torrent(\?|$)/i.test(link)) {
      // A page or a file: what to do with it is the person's choice.
      const id = String(++pendingSeq);
      pending.set(id, { chatId, url: link });
      if (pending.size > 200) pending.delete(pending.keys().next().value as string);
      await send(chatId, 'Что сделать с этой ссылкой?', [
        [
          { text: '📄 Пересказать страницу', callback_data: `link:sum:${id}` },
          { text: '⬇ Скачать как файл', callback_data: `link:dl:${id}` },
        ],
        [{ text: '✖ Ничего', callback_data: 'noop' }],
      ]);
      return;
    }
    await ask(user, chatId, text);
  }

  async function onAction(user: StoredUser, chatId: number, action: string): Promise<void> {
    const say = (text: string) => ask(user, chatId, text);
    const link = (path: string) => `${deps.publicUrl}${path}`;
    switch (action) {
      case 'digest':
        return onCallback(user, chatId, 'menu:digest');
      case 'tasks':
        return onCallback(user, chatId, 'menu:tasks');
      case 'status':
        return onCallback(user, chatId, 'menu:status');
      case 'downloads':
        return onCallback(user, chatId, 'menu:downloads');
      case 'calendar':
        return say('что у нас в календаре на этой неделе');
      case 'news':
        return say('что в новостях сегодня');
      case 'deadlines':
        return void (await send(chatId, await deps.deadlinesText(user)));
      case 'disk':
        return say('сколько места на диске');
      case 'backup':
        return say('что с резервными копиями');
      case 'newmedia':
        return say('покажи новое в кинотеатре');
      case 'cinema':
        return void (await send(chatId, `🎬 Кинотеатр: ${link('/cinema')}`));
      case 'tv':
        return void (await send(
          chatId,
          `📺 На телевизоре откройте приложение Plex (или Jellyfin, если оно у вас работает) и войдите на сервер. Подробные шаги — в портале: ${link('/help')}`,
        ));
      case 'howdl':
        return void (await send(
          chatId,
          'Пришлите мне ссылку на файл, магнитную ссылку или файл .torrent — я проверю и предложу кнопку «Скачать». По названию раздачи я сама не ищу.',
        ));
      case 'saved':
        return void (await send(chatId, await deps.knowledge.saved(user)));
      case 'reset':
        await deps.resetChat(user);
        return void (await send(chatId, 'Начали разговор заново, прежнее я забыла.'));
      case 'digesttoggle': {
        const on = await deps.digestToggle(user);
        return void (await send(chatId, on ? 'Утренний дайджест включён.' : 'Утренний дайджест выключен.'));
      }
      default:
        return;
    }
  }

  async function onFamily(user: StoredUser, chatId: number, action: string): Promise<void> {
    const now = deps.clock().getTime();
    if (action === 'ask' || action === 'another') {
      const state = await deps.family.state(user.username);
      if (action === 'ask' && state.current)
        return void (await sendQuestion(chatId, state.current.question, false));
      const question = await deps.family.askNow(user.username, action === 'another');
      if (!question)
        return void (await send(chatId, 'Все мои вопросы к вам уже заданы — спасибо, что отвечали!'));
      return void (await sendQuestion(chatId, question, false));
    }
    if (action === 'answer') {
      const state = await deps.family.state(user.username);
      if (!state.current)
        return void (await send(chatId, 'Сейчас вопроса нет. Нажмите «Задать мне вопрос».'));
      answering.set(chatId, { entryId: null, until: now + 60 * 60_000 });
      return void (await send(
        chatId,
        'Слушаю. Пришлите ответ: текстом, голосовым сообщением, фото или всем сразу. Когда закончите — нажмите «Готово».',
        [[{ text: '✅ Готово', callback_data: 'f:done' }]],
      ));
    }
    if (action === 'done') {
      answering.delete(chatId);
      return void (await send(
        chatId,
        'Спасибо, это сохранено в семейном архиве. Следующий вопрос будет через несколько дней.',
        [[BACK]],
      ));
    }
    if (action === 'later') {
      await deps.family.skip(user.username);
      return void (await send(chatId, 'Хорошо, этот вопрос пропустим. Задам другой через несколько дней.'));
    }
    if (action === 'mine') {
      const state = await deps.family.state(user.username);
      const lines = state.entries
        .slice(0, 10)
        .map(
          (e) =>
            `• ${e.at.slice(0, 10)} — ${e.question.slice(0, 70)}${e.media.length > 0 ? ` (вложений: ${e.media.length})` : ''}`,
        );
      return void (await send(
        chatId,
        lines.length > 0
          ? `Ваши ответы (всего ${state.entries.length}, осталось вопросов: ${state.remaining}):\n${lines.join('\n')}`
          : 'Ответов пока нет.',
      ));
    }
    if (action === 'toggle') {
      const state = await deps.family.state(user.username);
      await deps.family.setEnabled(user.username, !state.enabled);
      return void (await send(
        chatId,
        state.enabled
          ? 'Вопросы выключены.'
          : 'Вопросы включены: следующий пришлю в течение нескольких дней.',
      ));
    }
  }

  async function onCallback(user: StoredUser, chatId: number, data: string, messageId?: number) {
    if (data.startsWith('m:')) {
      const id = data.slice(2) as MenuId;
      if (MENUS[id]) await showMenu(chatId, id, messageId);
      return;
    }
    if (data.startsWith('a:')) return onAction(user, chatId, data.slice(2));
    if (data.startsWith('f:')) return onFamily(user, chatId, data.slice(2));
    if (data.startsWith('h:')) {
      const kind = data.slice(2);
      const hint = HINTS[kind];
      if (!hint) return;
      modes.set(chatId, { kind, until: deps.clock().getTime() + 10 * 60_000 });
      await send(chatId, hint.ask);
      return;
    }
    if (data === 'menu:digest') {
      const stop = typing(chatId);
      try {
        await send(chatId, await deps.digest(user));
      } finally {
        stop();
      }
    } else if (data === 'menu:tasks') await send(chatId, await deps.tasksToday(user));
    else if (data === 'menu:status') await send(chatId, await deps.statusText());
    else if (data === 'menu:downloads') await ask(user, chatId, 'что с моими загрузками');
    else if (data === 'menu:help') await send(chatId, HELP, MENU);
    else if (data === 'menu:notify') {
      const profile = await deps.profiles.get(user.username);
      const next = !profile.telegramNotify;
      await deps.profiles.update(user.username, { telegramNotify: next });
      await send(
        chatId,
        next
          ? 'Уведомления портала буду присылать сюда.'
          : 'Уведомления сюда больше не приходят (дайджест и ответы — как раньше).',
      );
    } else if (data.startsWith('dl:')) await startDownload(user, chatId, data.slice(3));
    else if (data.startsWith('link:')) {
      const [, action, id] = data.split(':');
      const item = id ? pending.get(id) : undefined;
      if (!item || item.chatId !== chatId) {
        await send(chatId, 'Эта кнопка устарела: пришлите ссылку ещё раз.');
        return;
      }
      pending.delete(id as string);
      if (action === 'sum') await ask(user, chatId, `перескажи ${item.url}`);
      else await ask(user, chatId, `скачай ${item.url}`);
    }
  }

  async function onMessage(message: TgMessage) {
    if (message.chat.type !== 'private') return;
    const chatId = message.chat.id;
    if (tooFast(chatId)) return;
    const user = await userOfChat(chatId);
    const text = (message.text ?? '').trim();
    if (!user) {
      // Linking: «/start 123456», «/link 123456» or just the six digits.
      const code = /^(?:\/(?:start|link)\s+)?(\d{6})$/.exec(text)?.[1];
      const now = deps.clock().getTime();
      if (code) {
        const tries = attempts.get(chatId) ?? { count: 0, since: now };
        if (now - tries.since > 3_600_000) {
          tries.count = 0;
          tries.since = now;
        }
        tries.count += 1;
        attempts.set(chatId, tries);
        if (tries.count > 8) {
          await send(chatId, 'Слишком много неверных кодов. Попробуйте через час.');
          return;
        }
        const found = codes.get(code);
        if (found && found.expires > now) {
          codes.delete(code);
          await deps.profiles.setTelegramChat(found.username, String(chatId));
          const person = await deps.users.findByUsername(found.username);
          await send(
            chatId,
            `Готово, ${person?.displayName ?? ''}! Теперь я знаю вас. Пишите вопросы, присылайте ссылки и файлы или нажмите кнопки.`,
            MENU,
          );
          return;
        }
        await send(
          chatId,
          'Код не подошёл или устарел. Получите новый в портале: «Мой профиль» → «Привязать Telegram».',
        );
        return;
      }
      await send(
        chatId,
        'Здравствуйте! Я бот семейного сервера и пока не знаю вас. Откройте портал → «Мой профиль» → «Привязать Telegram», получите шестизначный код и пришлите его мне.',
      );
      return;
    }
    const hasFile = message.photo || message.document || message.video || message.audio || message.voice;
    if (hasFile) {
      // A voice message that comes while a question waits is the answer to it; so is anything sent in the answering mode.
      if (!answering.has(chatId) && message.voice && (await deps.family.state(user.username)).current) {
        answering.set(chatId, { entryId: null, until: deps.clock().getTime() + 60 * 60_000 });
      }
      if (answering.has(chatId)) {
        await takeAnswer(user, chatId, message);
        return;
      }
      await saveFile(user, chatId, message);
      return;
    }
    if (text !== '') await onText(user, chatId, text);
  }

  async function onUpdate(update: TgUpdate) {
    try {
      if (update.message) await onMessage(update.message);
      else if (update.callback_query?.message) {
        const query = update.callback_query;
        void api('answerCallbackQuery', { callback_query_id: query.id });
        const chatId = query.message?.chat.id;
        if (chatId === undefined || query.message?.chat.type !== 'private' || tooFast(chatId)) return;
        const user = await userOfChat(chatId);
        if (!user || query.data === undefined || query.data === 'noop') return;
        await onCallback(user, chatId, query.data, query.message?.message_id);
      }
    } catch (error) {
      deps.onError?.(`Бот Telegram: ${String(error)}`);
    }
  }

  async function loop() {
    let offset = 0;
    let wait = 1000;
    while (running) {
      controller = new AbortController();
      const updates = await api<TgUpdate[]>(
        'getUpdates',
        { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] },
        controller.signal,
        40_000,
      );
      if (updates === null) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        wait = Math.min(wait * 2, 60_000);
        continue;
      }
      wait = 1000;
      for (const update of updates) {
        offset = update.update_id + 1;
        await onUpdate(update);
      }
    }
  }

  return {
    name: () => botName,
    ready: () => token !== null && botName !== null,
    async start(): Promise<void> {
      try {
        token = (await readFile(deps.tokenFile, 'utf8')).trim();
      } catch {
        token = null;
        return;
      }
      if (!/^\d{5,}:[\w-]{20,}$/.test(token)) {
        token = null;
        return;
      }
      const me = await api<{ username: string }>('getMe', {});
      botName = me?.username ?? null;
      if (botName === null) return;
      void api('setMyCommands', {
        commands: [
          { command: 'menu', description: 'Главное меню' },
          { command: 'family', description: 'Вопрос из семейного архива' },
          { command: 'help', description: 'Что я умею' },
        ],
      });
      running = true;
      void loop();
    },
    stop(): void {
      running = false;
      controller?.abort();
    },
    /** A one-time code for linking a chat (valid 15 minutes). */
    createLinkCode(username: string): { code: string; bot: string; expiresInMinutes: number } | null {
      if (botName === null) return null;
      for (const [code, entry] of codes)
        if (entry.username === username || entry.expires < deps.clock().getTime()) codes.delete(code);
      let code = String(randomInt(100_000, 1_000_000));
      while (codes.has(code)) code = String(randomInt(100_000, 1_000_000));
      codes.set(code, { username, expires: deps.clock().getTime() + 15 * 60_000 });
      return { code, bot: botName, expiresInMinutes: 15 };
    },
    /** A text to a person (if they linked a chat). */
    async sendToChat(chatId: string, text: string, html = false): Promise<boolean> {
      return send(chatId, html ? digestHtml(text) : text, undefined, html);
    },
    menuFor: () => MENU,
    /** The question of the family archive to a linked chat. */
    async askFamily(chatId: string, question: FamilyQuestion, reminder: boolean): Promise<void> {
      await sendQuestion(chatId, question, reminder);
    },
  };
}

export type TelegramBot = ReturnType<typeof createTelegramBot>;
