/**
 * Search in the offline library for Olivia: when there is no internet (or the search of the web found nothing) she asks the
 * Wikipedia that lies on this PC. Kiwix is asked on this PC only; the answers are the titles and the beginning of the
 * article, so that the model can tell the person what the book says.
 */
import { KIWIX_PORT, KIWIX_ROOT } from './routes.ts';

export interface OfflineHit {
  title: string;
  snippet: string;
  url: string;
}

const strip = (html: string): string =>
  html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** The books to ask, in order: the Russian Wikipedia first. */
export async function offlineBooks(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${KIWIX_PORT}${KIWIX_ROOT}/catalog/v2/entries`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return [];
    const xml = await response.text();
    const names = [...xml.matchAll(/href="\/offline\/content\/([^"/]+)"/g)].map((m) => m[1] as string);
    const rank = (name: string) => (/^wikipedia_ru/.test(name) ? 0 : /^wikipedia_/.test(name) ? 1 : 2);
    return [...new Set(names)].sort((a, b) => rank(a) - rank(b));
  } catch {
    return [];
  }
}

/** Up to `limit` articles for the words: the title, the beginning of the text and where to read it. */
export async function offlineSearch(
  query: string,
  limit = 3,
  fetchImpl: typeof fetch = fetch,
): Promise<OfflineHit[]> {
  const books = await offlineBooks(fetchImpl);
  const book = books[0];
  if (!book || query.trim() === '') return [];
  const base = `http://127.0.0.1:${KIWIX_PORT}${KIWIX_ROOT}`;
  try {
    const page = await fetchImpl(
      `${base}/search?content=${encodeURIComponent(book)}&pattern=${encodeURIComponent(query.slice(0, 200))}&pageLength=${limit}`,
      { signal: AbortSignal.timeout(20_000) },
    );
    if (!page.ok) return [];
    const html = await page.text();
    const hits: OfflineHit[] = [];
    for (const match of html.matchAll(
      /<li>\s*<a href="(\/offline\/content\/[^"]+)">([\s\S]*?)<\/a>\s*<cite>([\s\S]*?)<\/cite>/g,
    )) {
      const href = match[1] as string;
      let text = strip((match[3] as string).replace(/\.\.\.+/g, ' '));
      // The first hit is read from the article itself: the snippet of a search is only a few words around the match.
      if (hits.length === 0) {
        try {
          const article = await fetchImpl(`http://127.0.0.1:${KIWIX_PORT}${href}`, {
            signal: AbortSignal.timeout(15_000),
          });
          if (article.ok) text = strip(await article.text()).slice(0, 1800) || text;
        } catch {
          // the snippet stays
        }
      }
      hits.push({ title: strip(match[2] as string), snippet: text.slice(0, 1800), url: href });
      if (hits.length >= limit) break;
    }
    return hits;
  } catch {
    return [];
  }
}
