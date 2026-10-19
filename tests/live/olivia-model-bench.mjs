// A real measurement of the local model on THIS PC (never touches the family's data).
//
// It asks the running llama-server (OLIVIA_LLM_URL, default http://127.0.0.1:8081/v1, with the access key read from
// the portal's data folder) a fixed list of questions through the portal's own chooser, and prints per question: the
// tool the model chose, the tool the rules chose, how long the answer took. At the end: the accuracy of both and the
// memory of the llama-server process before, during and after.
//
//   node tests/live/olivia-model-bench.mjs [--rounds 2] [--data C:/FamilyServer/data/dashboard]
//
// Needs the model started (scripts\service.cmd start llama). Nothing is written anywhere except the console.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseWithModel } from '../../server/src/olivia/assistant/model.ts';
import { routeByRules } from '../../server/src/olivia/assistant/router.ts';
import { llamaKeyFile } from '../../server/src/olivia/llm-key.ts';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const rounds = Number(flag('rounds', '2'));
const dataDir = flag('data', 'C:/FamilyServer/data/dashboard');
const url = flag('url', 'http://127.0.0.1:8081/v1');
const here = path.dirname(fileURLToPath(import.meta.url));
void here;

const QUESTIONS = [
  ['Сколько свободного места на диске?', 'disk'],
  ['Всё ли в порядке с сервером?', 'status'],
  ['Почему не открывается кинотеатр, что с сервером сегодня', 'status'],
  ['Когда была последняя резервная копия?', 'backup'],
  ['Сделана ли копия вчера ночью', 'backup'],
  ['Найди фильм про космос', 'media'],
  ['Хочу посмотреть что-нибудь смешное вечером', 'media'],
  ['Найди мои фотографии с дачи', 'files'],
  ['Где лежит договор аренды', 'files'],
  ['Как загрузить файл с телефона?', 'faq'],
  ['Как сменить пароль', 'faq'],
  ['Что скачивается сейчас?', 'downloads'],
  ['Как продвигается моя загрузка', 'downloads'],
  ['Скачай https://example.org/file.zip', 'add_download'],
  ['Добавь в загрузки magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567', 'add_download'],
  ['Что у нас в календаре на завтра?', 'calendar'],
  ['Какие события на этой неделе', 'calendar'],
  ['Расскажи анекдот про кота', 'unknown'],
  ['Какая завтра погода в Париже', 'unknown'],
  ['Сколько будет два плюс два', 'unknown'],
];

function processMemory() {
  const out = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      '(Get-Process llama-server -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum).Sum',
    ],
    { encoding: 'utf8' },
  );
  const bytes = Number(out.stdout.trim());
  return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1024 / 1024) : null;
}

const config = {
  url,
  model: 'local',
  timeoutMs: 120_000,
  keyFile: llamaKeyFile(dataDir),
};

const before = processMemory();
console.log(`Память llama-server до начала: ${before ?? 'процесс не найден'} МБ`);
if (before === null) {
  console.error('Модель не запущена: scripts\\service.cmd start llama');
  process.exit(1);
}

const times = [];
let peak = before;
let modelRight = 0;
let rulesRight = 0;
let rulesConfident = 0;
let failures = 0;
let total = 0;
for (let round = 1; round <= rounds; round += 1) {
  for (const [question, expected] of QUESTIONS) {
    const rules = routeByRules(question);
    const started = performance.now();
    let chosen = 'ОШИБКА';
    try {
      chosen = (await chooseWithModel(question, config, fetch)).tool;
    } catch (error) {
      failures += 1;
      chosen = `ОШИБКА (${error instanceof Error ? error.message : 'неизвестно'})`;
    }
    const ms = Math.round(performance.now() - started);
    times.push(ms);
    peak = Math.max(peak, processMemory() ?? peak);
    total += 1;
    if (chosen === expected) modelRight += 1;
    if (rules.tool === expected) rulesRight += 1;
    if (rules.confident) rulesConfident += 1;
    console.log(
      `${round}. ${ms.toString().padStart(5)} мс  модель: ${chosen.padEnd(12)} правила: ${rules.tool.padEnd(12)}${rules.confident ? '(уверенно)' : ''}  ожидалось: ${expected}  «${question.slice(0, 48)}»`,
    );
  }
}
times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)] ?? 0;
const p90 = times[Math.floor(times.length * 0.9)] ?? 0;
console.log('');
console.log(`Вопросов: ${total}, ошибок связи или формата: ${failures}`);
console.log(
  `Модель выбрала верно: ${modelRight} из ${total}; правила — ${rulesRight} из ${total} (уверенных ответов правил: ${rulesConfident})`,
);
console.log(
  `Время ответа: медиана ${median} мс, 90-й процентиль ${p90} мс, максимум ${times[times.length - 1] ?? 0} мс`,
);
console.log(`Память llama-server: до ${before} МБ, пик ${peak} МБ, после ${processMemory() ?? '?'} МБ`);
