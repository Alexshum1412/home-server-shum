/**
 * The local language model as a CHOOSER: from the person's sentence it picks one of the fixed tools
 * and fills in what to look for. It does not write answers, does not see any data (only the
 * question and the list of tools), and whatever it says is checked against a schema and against the
 * message itself before anything is used. Only a server on this very PC is ever called.
 */
import { z } from 'zod';
import type { LlmFetch, OliviaLlmConfig } from '../llm.ts';
import { FAQ } from './knowledge.ts';
import { type Plan, TOOLS, type ToolName, topicWords } from './router.ts';

export class ModelUnavailable extends Error {}

const SYSTEM = [
  'Ты — разборщик запросов семейного помощника «Оливия». Выбери ОДИН инструмент для сообщения человека и верни только JSON.',
  'Инструменты:',
  '- faq: вопрос о том, как пользоваться порталом (укажи faqId из списка ниже);',
  '- status: всё ли работает, как дела у сервера;',
  '- disk: сколько свободного места на диске;',
  '- backup: резервные копии, сохранность данных;',
  '- media: найти или предложить фильм, сериал, мультфильм, музыку, аудиокнигу (query — название или тема, 1–4 слова);',
  '- files: найти файл, документ или фотографии по названию (query — 1–4 слова; where — files, photos или any);',
  '- downloads: что с загрузками, очередь загрузок;',
  '- add_download: человек прислал ссылку или магнитную ссылку и хочет скачать (url — ровно как в сообщении);',
  '- calendar: события в календаре на сегодня и завтра;',
  '- unknown: ничего не подходит.',
  'Темы faqId:',
  ...FAQ.map((entry) => `- ${entry.id}: ${entry.topic}`),
  'Поля, которые не нужны, оставь пустой строкой. Ничего не выдумывай: query бери из слов человека.',
].join('\n');

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['tool', 'query', 'where', 'url', 'faqId'],
  properties: {
    tool: { type: 'string', enum: [...TOOLS] },
    query: { type: 'string' },
    where: { type: 'string', enum: ['files', 'photos', 'any', ''] },
    url: { type: 'string' },
    faqId: { type: 'string', enum: ['', ...FAQ.map((entry) => entry.id)] },
  },
} as const;

const answerSchema = z.object({
  tool: z.enum(TOOLS as unknown as [ToolName, ...ToolName[]]),
  query: z.string().max(200).default(''),
  where: z.enum(['files', 'photos', 'any', '']).default(''),
  url: z.string().max(4096).default(''),
  faqId: z.string().max(40).default(''),
});

/** Asks the model which tool fits. Throws ModelUnavailable with a reason that can be shown. */
export async function chooseWithModel(
  message: string,
  config: OliviaLlmConfig,
  fetchImpl: LlmFetch,
  timeoutMs = config.timeoutMs,
): Promise<Plan> {
  let response: Response;
  try {
    response = await fetchImpl(`${config.url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        temperature: 0,
        max_tokens: 90,
        // llama.cpp keeps the long fixed beginning in memory: only the question is read each time.
        cache_prompt: true,
        response_format: { type: 'json_schema', json_schema: { name: 'plan', strict: true, schema } },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: message.slice(0, 600) },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const slow = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new ModelUnavailable(slow ? 'модель не успела ответить' : 'модель не запущена');
  }
  if (!response.ok) throw new ModelUnavailable(`модель ответила ошибкой (${response.status})`);
  let raw: unknown;
  try {
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    raw = JSON.parse(String(body.choices?.[0]?.message?.content ?? ''));
  } catch {
    throw new ModelUnavailable('модель ответила не так, как нужно');
  }
  const parsed = answerSchema.safeParse(raw);
  if (!parsed.success) throw new ModelUnavailable('модель ответила не так, как нужно');
  const { tool, where, faqId } = parsed.data;
  // The address must be a piece of the person's own message: the model cannot invent one.
  const url = parsed.data.url !== '' && message.includes(parsed.data.url) ? parsed.data.url : '';
  if (tool === 'add_download' && url === '') throw new ModelUnavailable('в сообщении нет ссылки');
  // What to look for may come only from words of the question (a summary of them is fine, an invention is not).
  const spoken = new Set(topicWords(message, 40).split(' '));
  const query = topicWords(parsed.data.query)
    .split(' ')
    .filter(
      (word) =>
        word !== '' &&
        [...spoken].some((said) => said.startsWith(word.slice(0, 4)) || word.startsWith(said.slice(0, 4))),
    )
    .join(' ');
  return {
    tool,
    query,
    url,
    faqId: FAQ.some((entry) => entry.id === faqId) ? faqId : '',
    where: where === '' ? 'any' : where,
    confident: false,
  };
}
