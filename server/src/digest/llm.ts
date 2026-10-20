import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { llamaHeaders } from '../olivia/llm-key.ts';

export interface DigestLlmOptions {
  /** Address of the small model that always runs (Olivia's), or null. */
  quickUrl: string | null;
  keyFile: string | undefined;
  /** llama-server.exe */
  exe: string;
  /** A bigger model file for the nightly digest (started for the run only), or null. */
  bigModel: string | null;
  bigPort: number;
  threads: number;
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

async function waitHealthy(url: string, ms: number, fetchImpl: typeof fetch): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const response = await fetchImpl(`${url.replace(/\/v1$/, '')}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

/**
 * Words for the digest from a local model. The small one that always runs answers a click at once; the nightly run starts
 * the bigger model for its few minutes and stops it again (it needs about 4 GB and writes slowly: it is not for dialogues).
 * Every failure returns null and the caller writes the digest from a template.
 */
export function createDigestLlm(options: DigestLlmOptions) {
  const fetchImpl = options.fetch ?? fetch;
  let busy = Promise.resolve();

  return {
    bigAvailable: () => options.bigModel !== null && existsSync(options.bigModel) && existsSync(options.exe),
    async quick(name: string, lines: string[]): Promise<string | null> {
      if (!options.quickUrl) return null;
      return chat(options.quickUrl, options.keyFile, buildPrompt(name, lines), 90_000, fetchImpl);
    },
    /** One session of the bigger model for a list of people; falls back to the small model when it cannot start. */
    session<T>(
      work: (
        write: (name: string, lines: string[]) => Promise<{ text: string | null; model: 'big' | 'quick' }>,
      ) => Promise<T>,
    ): Promise<T> {
      const run = async (): Promise<T> => {
        let child: ChildProcess | null = null;
        const url = `http://127.0.0.1:${options.bigPort}/v1`;
        if (options.bigModel !== null && existsSync(options.bigModel) && existsSync(options.exe)) {
          const args = [
            '-m',
            options.bigModel,
            '--host',
            '127.0.0.1',
            '--port',
            String(options.bigPort),
            '--alias',
            'local',
            '-c',
            '2048',
            '-t',
            String(options.threads),
            '-np',
            '1',
            '--no-webui',
          ];
          if (options.keyFile) args.push('--api-key-file', options.keyFile);
          child = spawn(options.exe, args, {
            cwd: path.dirname(options.exe),
            stdio: 'ignore',
            windowsHide: true,
          });
          child.on('error', () => undefined);
          try {
            if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
          } catch {
            // priority is a courtesy
          }
        }
        const ready = child ? await waitHealthy(url, 240_000, fetchImpl) : false;
        try {
          return await work(async (name, lines) => {
            if (ready) {
              const text = await chat(url, options.keyFile, buildPrompt(name, lines), 300_000, fetchImpl);
              if (text) return { text, model: 'big' as const };
            }
            return { text: await this.quick(name, lines), model: 'quick' as const };
          });
        } finally {
          if (child && !child.killed) child.kill();
        }
      };
      const result = busy.then(run, run);
      busy = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

export type DigestLlm = ReturnType<typeof createDigestLlm>;
