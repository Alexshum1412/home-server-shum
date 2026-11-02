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
  digest: (user: StoredUser) => Promise<string>;
  tasksToday: (user: StoredUser) => Promise<string>;
  statusText: () => Promise<string>;
  fetch?: Fetch;
  onError?: (message: string) => void;
}

const MENU: Button[][] = [
  [
    { text: '📰 Дайджест', callback_data: 'menu:digest' },
    { text: '✅ Дела на сегодня', callback_data: 'menu:tasks' },
  ],
  [
    { text: '📊 Что с сервером', callback_data: 'menu:status' },
    { text: '⬇ Мои загрузки', callback_data: 'menu:downloads' },
  ],
  [
    { text: '🔔 Уведомления сюда: вкл/выкл', callback_data: 'menu:notify' },
    { text: '❓ Что я умею', callback_data: 'menu:help' },
  ],
];

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
      await send(chatId, `Здравствуйте, ${user.displayName}! Что сделать?`, MENU);
      return;
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

  async function onCallback(user: StoredUser, chatId: number, data: string) {
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
    if (message.photo || message.document || message.video || message.audio || message.voice) {
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
        await onCallback(user, chatId, query.data);
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
          { command: 'menu', description: 'Меню' },
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
  };
}

export type TelegramBot = ReturnType<typeof createTelegramBot>;
