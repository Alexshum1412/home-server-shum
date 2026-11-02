/**
 * Olivia's eyes on the internet: a search, a page read as plain text, the news. Only public addresses are fetched
 * (the same rule as the download queue: not this PC, not the home network), pages are cut to a few thousand characters,
 * and nothing about the family goes out except the words of the search the person typed.
 */
import dns from 'node:dns/promises';
import { parseHeadlines } from '../digest/interests.ts';
import { isPublicAddress } from '../downloads/net-guard.ts';

type Fetch = typeof fetch;
const UA = 'Mozilla/5.0 (compatible; FamilyServer-Olivia/1.0)';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

const decodeEntities = (text: string) =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');

const plain = (html: string) =>
  decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/** Is this address one a server may fetch: http(s) only, no passwords in it, every address it resolves to is public. */
export async function checkPublicUrl(raw: string): Promise<URL | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
  try {
    const found = await dns.lookup(url.hostname, { all: true });
    if (found.length === 0 || !found.every((entry) => isPublicAddress(entry.address))) return null;
  } catch {
    return null;
  }
  return url;
}

async function safeGet(raw: string, fetchImpl: Fetch, ms: number, hops = 3): Promise<Response | null> {
  let current = raw;
  for (let hop = 0; hop <= hops; hop += 1) {
    const url = await checkPublicUrl(current);
    if (!url) return null;
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(ms),
      headers: { 'user-agent': UA, 'accept-language': 'ru,en;q=0.8' },
    });
    const next = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && next) {
      current = new URL(next, url).toString();
      continue;
    }
    return response;
  }
  return null;
}

/** A page as readable text (title and the first part of the body), or null. */
export async function readPage(
  raw: string,
  fetchImpl: Fetch = fetch,
): Promise<{ title: string; text: string; url: string } | null> {
  try {
    const response = await safeGet(raw, fetchImpl, 10_000);
    if (!response || !response.ok) return null;
    const type = response.headers.get('content-type') ?? '';
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) return null;
    const bytes = new Uint8Array(await response.arrayBuffer()).subarray(0, 1_500_000);
    const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const title = plain(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
    const body = html
      .replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');
    const text = plain(body).slice(0, 6000);
    return text.length < 80 ? null : { title: title.slice(0, 200), text, url: raw };
  } catch {
    return null;
  }
}

async function duckDuckGo(query: string, fetchImpl: Fetch): Promise<SearchHit[]> {
  try {
    const response = await fetchImpl('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
      body: new URLSearchParams({ q: query, kl: 'ru-ru' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    const html = await response.text();
    const hits: SearchHit[] = [];
    const re =
      /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    for (const match of html.matchAll(re)) {
      let link = decodeEntities(match[1] ?? '');
      const wrapped = /[?&]uddg=([^&]+)/.exec(link);
      if (wrapped?.[1]) link = decodeURIComponent(wrapped[1]);
      if (!/^https?:\/\//.test(link)) continue;
      hits.push({ title: plain(match[2] ?? ''), url: link, snippet: plain(match[3] ?? '') });
      if (hits.length >= 5) break;
    }
    return hits;
  } catch {
    return [];
  }
}

async function wikipedia(query: string, fetchImpl: Fetch): Promise<SearchHit[]> {
  try {
    const url = `https://ru.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=5&origin=*`;
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'user-agent': UA },
    });
    if (!response.ok) return [];
    const body = (await response.json()) as {
      query?: { search?: Array<{ title: string; snippet: string }> };
    };
    return (body.query?.search ?? []).map((item) => ({
      title: item.title,
      url: `https://ru.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
      snippet: plain(item.snippet),
    }));
  } catch {
    return [];
  }
}

/** The own meta-search engine (SearXNG on this PC, loopback only): the words of the search go out, nothing else. */
async function searxng(query: string, baseUrl: string, fetchImpl: Fetch): Promise<SearchHit[]> {
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/search?format=json&language=ru&q=${encodeURIComponent(query)}`;
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { 'user-agent': UA },
    });
    if (!response.ok) return [];
    const body = (await response.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    const hits: SearchHit[] = [];
    for (const item of body.results ?? []) {
      if (typeof item.url !== 'string' || !/^https?:\/\//.test(item.url)) continue;
      hits.push({
        title: plain(item.title ?? '').slice(0, 200),
        url: item.url,
        snippet: plain(item.content ?? '').slice(0, 300),
      });
      if (hits.length >= 6) break;
    }
    return hits;
  } catch {
    return [];
  }
}

/** The web in a few lines: the own search engine first, then a public one, the encyclopedia when nothing is found. */
export async function searchWeb(
  query: string,
  fetchImpl: Fetch = fetch,
  searxUrl: string | null = null,
): Promise<SearchHit[]> {
  if (searxUrl) {
    const own = await searxng(query, searxUrl, fetchImpl);
    if (own.length > 0) return own;
  }
  const found = await duckDuckGo(query, fetchImpl);
  return found.length > 0 ? found : wikipedia(query, fetchImpl);
}

export async function newsHeadlines(fetchImpl: Fetch = fetch, limit = 6): Promise<string[]> {
  try {
    const response = await fetchImpl('https://feeds.bbci.co.uk/russian/rss.xml', {
      signal: AbortSignal.timeout(6000),
    });
    return response.ok ? parseHeadlines(await response.text(), limit) : [];
  } catch {
    return [];
  }
}

const URL_RE = /https?:\/\/[^\s<>"']+/i;
const NEWS_RE = /новост|что нового в мире|что происходит в мире|сводк[ауи] (?:дня|новостей)/i;
const SEARCH_RE =
  /(?:найди|поищи|погугли|загугли|посмотри)\s+(?:мне\s+)?(?:в\s+(?:интернете|сети|гугле)\s+)?(.{3,200})/i;

export type WebIntent =
  | { kind: 'news' }
  | { kind: 'page'; url: string }
  | { kind: 'search'; query: string }
  | null;

/** What in the message needs the internet: news, a link to read, or «найди в интернете …». */
export function webIntent(message: string): WebIntent {
  const url = URL_RE.exec(message)?.[0];
  if (url && !/^magnet:/i.test(url) && !/\.torrent(\?|$)/i.test(url)) return { kind: 'page', url };
  if (NEWS_RE.test(message)) return { kind: 'news' };
  if (
    /в\s+(?:интернете|сети|гугле)|погугли|загугли|свежие данные|последни[ей] (?:новости|данные)/i.test(
      message,
    )
  ) {
    const query = SEARCH_RE.exec(message)?.[1]?.trim() ?? message.trim();
    return { kind: 'search', query: query.replace(/\s+/g, ' ').slice(0, 200) };
  }
  if (LOOKUP_RE.test(message)) return { kind: 'search', query: searchQuery(message) };
  return null;
}

/** Questions about the world that a small model would only guess at: she looks them up first. */
const LOOKUP_RE =
  /^(?:кто\s+так(?:ой|ая|ие)|что\s+так(?:ое|ой)|что\s+значит|когда\s+(?:выйдет|выходит|вышел|вышла|был|будет|родил)|где\s+(?:находится|купить|посмотреть)|сколько\s+(?:стоит|лет|будет\s+стоить)|в\s+каком\s+году|какая\s+(?:сейчас\s+)?погода|как\s+зовут|кто\s+(?:выиграл|победил|снял|написал|играет)|какие\s+(?:новые|лучшие)\s+(?:фильмы|сериалы|игры|книги))|текст\s+песни|слова\s+песни|расскажи\s+(?:мне\s+)?(?:о|про|об)\s+|актуальн|свежи[ейх]|последн(?:ий|яя|ее|ие|юю)\s+(?:выпуск|версия|релиз|серия|сезон)|информаци[юяи]\s+(?:о|про|об)\s+/i;

function searchQuery(message: string): string {
  return message
    .replace(/^(?:напиши|расскажи|скажи|подскажи|дай)\s+(?:мне\s+)?/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}
