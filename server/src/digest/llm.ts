import type { BigModel } from '../olivia/big-model.ts';
import { llamaHeaders } from '../olivia/llm-key.ts';

export interface DigestLlmOptions {
  /** Address of the small model that always runs (Olivia's), or null. */
  quickUrl: string | null;
  keyFile: string | undefined;
  /** The bigger model for the nightly run (started for it and stopped after). */
  big: BigModel;
  fetch?: typeof fetch;
}

const SYSTEM =
  'Ты домашний помощник семьи. Напиши короткое утреннее сообщение человеку по-русски: тёплый простой тон, 4–8 коротких строк, ' +
  'без ссылок и без выдуманных подробностей. Используй ТОЛЬКО факты из списка и ничего не добавляй от себя. ' +
  'Сначала самое важное для этого человека. Если фактов мало — поздоровайся и пожелай хорошего дня.';

export function buildPrompt(name: string, lines: string[]): string {
  return `Имя: ${name}\nФакты на сегодня:\n${lines.map((line) => `- ${line}`).join('\n')}`;
}

async function chat(
  url: string,
  keyFile: string | undefined,
  prompt: string,
  ms: number,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl(`${url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: llamaHeaders(keyFile),
      body: JSON.stringify({
        model: 'local',
        stream: false,
        temperature: 0.4,
        max_tokens: 320,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(ms),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const text = String(body.choices?.[0]?.message?.content ?? '').trim();
    return text === '' ? null : text.replace(/https?:\/\/\S+/g, '').slice(0, 1500);
  } catch {
    return null;
  }
}

/**
 * Words for the digest from a local model. The small one that always runs answers a click at once; the nightly run uses
 * the bigger model for its few minutes (it needs about 4 GB and writes slowly: it is not for dialogues). Every failure
 * returns null and the caller writes the digest from a template.
 */
export function createDigestLlm(options: DigestLlmOptions) {
  const fetchImpl = options.fetch ?? fetch;
  const quick = async (name: string, lines: string[]): Promise<string | null> =>
    options.quickUrl
      ? chat(options.quickUrl, options.keyFile, buildPrompt(name, lines), 90_000, fetchImpl)
      : null;

  return {
    bigAvailable: () => options.big.available(),
    quick,
    /** One session of the bigger model for a list of people; falls back to the small model when it cannot start. */
    session<T>(
      work: (
        write: (name: string, lines: string[]) => Promise<{ text: string | null; model: 'big' | 'quick' }>,
      ) => Promise<T>,
    ): Promise<T> {
      return options.big.use(
        (address) =>
          work(async (name, lines) => {
            if (address) {
              const text = await chat(address, options.keyFile, buildPrompt(name, lines), 300_000, fetchImpl);
              if (text) return { text, model: 'big' as const };
            }
            return { text: await quick(name, lines), model: 'quick' as const };
          }),
        30_000,
      );
    },
  };
}

export type DigestLlm = ReturnType<typeof createDigestLlm>;
