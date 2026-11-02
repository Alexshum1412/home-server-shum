/**
 * The pages of the reports: made from numbers the portal already has (the state of the PC, the forecast of the disk, the
 * journal, the tasks and events of a person). Every block has a fixed height, so the picture has the exact size of the
 * content. Charts are plain SVG: no scripts, no pictures from outside.
 */
import type { Alert, MetricsPoint, SystemResponse } from '../../../shared/api.ts';
import type { DiskForecast, Incident } from '../../../shared/extras.ts';

export interface ReportPage {
  title: string;
  /** One or two sentences for the chat: the main thing. */
  summary: string;
  html: string;
  width: number;
  height: number;
}

const W = 1000;
const esc = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const gb = (bytes: number | null | undefined): string =>
  bytes === null || bytes === undefined
    ? '—'
    : `${(bytes / 1024 ** 3).toFixed(bytes >= 100 * 1024 ** 3 ? 0 : 1)} ГБ`;

const LEVEL_COLOR = { ok: '#1f9d57', warning: '#d98a00', error: '#d1342b', unknown: '#7a8a98' } as const;
const LEVEL_TEXT = {
  ok: 'Всё в порядке',
  warning: 'Есть предупреждения',
  error: 'Есть проблемы',
  unknown: 'Нет данных',
} as const;

const STYLE = `
*{box-sizing:border-box;margin:0;padding:0}
body{width:${W}px;background:#f1f5f9;color:#16222e;font-family:'Segoe UI',Arial,sans-serif;font-size:15px}
.head{height:130px;padding:26px 36px;color:#fff;display:flex;justify-content:space-between;align-items:flex-start}
.head h1{font-size:30px;font-weight:700}.head p{opacity:.9;margin-top:6px;font-size:15px}
.badge{padding:9px 18px;border-radius:999px;background:rgba(255,255,255,.2);font-weight:700;font-size:16px}
.sec{margin:14px 28px 0;padding:14px 20px;background:#fff;border-radius:14px;box-shadow:0 1px 3px rgba(0,0,0,.08);overflow:hidden}
.sec h2{font-size:17px;margin-bottom:10px;color:#2a3b4c}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.tile{background:#f1f5f9;border-radius:12px;padding:12px 14px;height:92px}
.tile b{display:block;font-size:30px;line-height:1.1;margin-top:6px}.tile span{color:#6a7b8b;font-size:13px}
.row{display:flex;align-items:center;gap:12px;height:44px}
.bar{flex:1;height:16px;background:#e3eaf0;border-radius:8px;overflow:hidden}.bar i{display:block;height:100%}
.alert{height:58px;display:flex;gap:12px;align-items:center;border-left:6px solid;padding:6px 12px;margin-bottom:8px;border-radius:8px;background:#fafbfc}
.alert b{display:block}.alert span{color:#566879;font-size:13px}
.ok{color:#1f9d57;font-weight:600;height:40px;display:flex;align-items:center}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:6px 20px}
.prog{height:34px;display:flex;align-items:center;gap:10px}.dot{width:12px;height:12px;border-radius:50%}
.foot{height:60px;padding:18px 36px;color:#6a7b8b;font-size:13px}
.li{height:30px;color:#344a5e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.li small{color:#7a8a98}
svg text{font-family:'Segoe UI',Arial,sans-serif}
`;

const pageHtml = (
  title: string,
  color: string,
  height: number,
  headRight: string,
  sub: string,
  body: string,
): string =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${STYLE}@page{size:${W}px ${height}px;margin:0}html,body{height:${height}px;overflow:hidden}</style></head><body><div class="head" style="background:${color}"><div><h1>${esc(title)}</h1><p>${esc(sub)}</p></div>${headRight}</div>${body}<div class="foot">Составила Оливия · данные с этого компьютера, наружу не уходили</div></body></html>`;

/** A line chart of 0..100 series over time (or free space), as SVG. */
function lineChart(
  series: Array<{ name: string; color: string; points: Array<[number, number | null]> }>,
  width: number,
  height: number,
  max: number,
  unit: string,
): string {
  const left = 44;
  const bottom = 24;
  const plotW = width - left - 10;
  const plotH = height - bottom - 8;
  const all = series.flatMap((s) => s.points.map(([t]) => t));
  const t0 = Math.min(...all);
  const t1 = Math.max(...all);
  const x = (t: number) => left + (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * plotW);
  const y = (v: number) => 8 + plotH - (Math.min(v, max) / max) * plotH;
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const value = max * f;
      return `<line x1="${left}" x2="${width - 10}" y1="${y(value)}" y2="${y(value)}" stroke="#e1e8ee"/><text x="${left - 6}" y="${y(value) + 4}" font-size="11" text-anchor="end" fill="#7a8a98">${Math.round(value)}${unit}</text>`;
    })
    .join('');
  const lines = series
    .map((s) => {
      const parts: string[] = [];
      let pen = false;
      for (const [t, v] of s.points) {
        if (v === null) {
          pen = false;
          continue;
        }
        parts.push(`${pen ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`);
        pen = true;
      }
      return `<path d="${parts.join(' ')}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round"/>`;
    })
    .join('');
  const hours = (t: number) =>
    new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const legend = series
    .map(
      (s, i) =>
        `<rect x="${left + i * 130}" y="${height - 14}" width="12" height="4" fill="${s.color}"/><text x="${left + i * 130 + 18}" y="${height - 9}" font-size="12" fill="#566879">${esc(s.name)}</text>`,
    )
    .join('');
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${grid}${lines}<text x="${width - 10}" y="${height - 9}" font-size="11" text-anchor="end" fill="#7a8a98">${hours(t0)} — ${hours(t1)}</text>${legend}</svg>`;
}

const pointsOf = (
  history: MetricsPoint[],
  pick: (p: MetricsPoint) => number | null,
): Array<[number, number | null]> => {
  // At most 120 points on a chart: every n-th reading.
  const step = Math.max(1, Math.ceil(history.length / 120));
  return history.filter((_, i) => i % step === 0).map((p) => [p.t * 1000, pick(p)]);
};

export interface ServerReportInput {
  now: Date;
  system: SystemResponse;
  history: MetricsPoint[];
  forecast: DiskForecast[];
  incidents: Incident[];
  downloads: { active: number; done24h: number };
  internetUp: boolean | null;
}

export function serverReport(input: ServerReportInput): ReportPage {
  const { system, now } = input;
  const level = system.overall.level;
  const color = LEVEL_COLOR[level];
  const when = now.toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short' });

  const cpu = system.cpu.usagePercent.value;
  const memUsed = system.memory.usedBytes.value;
  const memPct =
    memUsed !== null && system.memory.totalBytes > 0
      ? Math.round((memUsed / system.memory.totalBytes) * 100)
      : null;
  const uptimeS = system.server.uptimeSeconds.value;
  const uptime =
    uptimeS === null
      ? '—'
      : uptimeS >= 86400
        ? `${Math.floor(uptimeS / 86400)} дн. ${Math.floor((uptimeS % 86400) / 3600)} ч`
        : `${Math.floor(uptimeS / 3600)} ч ${Math.floor((uptimeS % 3600) / 60)} мин`;
  const temp = system.hardware?.cpuTemperatureC.value ?? system.temperatureC.value;

  let height = 130;
  const blocks: string[] = [];
  const section = (h: number, title: string, body: string) => {
    blocks.push(`<div class="sec" style="height:${h}px"><h2>${esc(title)}</h2>${body}</div>`);
    height += h + 14;
  };

  // warnings
  const alerts: Alert[] = system.alerts;
  const alertShown = alerts.slice(0, 5);
  section(
    58 + Math.max(1, alertShown.length) * 66 - (alertShown.length === 0 ? 26 : 0),
    'Предупреждения',
    alertShown.length === 0
      ? '<div class="ok">✔ Предупреждений нет: всё, что проверяется, в порядке.</div>'
      : alertShown
          .map(
            (a) =>
              `<div class="alert" style="border-color:${a.level === 'critical' ? LEVEL_COLOR.error : a.level === 'warning' ? LEVEL_COLOR.warning : '#3a8fd9'}"><div><b>${esc(a.title)}</b><span>${esc(a.text.slice(0, 120))}</span></div></div>`,
          )
          .join(''),
  );

  // load tiles + chart
  const tile = (name: string, value: string, note: string) =>
    `<div class="tile"><span>${esc(name)}</span><b>${esc(value)}</b><span>${esc(note)}</span></div>`;
  const chartSeries = [
    { name: 'Процессор, %', color: '#3a8fd9', points: pointsOf(input.history, (p) => p.cpu) },
    { name: 'Память, %', color: '#8e5cf0', points: pointsOf(input.history, (p) => p.memory) },
  ].filter((s) => s.points.length > 1);
  section(
    92 + 20 + 14 + 190 + 30,
    'Нагрузка',
    `<div class="tiles">${tile('Процессор', cpu === null ? '—' : `${Math.round(cpu)} %`, `${system.cpu.cores} ядра`)}${tile('Память', memPct === null ? '—' : `${memPct} %`, `${gb(memUsed)} из ${gb(system.memory.totalBytes)}`)}${tile('Температура', temp === null || temp === undefined ? 'нет датчика' : `${Math.round(temp)} °C`, temp === null || temp === undefined ? 'датчик не подключён' : 'процессор')}${tile('Работает без перезапуска', uptime, internetText(input.internetUp))}</div><div style="margin-top:14px">${chartSeries.length > 0 ? lineChart(chartSeries, 920, 190, 100, '%') : '<div class="ok" style="color:#7a8a98">История нагрузки ещё копится.</div>'}</div>`,
  );

  // disks
  const volumes = system.volumes.filter((v) => v.totalBytes);
  section(
    50 + volumes.length * 52,
    'Диски',
    volumes
      .map((v) => {
        const total = v.totalBytes as number;
        const free = v.freeBytes ?? 0;
        const usedPct = Math.round(((total - free) / total) * 100);
        const col = v.lowSpace ? LEVEL_COLOR.error : usedPct > 85 ? LEVEL_COLOR.warning : LEVEL_COLOR.ok;
        return `<div class="row"><b style="width:56px">${esc(v.path.replace(/\\$/, ''))}</b><div class="bar"><i style="width:${usedPct}%;background:${col}"></i></div><span style="width:230px;text-align:right">свободно ${gb(free)} из ${gb(total)}</span></div>`;
      })
      .join(''),
  );

  // forecast of the main volume
  const main = input.forecast.find((f) => f.daysLeft !== null) ?? input.forecast[0];
  section(
    80,
    'Прогноз места',
    main
      ? `<div class="li">${esc(main.volume)}: свободно ${gb(main.freeBytes)}. ${main.daysLeft !== null && main.perDayBytes ? `При нынешней скорости (${gb(main.perDayBytes)} в сутки) место закончится примерно через ${main.daysLeft} дн.` : 'Заметного убывания места нет — прогноз спокойный.'}</div>`
      : '<div class="li">Данных для прогноза пока нет.</div>',
  );

  // programs
  const programs = system.programs.value ?? [];
  const rows = Math.max(1, Math.ceil(programs.length / 2));
  section(
    56 + rows * 40,
    'Программы сервера',
    programs.length === 0
      ? '<div class="li">Супервизор не отвечает: состояние программ неизвестно.</div>'
      : `<div class="cols">${programs
          .map((p) => {
            const okp = p.state === 'running';
            return `<div class="prog"><i class="dot" style="background:${okp ? LEVEL_COLOR.ok : p.state === 'starting' ? LEVEL_COLOR.warning : LEVEL_COLOR.error}"></i><span>${esc(p.title)}${p.restarts > 0 ? ` <small style="color:#d98a00">перезапусков: ${p.restarts}</small>` : ''}</span></div>`;
          })
          .join('')}</div>`,
  );

  // backup and incidents
  const incidents = input.incidents.slice(0, 5);
  section(
    60 + 34 + Math.max(1, incidents.length) * 32,
    'Копии и происшествия',
    `<div class="li">Резервные копии: ${esc(system.backup.message)}</div>${incidents.length === 0 ? '<div class="li"><small>Происшествий за последнее время нет.</small></div>' : incidents.map((i) => `<div class="li"><small>${esc(new Date(i.at).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }))}</small> ${esc(i.title)}</div>`).join('')}`,
  );

  height += 60;
  const summary = `${system.overall.text}. Процессор ${cpu === null ? '—' : `${Math.round(cpu)} %`}, память ${memPct === null ? '—' : `${memPct} %`}${alerts.length > 0 ? `, предупреждений: ${alerts.length}` : ', предупреждений нет'}.`;
  return {
    title: 'Отчёт о состоянии сервера',
    summary,
    width: W,
    height,
    html: pageHtml(
      'Отчёт о состоянии сервера',
      color,
      height,
      `<div class="badge">${LEVEL_TEXT[level]}</div>`,
      `${when}${system.server.hostname ? ` · ${system.server.hostname}` : ''} · версия ${system.server.version}`,
      blocks.join(''),
    ),
  };
}

const internetText = (up: boolean | null): string =>
  up === null ? 'интернет: неизвестно' : up ? 'интернет есть' : 'интернета нет';

export interface WeekReportInput {
  now: Date;
  name: string;
  tasks: string[];
  events: string[];
  deadlines: string[];
  downloads: string[];
}

/** A personal summary of the week ahead: tasks, events, deadlines, what was downloaded. */
export function weekReport(input: WeekReportInput): ReportPage {
  let height = 130;
  const blocks: string[] = [];
  const list = (title: string, items: string[], empty: string) => {
    const shown = items.slice(0, 10);
    const h = 56 + Math.max(1, shown.length) * 34;
    blocks.push(
      `<div class="sec" style="height:${h}px"><h2>${esc(title)}</h2>${shown.length === 0 ? `<div class="li"><small>${esc(empty)}</small></div>` : shown.map((s) => `<div class="li">• ${esc(s)}</div>`).join('')}</div>`,
    );
    height += h + 14;
  };
  list('Дела', input.tasks, 'Срочных дел нет.');
  list('Календарь', input.events, 'Событий в ближайшие дни нет.');
  list('Сроки и гарантии', input.deadlines, 'Ближайших сроков нет.');
  list('Скачано недавно', input.downloads, 'Новых загрузок нет.');
  height += 60;
  const total = input.tasks.length + input.events.length + input.deadlines.length;
  return {
    title: `Сводка недели: ${input.name}`,
    summary:
      total > 0
        ? `Впереди: дел ${input.tasks.length}, событий ${input.events.length}, сроков ${input.deadlines.length}.`
        : 'Ближайшие дни свободны: срочных дел, событий и сроков нет.',
    width: W,
    height,
    html: pageHtml(
      `Сводка недели: ${input.name}`,
      '#3a8fd9',
      height,
      '',
      input.now.toLocaleDateString('ru-RU', { dateStyle: 'full' }),
      blocks.join(''),
    ),
  };
}
