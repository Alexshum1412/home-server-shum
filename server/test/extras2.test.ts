import { afterEach, describe, expect, it } from 'vitest';
import { englishLine, germanLine, parseHeadlines, recipeLine, wordOfDay } from '../src/digest/interests.ts';
import { searchWeb, webIntent } from '../src/olivia/web.ts';
import { cleanPatch, createProfileStore } from '../src/profile/profiles.ts';
import { searxngUrl } from '../src/supervisor/apps.ts';
import { placeFromCaption, splitMessage } from '../src/telegram/bot.ts';
import { makeTempDir, removeDir } from './helpers.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

describe('words of the day and kitchen ideas', () => {
  it('gives the same word to everybody on a day and another one the next day', () => {
    expect(germanLine('2026-11-02')).toBe(germanLine('2026-11-02'));
    expect(germanLine('2026-11-02')).not.toBe(germanLine('2026-11-03'));
    expect(germanLine('2026-11-02')).toMatch(/^Слово дня на немецком: .+ — .+\. Пример: /);
    expect(englishLine('2026-11-02')).toMatch(/^Слово дня на английском: /);
    expect(recipeLine('2026-11-02')).toMatch(/^Идея на сегодня: .+\.$/);
    expect(wordOfDay([['a', 'b', 'c', 'd']], '2030-01-01')[0]).toBe('a');
  });

  it('reads the first headlines of a news feed and decodes the entities', () => {
    const xml =
      '<rss><channel><title>BBC</title><item><title><![CDATA[Первая &amp; важная]]></title></item><item><title>Вторая</title></item><item><title>Третья</title></item><item><title>Четвёртая</title></item></channel></rss>';
    expect(parseHeadlines(xml)).toEqual(['Первая & важная', 'Вторая', 'Третья']);
    expect(parseHeadlines('<rss></rss>')).toEqual([]);
  });
});

describe('what in a message needs the internet', () => {
  it('finds news, a page to read and an explicit search, and leaves ordinary talk alone', () => {
    expect(webIntent('что в новостях сегодня?')).toEqual({ kind: 'news' });
    expect(webIntent('перескажи https://example.org/article')).toEqual({
      kind: 'page',
      url: 'https://example.org/article',
    });
    expect(webIntent('найди в интернете как выбрать телевизор')).toEqual({
      kind: 'search',
      query: 'как выбрать телевизор',
    });
    expect(webIntent('посоветуй рецепт борща')).toBeNull();
    expect(webIntent('скачай magnet:?xt=urn:btih:abc')).toBeNull();
    expect(webIntent('вот файл https://example.org/a.torrent')).toBeNull();
  });
});

describe('profiles', () => {
  it('keeps only known interests and a clean Telegram name, and remembers one chat for one person', async () => {
    expect(
      cleanPatch({
        interests: ['german', 'bogus', 'german'],
        telegramUsername: '@ivan_1',
        city: '  Москва ',
      }),
    ).toEqual({
      interests: ['german'],
      telegramUsername: 'ivan_1',
      city: 'Москва',
    });
    expect(cleanPatch({ telegramUsername: 'bad name!' }).telegramUsername).toBe('');
    const dir = await makeTempDir('fd-profile-');
    cleanup.push(() => removeDir(dir));
    const store = createProfileStore(dir);
    await store.update(
      'mama',
      { interests: ['news'], onboarded: true },
      { latitude: 55.75, longitude: 37.6, name: 'Москва' },
    );
    expect(await store.view('mama')).toMatchObject({
      city: 'Москва',
      hasCoordinates: true,
      interests: ['news'],
      onboarded: true,
      telegramLinked: false,
    });
    await store.setTelegramChat('mama', '123456');
    expect(await store.findByChat('123456')).toBe('mama');
    await store.setTelegramChat('papa', '123456'); // the chat moves to the new person
    expect(await store.findByChat('123456')).toBe('papa');
    expect((await store.view('mama')).telegramLinked).toBe(false);
    expect((await store.view('stranger')).onboarded).toBe(false);
  });
});

describe('the Telegram bot helpers', () => {
  it('splits a long text at line ends and keeps every piece within the limit', () => {
    const text = Array.from({ length: 400 }, (_, i) => `Строка номер ${i}`).join('\n');
    const parts = splitMessage(text, 1000);
    expect(parts.length).toBeGreaterThan(3);
    expect(parts.every((part) => part.length <= 1000)).toBe(true);
    expect(parts.join('\n').replace(/\n+/g, '\n')).toContain('Строка номер 399');
    expect(splitMessage('коротко')).toEqual(['коротко']);
  });

  it('reads the place from a caption of a file', () => {
    expect(placeFromCaption('в альбом Дача')).toEqual({ shared: false, album: 'Дача' });
    expect(placeFromCaption('это общее фото')).toEqual({ shared: true, album: null });
    expect(placeFromCaption('')).toEqual({ shared: false, album: null });
    expect(placeFromCaption('в альбом ../../Секрет').album).toBe('....Секрет');
  });
});

describe('the own search engine', () => {
  it('asks only the loopback engine first and falls back when it is silent', async () => {
    const urls: string[] = [];
    const fake = (async (input: unknown) => {
      urls.push(String(input));
      return new Response(
        JSON.stringify({
          results: [
            { title: 'Фильмы', url: 'https://example.org/a', content: 'Список' },
            { title: 'x', url: 'javascript:1' },
          ],
        }),
      );
    }) as typeof fetch;
    const hits = await searchWeb('новые фильмы', fake, 'http://127.0.0.1:8888/');
    expect(hits).toEqual([{ title: 'Фильмы', url: 'https://example.org/a', snippet: 'Список' }]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('http://127.0.0.1:8888/search?format=json');
  });

  it('accepts only a loopback address from .env', () => {
    expect(searxngUrl({ SEARXNG_URL: 'http://127.0.0.1:8888/' })).toBe('http://127.0.0.1:8888');
    expect(searxngUrl({ SEARXNG_URL: 'http://192.168.1.5:8888' })).toBeNull();
    expect(searxngUrl({ SEARXNG_URL: 'https://example.org' })).toBeNull();
    expect(searxngUrl({})).toBeNull();
  });
});
