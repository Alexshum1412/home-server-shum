/**
 * Optional local language model for «Оливия» (ADR-0008): it only RE-WORDS a finding the rules have
 * already made, in plain Russian. It never chooses or runs an action, never sees logs or file
 * names, is reachable only on this PC (loopback) and is off unless OLIVIA_LLM_URL is set.
 * The answer is shown as text, labelled as machine-made, and is never executed or parsed.
 */
import type { OliviaFinding } from '../../../shared/api.ts';

export interface OliviaLlmConfig {
  /** Base URL of an OpenAI-compatible server on this PC, e.g. http://127.0.0.1:11434/v1 (Ollama, llama.cpp). */
  url: string;
  model: string;
  timeoutMs: number;
}

export type LlmFetch = (url: string, init: RequestInit) => Promise<Response>;

export class LlmError extends Error {}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
export const LLM_MAX_ANSWER_CHARS = 1200;

/** Only an address on this very PC is accepted: findings never leave the machine. */
export function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' && LOOPBACK.has(url.hostname.toLowerCase()) && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

/** Addresses and folders are not needed to re-word a finding, so they are not sent. */
export function depersonalise(text: string): string {
  return text
    .replace(/\b[A-Za-z]:\\[^\s"«»]*/g, '[путь]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[адрес]')
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.ts\.net\b/gi, '[адрес]');
}

const SYSTEM_PROMPT = [
  'Ты помощник администратора домашнего сервера семьи. Пиши по-русски, простыми словами, 3–5 коротких предложений.',
  'Объясни, что означает сообщение и почему это важно. Опирайся ТОЛЬКО на данные ниже, ничего не придумывай.',
  'Не предлагай команд, не называй программы для установки, не обещай, что что-то исправится само.',
  'Если данных мало, так и скажи.',
].join(' ');

/** Text of the model's answer made safe to show: no control characters, no markup tricks, bounded length. */
export function cleanAnswer(raw: string): string {
  const text = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is removed
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]{0,200}>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  return Array.from(text).slice(0, LLM_MAX_ANSWER_CHARS).join('');
}

export async function explainFinding(
  finding: OliviaFinding,
  config: OliviaLlmConfig,
  fetchImpl: LlmFetch,
): Promise<string> {
  const facts = depersonalise(
    `Сообщение: ${finding.title}\nЧто происходит: ${finding.explanation}\nСовет правил: ${finding.suggestion}`,
  );
  let response: Response;
  try {
    response = await fetchImpl(`${config.url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        temperature: 0.2,
        max_tokens: 400,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: facts },
        ],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new LlmError(
      timeout
        ? 'Локальный ИИ не ответил вовремя. Правила «Оливии» работают и без него.'
        : 'Локальный ИИ не отвечает (программа модели не запущена?). Правила «Оливии» работают и без него.',
    );
  }
  if (!response.ok) throw new LlmError(`Локальный ИИ ответил ошибкой (HTTP ${response.status}).`);
  let content: unknown;
  try {
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    content = body.choices?.[0]?.message?.content;
  } catch {
    throw new LlmError('Локальный ИИ ответил в непонятном формате.');
  }
  const answer = typeof content === 'string' ? cleanAnswer(content) : '';
  if (answer === '') throw new LlmError('Локальный ИИ вернул пустой ответ.');
  return answer;
}
