/**
 * Why did the server stop and start again by itself? The portal only knows that its last run did not end on purpose;
 * the reason lives in the Windows event log (a sudden power loss, a blue screen, a restart for updates, a hardware
 * error). This reads the few events around the moment the portal was last seen alive and says in plain words what
 * happened. Nothing is guessed: when the log says nothing, the answer says that.
 */
import { execFile } from 'node:child_process';

export interface LogEvent {
  id: number;
  provider: string;
  at: Date;
  data: Record<string, string>;
}

type Exec = (file: string, args: string[]) => Promise<string>;

/** wevtutil writes in the ANSI code page of Windows (1251 on a Russian one), not in UTF-8. */
const run: Exec = (file, args) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: 15_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' },
      (_error, stdout) => resolve(new TextDecoder('windows-1251').decode(stdout ?? Buffer.alloc(0))),
    );
  });

/** Parses the XML of `wevtutil qe … /f:xml` (one <Event> per event). */
export function parseEvents(xml: string): LogEvent[] {
  const events: LogEvent[] = [];
  for (const chunk of xml.split(/(?=<Event[ >])/)) {
    const id = /<EventID[^>]*>(\d+)<\/EventID>/.exec(chunk)?.[1];
    const at = /<TimeCreated SystemTime=['"]([^'"]+)['"]/.exec(chunk)?.[1];
    if (!id || !at) continue;
    const data: Record<string, string> = {};
    for (const match of chunk.matchAll(/<Data Name=['"]([^'"]+)['"]\s*>([^<]*)<\/Data>/g)) {
      data[match[1] ?? ''] = (match[2] ?? '').trim();
    }
    events.push({
      id: Number(id),
      provider: /<Provider Name=['"]([^'"]+)['"]/.exec(chunk)?.[1] ?? '',
      at: new Date(at),
      data,
    });
  }
  return events;
}

/** The stop codes that say the most about a failing computer. */
const STOP_CODES: Record<number, string> = {
  26: 'ошибка управления памятью — часто это неисправная оперативная память: запустите «Средство проверки памяти Windows» (mdsched)',
  80: 'обращение к неверной области памяти — подозрение на оперативную память или драйвер',
  292: 'аппаратная ошибка процессора, памяти или шины',
  307: 'зависание драйвера или устройства',
  159: 'сбой управления питанием драйвером',
  59: 'сбой системной службы или драйвера',
  126: 'необработанная ошибка драйвера',
  209: 'драйвер обратился к неверной памяти',
  10: 'драйвер обратился к неверной памяти',
};

function stopCode(raw: string | undefined): { hex: string; hint: string } | null {
  if (!raw) return null;
  const text = raw.trim();
  const value = /^0x/i.test(text) ? Number.parseInt(text, 16) : Number.parseInt(text, 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return { hex: `0x${value.toString(16).toUpperCase()}`, hint: STOP_CODES[value] ?? '' };
}

const hhmm = (date: Date) => date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/** What the events say, in plain Russian. `bootedAt` — when Windows itself last started. */
export function explainShutdown(
  events: LogEvent[],
  context: { previousAt: Date | null; bootedAt: Date },
): string {
  const { previousAt, bootedAt } = context;
  const near = previousAt
    ? events.filter((event) => event.at.getTime() >= previousAt.getTime() - 5 * 60_000)
    : events;
  const planned = near.find((event) => event.id === 1074);
  const bugcheck = near.find((event) => event.id === 1001 && /BugCheck/i.test(event.provider));
  const power = near.find((event) => event.id === 41);
  const unexpected = near.find((event) => event.id === 6008);
  const hardware = near.find((event) => /WHEA/i.test(event.provider));

  // The computer did not restart: only the portal itself stopped.
  if (previousAt && bootedAt.getTime() < previousAt.getTime() - 60_000 && !power && !planned && !bugcheck) {
    return 'Компьютер не перезагружался: остановился только сам портал (сбой программы или её принудительное закрытие).';
  }
  if (planned) {
    const who = planned.data.param1?.split('\\').pop() || 'программа';
    const why = planned.data.param3 || 'причина не указана';
    const kind = /power ?off|выключ/i.test(planned.data.param5 ?? '') ? 'выключили' : 'перезагрузили';
    return `Компьютер ${kind} штатно, командой Windows (по запросу «${who}», в журнале: ${why}) в ${hhmm(planned.at)}. Это не поломка.`;
  }
  if (bugcheck || (power && Number(power.data.BugcheckCode) > 0)) {
    const code = stopCode(power?.data.BugcheckCode) ?? stopCode(bugcheck?.data.param1?.split(' ')[0]);
    return `Windows упала с синим экраном${code ? ` (код ${code.hex}${code.hint ? `: ${code.hint}` : ''})` : ''} и перезагрузилась сама. Это сбой системы, драйвера или оборудования.`;
  }
  if (hardware) {
    return `Windows записала аппаратную ошибку (${hhmm(hardware.at)}: процессор, память или диск) — после неё компьютер выключился. Нужна проверка оборудования.`;
  }
  if (power) {
    const button = Number(power.data.PowerButtonTimestamp ?? 0) > 0;
    return button
      ? 'Питание выключили кнопкой (удержание) или компьютер завис и его выключили принудительно.'
      : 'Компьютер выключился внезапно: пропало питание (розетка, удлинитель, электричество), либо он завис, и его выключили.';
  }
  if (unexpected) {
    return `Windows записала, что предыдущее выключение было внезапным (${hhmm(unexpected.at)}): скорее всего пропало питание или компьютер завис.`;
  }
  return 'Windows не записала причину: чаще всего это значит, что питание пропало мгновенно (электричество, розетка, блок питания).';
}

/** Looks the reason up in the Windows event log. Never throws: on any trouble it says it could not find out. */
export async function findShutdownReason(options: {
  previousAt: Date | null;
  now: Date;
  bootedAt: Date;
  exec?: Exec;
  platform?: NodeJS.Platform;
}): Promise<string> {
  if ((options.platform ?? process.platform) !== 'win32')
    return 'Причина неизвестна (журнал Windows недоступен).';
  const from = new Date((options.previousAt?.getTime() ?? options.now.getTime() - 3_600_000) - 10 * 60_000);
  const query =
    `*[System[TimeCreated[@SystemTime>='${from.toISOString()}'] and ` +
    `(EventID=41 or EventID=1074 or EventID=6008 or EventID=1001 or EventID=1076 or Provider[@Name='Microsoft-Windows-WHEA-Logger'])]]`;
  try {
    const xml = await (options.exec ?? run)('wevtutil.exe', [
      'qe',
      'System',
      `/q:${query}`,
      '/f:xml',
      '/c:40',
    ]);
    return explainShutdown(parseEvents(xml), { previousAt: options.previousAt, bootedAt: options.bootedAt });
  } catch {
    return 'Причину узнать не удалось (журнал Windows не прочитался).';
  }
}
