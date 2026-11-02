import type { BigModel } from '../olivia/big-model.ts';
import { type ExternalLlm, externalHeaders } from '../olivia/chat.ts';
import { llamaHeaders } from '../olivia/llm-key.ts';

export interface DigestLlmOptions {
  /** Address of the small model that always runs (Olivia's), or null. */
  quickUrl: string | null;
  keyFile: string | undefined;
  /** The bigger model for the nightly run (started for it and stopped after). */
  big: BigModel;
  /** Free models from the internet (a router on this PC): tried first, the local models are the reserve. */
  external?: ExternalLlm;
  fetch?: typeof fetch;
}

const SYSTEM =
  'Ты домашний помощник семьи. Напиши человеку по-русски ТОЛЬКО тёплое приветствие на утро: 1–2 коротких предложения, ' +
  'начни с «Доброе утро, <имя>!». Можно одним словом отметить самое важное из фактов (дождь — зонт, много дел — бодрого дня). ' +
  'Не перечисляй факты, не используй списки, ссылки и выдуманные подробности.';

export function buildPrompt(name: string, lines: string[]): string {
  return `Имя: ${name}\nФакты на сегодня:\n${lines.map((line) => `- ${line}`).join('\n')}`;
}

async function chat(
  url: string,
  keyFile: string | undefined,
  prompt: string,
  ms: number,
  fetchImpl: typeof fetch,
  system: string = SYSTEM,
  maxTokens = 120,
  target?: { headers: Record<string, string>; model: string },
): Promise<string | null> {
  try {
    const response = await fetchImpl(`${url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: target?.headers ?? llamaHeaders(keyFile),
      body: JSON.stringify({
        model: target?.model ?? 'local',
        stream: false,
        temperature: 0.4,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
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
  // During a session of the bigger model the topics are made by it too; otherwise by the small one.
  let sessionAddress: string | null = null;
  /** One request to the free models (null when they are off, silent or the internet is gone). */
  const free = async (system: string, prompt: string, maxTokens: number): Promise<string | null> => {
    const external = options.external;
    if (!external?.enabled()) return null;
    return chat(external.url, undefined, prompt, 60_000, fetchImpl, system, maxTokens, {
      headers: await externalHeaders(external),
      model: external.model,
    });
  };
  const generate = async (system: string, prompt: string, maxTokens: number): Promise<string | null> => {
    const outside = await free(system, prompt, maxTokens);
    if (outside) return outside;
    const address = sessionAddress ?? options.quickUrl;
    if (!address) return null;
    const answer = await chat(address, options.keyFile, prompt, 240_000, fetchImpl, system, maxTokens);
    if (answer || address === options.quickUrl || !options.quickUrl) return answer;
    return chat(options.quickUrl, options.keyFile, prompt, 90_000, fetchImpl, system, maxTokens);
  };
  const quick = async (name: string, lines: string[]): Promise<string | null> =>
    (await free(SYSTEM, buildPrompt(name, lines), 120)) ??
    (options.quickUrl
      ? chat(options.quickUrl, options.keyFile, buildPrompt(name, lines), 90_000, fetchImpl)
      : null);

  return {
    bigAvailable: () => options.big.available(),
    quick,
    generate,
    /** One session of the bigger model for a list of people; falls back to the small model when it cannot start. */
    session<T>(
      work: (
        write: (name: string, lines: string[]) => Promise<{ text: string | null; model: 'big' | 'quick' }>,
      ) => Promise<T>,
    ): Promise<T> {
      return options.big.use((address) => {
        sessionAddress = address;
        return work(async (name, lines) => {
          const outside = await free(SYSTEM, buildPrompt(name, lines), 120);
          if (outside) return { text: outside, model: 'quick' as const };
          if (address) {
            const text = await chat(address, options.keyFile, buildPrompt(name, lines), 300_000, fetchImpl);
            if (text) return { text, model: 'big' as const };
          }
          return { text: await quick(name, lines), model: 'quick' as const };
        }).finally(() => {
          sessionAddress = null;
        });
      }, 30_000);
    },
  };
}

export type DigestLlm = ReturnType<typeof createDigestLlm>;
