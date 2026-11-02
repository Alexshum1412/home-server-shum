import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { OliviaAnswer } from '../../../shared/api.ts';
import type { StoredUser } from '../auth/users.ts';
import { createSerialQueue, readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import type { Clock } from '../lib/time.ts';
import { reportIntent } from '../reports/service.ts';
import type { Assistant } from './assistant/assistant.ts';
import { routeByRules } from './assistant/router.ts';
import type { BigModel } from './big-model.ts';
import { llamaHeaders } from './llm-key.ts';
import { newsHeadlines, readPage, searchWeb, webIntent } from './web.ts';

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  model?: 'quick' | 'big' | 'free' | 'rules';
}

export type ConverseResult =
  | { kind: 'tool'; answer: OliviaAnswer }
  | { kind: 'chat'; text: string; model: 'quick' | 'big' | 'free'; sources: string[] };

const KEEP = 40;

const MANNERS =
  ' Если просьба неясна или её можно понять двумя способами — задай ОДИН короткий уточняющий вопрос и остановись. ' +
  'Если запрос понятен — ответь и в конце предложи один-два следующих шага («хотите, найду …», «могу составить …»). ' +
  'Тексты песен, отрывки книг и статей не воспроизводи: расскажи, о чём песня или книга, кто автор, и подскажи, где прочитать законно.';

const SYSTEM = (name: string, now: string) =>
  `Ты Оливия — добрая и внимательная помощница семьи, живёшь на домашнем компьютере. Сейчас ${now}. Ты говоришь с человеком по имени ${name}. ` +
  'Отвечай по-русски, понятно и по делу, без лишних вступлений. Можешь советовать рецепты и идеи, объяснять школьные темы, ' +
  'решать задачи по шагам, помогать с текстами и письмами, просто поддержать разговор. Если в разговоре есть блок «Данные из интернета», опирайся на него ' +
  'и не придумывай то, чего там нет. Если не знаешь или не уверена — так и скажи: не выдумывай факты, даты и цифры. ' +
  'За свежими сведениями человек может написать «найди в интернете …». Медицинские и юридические вопросы — только общая информация и совет обратиться к специалисту.' +
  MANNERS;

const SAVE_RE =
  /(?:сохрани|добавь в архив|занеси в архив|в архив)\s+(?:страницу\s+|эту страницу\s+|ссылку\s+)?(https?:\/\/\S+)/i;
const KB_RE =
  /(?:в|по)\s+(?:моих|наших|нашей|моей)\s+(?:заметк\w*|сохранённ\w*|сохраненн\w*|архив\w*|страниц\w*|знани\w*)|что\s+я\s+(?:сохранял\w*|записывал\w*)|найди\s+в\s+(?:заметках|архиве|сохранённых|сохраненных)|в\s+сохранённых\s+страницах|в\s+сохраненных\s+страницах/i;

/** Verbs of an open request: the talk with the model, whatever the topic words look like. */
const GENERAL_RE =
  /(?:^|\s)(?:напиши|сочини|составь|придумай|расскажи|объясни|реши|переведи|посоветуй|подскажи|помоги|распиши)(?![\p{L}\p{N}])|рецепт|стих|сочинени|домашн/iu;

/** Keeps the end of a list of texts within a budget of characters (a small model has a small memory). */
function within(turns: ChatTurn[], budget: number): ChatTurn[] {
  const out: ChatTurn[] = [];
  let used = 0;
  for (const turn of [...turns].reverse()) {
    used += turn.text.length;
    if (used > budget && out.length > 0) break;
    out.push(turn);
  }
  return out.reverse();
}

export interface ExternalLlm {
  /** Base address, e.g. http://127.0.0.1:3101/v1 */
  url: string;
  keyFile: string;
  /** «auto» lets the router choose the best free model that is available. */
  model: string;
  /** The administrator's switch (and «the key is there»). */
  enabled: () => boolean;
}

/** The unified key of the router is read from its file at every call (never kept in a log or sent to a page). */
export async function externalHeaders(external: ExternalLlm | undefined): Promise<Record<string, string>> {
  const key = external ? (await readFile(external.keyFile, 'utf8').catch(() => '')).trim() : '';
  return { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
}

/**
 * Some free models put their reasoning into the answer («<think>…</think>», «Thinking: …»). What is left is the answer
 * itself; if it is nothing but reasoning, an empty string is returned and the next model is asked.
 */
export function cleanFreeAnswer(raw: string): string {
  let text = raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  const closing = text.search(/<\/think(?:ing)?>/i);
  if (closing >= 0) {
    const tail = text
      .slice(closing)
      .replace(/<\/think(?:ing)?>/gi, '')
      .trim();
    text = tail;
  }
  text = text.replace(/<\/?think(?:ing)?>/gi, '').trim();
  if (/^(thinking|reasoning|рассуждени[ея]|размышлени[ея])\b[\s:.]/i.test(text)) return '';
  return text.replace(/^(?:Оливия|Olivia)\s*:\s*/i, '');
}

export async function* streamChat(
  url: string,
  headers: Record<string, string>,
  modelName: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): AsyncGenerator<string> {
  const response = await fetchImpl(`${url.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: modelName,
      stream: true,
      temperature: 0.6,
      max_tokens: maxTokens,
      messages,
    }),
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`model answered ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const piece = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]
          ?.delta?.content;
        if (piece) yield piece;
      } catch {
        // a torn line: skipped
      }
    }
  }
}

/** The conversation of Olivia: the server helper first (clear questions about the server), otherwise a talk with the local model. */
export function createOliviaChat(options: {
  dataDir: string;
  clock: Clock;
  assistant: Assistant;
  quickUrl: string | null;
  keyFile: string | undefined;
  big: BigModel;
  /** Address of the own search engine (SearXNG on this PC); null — the public fallbacks only. */
  searxUrl?: string | null;
  /** Search in the Wikipedia that lies on this PC (used when the internet gives nothing). */
  offline?: (query: string) => Promise<Array<{ title: string; snippet: string; url: string }>>;
  /** A router of free models on the internet (freellmapi, on this PC): used first, the local models are the reserve. */
  external?: ExternalLlm;
  /** Reports as a picture and a document (state of the server, the week ahead). */
  reports?: {
    available: () => boolean;
    make: (
      user: StoredUser,
      kind: 'server' | 'week',
    ) => Promise<{ id: string; title: string; summary: string; png: string; pdf: string } | null>;
  };
  /** The family's own knowledge: saved pages and notes (search) and saving a page. */
  knowledge?: {
    search: (
      user: StoredUser,
      query: string,
    ) => Promise<Array<{ kind: string; title: string; snippet: string; href: string }>>;
    save: (user: StoredUser, url: string) => Promise<{ title: string } | null>;
  };
  fetch?: typeof fetch;
}) {
  const fetchImpl = options.fetch ?? fetch;
  const file = path.join(options.dataDir, 'olivia-chats.json');
  const queue = createSerialQueue();
  /** Who is being answered right now, and the question: a person who left the page finds the answer waiting. */
  const busy = new Map<string, { text: string; at: string }>();

  async function load(): Promise<Record<string, ChatTurn[]>> {
    try {
      const data = (await readJsonFile(file)) as { chats?: Record<string, ChatTurn[]> } | undefined;
      return data?.chats && typeof data.chats === 'object' ? data.chats : {};
    } catch {
      return {};
    }
  }

  const append = (username: string, ...turns: ChatTurn[]) =>
    queue.run(async () => {
      const all = await load();
      all[username] = [...(all[username] ?? []), ...turns].slice(-KEEP);
      await writeJsonAtomic(file, { version: 1, chats: all });
    });

  return {
    history: (username: string) => queue.run(async () => (await load())[username] ?? []),
    clear: (username: string) =>
      queue.run(async () => {
        const all = await load();
        delete all[username];
        await writeJsonAtomic(file, { version: 1, chats: all });
      }),
    modelsState: () => ({
      quick: options.quickUrl !== null,
      smart: { available: options.big.available(), running: options.big.isRunning() },
    }),
    isBusy: (username: string) => busy.has(username),
    pending: (username: string) => busy.get(username) ?? null,

    /**
     * Answers one message. `onStatus` tells what she is doing (searching the web, waking the bigger model), `onToken` gets
     * the text as it is written. Only one message per person at a time.
     */
    async converse(
      user: StoredUser,
      message: string,
      opts: {
        smart?: boolean;
        web?: boolean;
        channel?: 'private' | 'public';
        /** A person from outside the family (the bot): a plain talk and the internet, nothing of the family's. */
        guest?: boolean;
        signal?: AbortSignal;
        onStatus?: (text: string) => void;
        onToken?: (piece: string) => void;
      } = {},
    ): Promise<ConverseResult> {
      const text = message.trim().slice(0, 2000);
      const guest = opts.guest === true;
      // «Скачай мне …» without a link: she does not look for torrents by name (that would mean pirated copies), but she looks in the library.
      if (
        !/https?:\/\/|magnet:/i.test(text) &&
        /(?:^|\s)(?:скач(?:ай|ать|айте)|загруз(?:и|ить)|торрент\S*|раздач\S*)(?:\s|$)/i.test(text)
      ) {
        const topic = text
          .replace(
            /скач\S*|загруз\S*|торрент\S*|раздач\S*|мне|пожалуйста|на русском|в хорошем качестве|первый сезон|сезон|серии?/gi,
            ' ',
          )
          .replace(/\s+/g, ' ')
          .trim();
        const found =
          topic.length > 2 && !guest
            ? await options.assistant.ask(user, `найди фильм ${topic}`, opts.channel ?? 'private')
            : null;
        const cards = found?.tool === 'media' ? found.cards : [];
        const explain =
          'Сама искать раздачи на торрент-трекерах по названию я не буду: так легко нарваться на пиратские копии и вредные файлы. Если у вас есть законная раздача, пришлите ссылку, магнитную ссылку или файл .torrent — я проверю её и поставлю в очередь по вашей кнопке «Скачать».';
        const answer: OliviaAnswer = {
          reply:
            cards.length > 0 ? `В нашей медиатеке уже есть подходящее — смотрите ниже. ${explain}` : explain,
          via: 'rules',
          tool: 'download_request',
          cards,
          note: null,
        };
        await append(
          user.username,
          { role: 'user', text, at: options.clock().toISOString() },
          { role: 'assistant', text: answer.reply, at: options.clock().toISOString(), model: 'rules' },
        );
        return { kind: 'tool', answer };
      }
      // «Сделай отчёт о сервере»: a picture and a document with the metrics, charts and warnings.
      const wanted = options.reports && !guest ? reportIntent(text) : null;
      if (wanted && options.reports) {
        opts.onStatus?.('Составляю отчёт с графиками…');
        let reply: string;
        let cards: OliviaAnswer['cards'] = [];
        if (wanted === 'server' && user.role !== 'admin') {
          reply =
            'Подробный отчёт о сервере доступен администратору. Для всех есть страница «Сервер → Что с сервером» и вопрос «что с сервером».';
        } else if (!options.reports.available()) {
          reply = 'Отчёт составить не получилось: на сервере нет браузера Chrome, который рисует страницу.';
        } else {
          const made = await options.reports.make(user, wanted);
          if (made) {
            reply = `Готово: ${made.summary} Отчёт — картинкой и документом ниже.`;
            cards = [
              {
                kind: 'report',
                id: made.id,
                title: made.title,
                summary: made.summary,
                png: made.png,
                pdf: made.pdf,
              },
            ];
          } else reply = 'Отчёт не получился. Попробуйте ещё раз чуть позже.';
        }
        const answer: OliviaAnswer = { reply, via: 'rules', tool: 'report', cards, note: null };
        await append(
          user.username,
          { role: 'user', text, at: options.clock().toISOString() },
          { role: 'assistant', text: reply, at: options.clock().toISOString(), model: 'rules' },
        );
        return { kind: 'tool', answer };
      }
      // «Сохрани страницу …», «что я сохранял про …»: the family's own archive, before the internet.
      const saveUrl = options.knowledge && !guest ? SAVE_RE.exec(text)?.[1] : undefined;
      let own = '';
      let ownSources: string[] = [];
      if (options.knowledge && saveUrl) {
        opts.onStatus?.('Сохраняю страницу…');
        const page = await options.knowledge.save(user, saveUrl);
        const reply = page
          ? `Сохранила страницу «${page.title}» в «Память → Знания и страницы». Теперь можно спросить: «что я сохранял про …».`
          : 'Не получилось сохранить: страница закрыта, не текстовая или недоступна.';
        await append(
          user.username,
          { role: 'user', text, at: options.clock().toISOString() },
          { role: 'assistant', text: reply, at: options.clock().toISOString(), model: 'rules' },
        );
        opts.onToken?.(reply);
        return { kind: 'chat', text: reply, model: 'quick', sources: [] };
      }
      if (options.knowledge && !guest && KB_RE.test(text)) {
        opts.onStatus?.('Ищу в ваших заметках и сохранённых страницах…');
        const query = text.replace(KB_RE, ' ').replace(/\s+/g, ' ').trim() || text;
        const hits = await options.knowledge.search(user, query);
        own =
          hits.length > 0
            ? `Найдено в заметках и сохранённых страницах семьи:\n${hits.map((h, i) => `${i + 1}. ${h.title} — ${h.snippet}`).join('\n')}`
            : 'В заметках и сохранённых страницах семьи по этому запросу ничего не нашлось (так и скажи, не придумывай).';
        ownSources = hits.slice(0, 3).map((h) => h.href);
      }
      const found = opts.web === false || own !== '' ? null : webIntent(text);
      // A guest may ask for the news and a search, but not make the server open any page.
      const intent = guest && found?.kind === 'page' ? null : found;
      if (!intent && !guest) {
        const plan = routeByRules(text);
        // «Напиши…», «объясни…», «реши…» is a talk, not a search of the film library or of the files.
        const talk =
          GENERAL_RE.test(text) &&
          (plan.tool === 'media' || plan.tool === 'files' || plan.tool === 'downloads');
        if (plan.tool !== 'unknown' && !talk) {
          const answer = await options.assistant.ask(user, text, opts.channel ?? 'private');
          await append(
            user.username,
            { role: 'user', text, at: options.clock().toISOString() },
            { role: 'assistant', text: answer.reply, at: options.clock().toISOString(), model: 'rules' },
          );
          return { kind: 'tool', answer };
        }
      }
      busy.set(user.username, { text, at: options.clock().toISOString() });
      try {
        const sources: string[] = [...ownSources];
        let context = own;
        if (intent?.kind === 'news') {
          opts.onStatus?.('Смотрю свежие новости…');
          const items = await newsHeadlines(fetchImpl, 8);
          if (items.length > 0) {
            context = `Заголовки Би-би-си (русская служба):\n${items.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;
            sources.push('https://www.bbc.com/russian');
          }
        } else if (intent?.kind === 'page') {
          opts.onStatus?.('Читаю страницу…');
          const page = await readPage(intent.url, fetchImpl);
          if (page) {
            context = `Страница «${page.title}» (${page.url}):\n${page.text}`;
            sources.push(page.url);
          } else {
            context = 'Страницу не удалось открыть или прочитать (закрыта, не текст или недоступна).';
          }
        } else if (intent?.kind === 'search') {
          opts.onStatus?.('Ищу в интернете…');
          const hits = await searchWeb(intent.query, fetchImpl, options.searxUrl ?? null);
          if (hits.length > 0) {
            context = hits.map((hit, i) => `${i + 1}. ${hit.title} — ${hit.snippet} (${hit.url})`).join('\n');
            for (const hit of hits.slice(0, 3)) sources.push(hit.url);
          } else {
            // No internet, or nothing found: the Wikipedia on this PC is asked.
            const local = options.offline ? await options.offline(intent.query) : [];
            if (local.length > 0) {
              context = `Из офлайн-Википедии на этом компьютере (без интернета):\n${local.map((hit, i) => `${i + 1}. ${hit.title}: ${hit.snippet}`).join('\n')}`;
              for (const hit of local.slice(0, 2)) sources.push(hit.url);
            } else context = 'По запросу ничего не нашлось или поиск недоступен.';
          }
        }
        const history = within(
          await queue.run(async () => (await load())[user.username] ?? []),
          opts.smart ? 6000 : 2200,
        );
        const now = options.clock().toLocaleString('ru-RU', { dateStyle: 'full', timeStyle: 'short' });
        const asked =
          context === ''
            ? text
            : `${text}\n\nДанные из интернета (на ${now}):\n${context.slice(0, opts.smart ? 5000 : 1800)}`;
        const messages = [
          { role: 'system', content: SYSTEM(user.displayName, now) },
          ...history.map((turn) => ({ role: turn.role, content: turn.text })),
          { role: 'user', content: asked },
        ];
        const run = async (url: string, model: 'quick' | 'big' | 'free') => {
          let out = '';
          const controller = new AbortController();
          opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });
          const timer = setTimeout(
            () => controller.abort(),
            model === 'big' ? 600_000 : model === 'free' ? 70_000 : 180_000,
          );
          try {
            const headers =
              model === 'free' ? await externalHeaders(options.external) : llamaHeaders(options.keyFile);
            for await (const piece of streamChat(
              url,
              headers,
              model === 'free' ? (options.external?.model ?? 'auto') : 'local',
              messages,
              model === 'big' ? 700 : model === 'free' ? 900 : 450,
              controller.signal,
              fetchImpl,
            )) {
              out += piece;
              // A free model may think aloud: its text is shown only after it is cleaned.
              if (model !== 'free') opts.onToken?.(piece);
            }
          } finally {
            clearTimeout(timer);
          }
          if (model === 'free') {
            out = cleanFreeAnswer(out);
            if (out !== '') opts.onToken?.(out);
          }
          return { out: out.trim(), model };
        };
        let result: { out: string; model: 'quick' | 'big' | 'free' } | null = null;
        // A free model from the open internet answers first (it is quick and clever); the local models stay for the day
        // when the tokens run out, the internet is gone or the switch is off.
        if (options.external && options.external.enabled() && !opts.signal?.aborted) {
          opts.onStatus?.('Думаю…');
          // Twice at most: the router may pick a model that only «thinks aloud»; the second pick is usually another one.
          for (let attempt = 0; attempt < 2 && !result && !opts.signal?.aborted; attempt += 1) {
            try {
              const answer = await run(options.external.url, 'free');
              if (answer.out !== '') result = answer;
            } catch {
              break;
            }
          }
        }
        if (!result && opts.smart && options.big.available()) {
          opts.onStatus?.(
            options.big.isRunning() ? 'Думаю (большая модель)…' : 'Включаю большую модель, это до минуты…',
          );
          result = await options.big.use(async (address) => {
            if (!address) return null;
            try {
              return await run(address, 'big');
            } catch {
              return null;
            }
          });
        }
        if (!result && options.quickUrl) {
          try {
            result = await run(options.quickUrl, 'quick');
          } catch {
            result = null;
          }
        }
        const reply =
          result && result.out !== ''
            ? result.out
            : 'Языковая модель сейчас не отвечает, поэтому поговорить по-настоящему не получится. Я по-прежнему отвечаю на вопросы про сервер: попробуйте «что с сервером» или «сколько места на диске».';
        const final = sources.length > 0 && result ? `${reply}\n\nИсточники:\n${sources.join('\n')}` : reply;
        await append(
          user.username,
          { role: 'user', text, at: options.clock().toISOString() },
          {
            role: 'assistant',
            text: final,
            at: options.clock().toISOString(),
            model: result?.model ?? 'rules',
          },
        );
        return { kind: 'chat', text: final, model: result?.model ?? 'quick', sources };
      } finally {
        busy.delete(user.username);
      }
    },
  };
}

export type OliviaChat = ReturnType<typeof createOliviaChat>;
