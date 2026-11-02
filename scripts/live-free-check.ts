// Live check of the free-model router through the same code Olivia uses: node scripts/live-free-check.ts
import { readFileSync } from 'node:fs';
import { cleanFreeAnswer, streamChat } from '../server/src/olivia/chat.ts';

const key = readFileSync('C:\\FamilyServer\\secrets\\freellm.key', 'utf8').trim();
const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
for (const question of ['Столица Беларуси? Ответь одним предложением.', 'Дай совет, как быстро выучить 10 немецких слов.']) {
  const started = Date.now();
  let raw = '';
  let pieces = 0;
  for await (const piece of streamChat(
    'http://127.0.0.1:3101/v1',
    headers,
    'auto',
    [
      { role: 'system', content: 'Ты Оливия, помощница семьи. Отвечай по-русски, коротко.' },
      { role: 'user', content: question },
    ],
    900,
    AbortSignal.timeout(70_000),
    fetch,
  )) {
    raw += piece;
    pieces += 1;
  }
  console.log(`${Date.now() - started} ms, ${pieces} pieces\nRAW:   ${JSON.stringify(raw.slice(0, 160))}\nCLEAN: ${JSON.stringify(cleanFreeAnswer(raw).slice(0, 300))}\n`);
}
