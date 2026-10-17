/**
 * Independent diagnosis of the family server (scripts\doctor.cmd): the same measurements as the
 * portal's «Состояние системы», plus checks made directly on the machine, so it works when the
 * portal itself is down. Pure evaluation lives here; the CLI collects the inputs.
 */
import type { HealthLevel, SystemResponse } from '../../../shared/api.ts';

export type CheckLevel = 'ok' | 'warn' | 'error' | 'unknown';

export interface Check {
  id: string;
  level: CheckLevel;
  title: string;
  text: string;
}

/** Result of asking one local HTTP address for its health. */
export interface HttpProbe {
  url: string;
  ok: boolean;
  status: number | null;
  detail: string | null;
}

/** Read-only facts about Windows (script `doctorHost`); null when they could not be read. */
export interface HostFacts {
  tasks: Array<{ name: string; state: string; lastResult: number | null }>;
  firewall: Array<{ name: string; enabled: boolean }>;
  lanRule: boolean;
  uacEnabled: boolean | null;
}

export interface DoctorInputs {
  system: SystemResponse;
  portal: HttpProbe;
  jellyfin: HttpProbe | null;
  host: HostFacts | null;
  hostError: string | null;
  lanBind: readonly string[];
  /** Listening sockets of the portal port: addresses it is bound to. */
  portalBoundTo: readonly string[];
}

const HEALTH_TO_CHECK: Record<HealthLevel, CheckLevel> = {
  ok: 'ok',
  warning: 'warn',
  error: 'error',
  unknown: 'unknown',
};

function formatBytes(bytes: number): string {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1).replace('.', ',')} ${units[index]}`;
}

export function evaluate(inputs: DoctorInputs): Check[] {
  const { system, portal, jellyfin, host } = inputs;
  const checks: Check[] = [];
  const add = (id: string, level: CheckLevel, title: string, text: string) =>
    checks.push({ id, level, title, text });

  add(
    'portal',
    portal.ok ? 'ok' : 'error',
    'Портал',
    portal.ok
      ? `отвечает (${portal.url}), версия ${system.server.version}`
      : `не отвечает на ${portal.url}${portal.detail ? `: ${portal.detail}` : ''}. Запустить: scripts\\start.cmd`,
  );

  const programs = system.programs;
  if (programs.value === null) {
    add(
      'supervisor',
      'error',
      'Супервизор',
      `${programs.reason ?? 'не запущен'}. Запустить: scripts\\start.cmd`,
    );
  } else {
    for (const program of programs.value) {
      const fine = program.state === 'running' || program.state === 'external';
      add(
        `program-${program.name}`,
        fine ? (program.restarts >= 3 ? 'warn' : 'ok') : program.state === 'stopped' ? 'warn' : 'error',
        `Программа «${program.title}»`,
        `${PROGRAM_STATE[program.state] ?? program.state}; перезапусков после сбоя: ${program.restarts}` +
          (fine ? '' : `. Команда: scripts\\service.cmd restart ${program.name}`),
      );
    }
  }

  if (jellyfin) {
    add(
      'jellyfin',
      jellyfin.ok ? 'ok' : 'error',
      'Кинотеатр (Jellyfin) отвечает',
      jellyfin.ok
        ? jellyfin.url
        : `нет ответа от ${jellyfin.url}${jellyfin.detail ? `: ${jellyfin.detail}` : ''}. Запасной просмотр в портале: «Кинотеатр» → «Запасной просмотр»`,
    );
  }

  const tailscale = system.tailscale;
  add(
    'tailscale',
    tailscale.state === 'running' ? 'ok' : tailscale.state === 'unknown' ? 'unknown' : 'error',
    'Удалённый доступ (Tailscale)',
    tailscale.state === 'running'
      ? `работает${tailscale.dnsName ? `, адрес ${tailscale.dnsName}` : ''}`
      : (tailscale.reason ?? `состояние: ${tailscale.state}`),
  );

  for (const volume of system.volumes) {
    const free = volume.freeBytes;
    add(
      `volume-${volume.path}`,
      free === null ? 'unknown' : volume.lowSpace ? 'warn' : 'ok',
      `Место на диске ${volume.path}`,
      free === null
        ? (volume.reason ?? 'нет данных')
        : `свободно ${formatBytes(free)} из ${formatBytes(volume.totalBytes ?? 0)}${volume.lowSpace ? ' — мало' : ''}`,
    );
  }

  const disks = system.physicalDisks;
  if (disks.value === null) {
    add('disks', 'unknown', 'Физические диски', disks.reason ?? 'нет данных');
  } else {
    for (const disk of disks.value) {
      add(
        `disk-${disk.model}`,
        disk.health === 'healthy' ? 'ok' : disk.health === 'unknown' ? 'unknown' : 'warn',
        `Диск ${disk.model}`,
        `${disk.rawHealth || 'нет данных'}${disk.note ? `. ${disk.note}` : ''}`,
      );
    }
  }

  add(
    'backup',
    system.backup.state === 'ok'
      ? 'ok'
      : system.backup.state === 'failed'
        ? 'error'
        : system.backup.state === 'unknown'
          ? 'unknown'
          : 'warn',
    'Резервная копия',
    system.backup.message,
  );

  const printer = system.printer;
  add(
    'printer',
    printer.state === 'ready' || printer.state === 'printing'
      ? 'ok'
      : printer.state === 'not_configured'
        ? 'unknown'
        : 'warn',
    'Принтер',
    printer.message,
  );

  if (host) {
    for (const task of host.tasks) {
      add(
        `task-${task.name}`,
        task.state === 'Disabled' ? 'warn' : 'ok',
        `Задача планировщика «${task.name}»`,
        `${task.state}${task.lastResult === null ? '' : `, последний результат ${task.lastResult}`}`,
      );
    }
    const off = host.firewall.filter((profile) => !profile.enabled);
    add(
      'firewall',
      off.length > 0 ? 'warn' : 'ok',
      'Брандмауэр Windows',
      off.length > 0
        ? `выключен для: ${off.map((p) => p.name).join(', ')}. Включите в «Безопасность Windows».`
        : 'включён для всех профилей',
    );
    if (host.uacEnabled === false) {
      add(
        'uac',
        'warn',
        'Контроль учётных записей (UAC)',
        'выключен: программы, включая портал, работают с полными правами администратора. Рекомендуем включить.',
      );
    }
    if (inputs.lanBind.length > 0) {
      add(
        'lan',
        host.lanRule ? 'ok' : 'warn',
        'Запасной адрес в домашней сети',
        host.lanRule
          ? `включён (${inputs.lanBind.join(', ')}), правило брандмауэра есть`
          : `задан в .env (${inputs.lanBind.join(', ')}), но правила брандмауэра нет: с других устройств не откроется`,
      );
    }
  } else {
    add('host', 'unknown', 'Настройки Windows', inputs.hostError ?? 'не удалось прочитать');
  }

  const exposed = inputs.portalBoundTo.filter((address) => !['127.0.0.1', '::1'].includes(address));
  const unexpected = exposed.filter((address) => !inputs.lanBind.includes(address));
  if (inputs.portalBoundTo.length > 0) {
    add(
      'listen',
      unexpected.length > 0 ? 'error' : 'ok',
      'Где слушает портал',
      unexpected.length > 0
        ? `слушает лишние адреса: ${unexpected.join(', ')} — должен только 127.0.0.1${
            inputs.lanBind.length > 0 ? ` и ${inputs.lanBind.join(', ')}` : ''
          }`
        : `${inputs.portalBoundTo.join(', ')}`,
    );
  }

  // The other alerts repeat the checks above; only what has no check of its own is added.
  for (const alert of system.alerts.filter((a) => a.id === 'services-config-error')) {
    add(`alert-${alert.id}`, 'warn', alert.title, alert.text);
  }

  add('overall', HEALTH_TO_CHECK[system.overall.level], 'Итог портала', system.overall.text);
  return checks;
}

const PROGRAM_STATE: Record<string, string> = {
  running: 'работает',
  starting: 'запускается',
  backoff: 'сбой, ждёт перезапуска',
  stopping: 'останавливается',
  stopped: 'остановлен',
  external: 'работает отдельно от супервизора',
};

/** 0 — всё хорошо, 1 — есть предупреждения, 2 — есть ошибки. */
export function exitCodeOf(checks: readonly Check[]): 0 | 1 | 2 {
  if (checks.some((check) => check.level === 'error')) return 2;
  if (checks.some((check) => check.level === 'warn')) return 1;
  return 0;
}

const MARK: Record<CheckLevel, string> = {
  ok: 'ОК         ',
  warn: 'ВНИМАНИЕ   ',
  error: 'ОШИБКА     ',
  unknown: 'НЕТ ДАННЫХ ',
};

export function renderReport(checks: readonly Check[], when: Date): string {
  const lines = [`Диагностика семейного сервера — ${when.toLocaleString('ru-RU')}`, ''];
  for (const check of checks) lines.push(`[${MARK[check.level].trim()}] ${check.title}: ${check.text}`);
  const errors = checks.filter((c) => c.level === 'error').length;
  const warnings = checks.filter((c) => c.level === 'warn').length;
  lines.push(
    '',
    errors > 0
      ? `Итог: ЕСТЬ ОШИБКИ (ошибок: ${errors}, предупреждений: ${warnings})`
      : warnings > 0
        ? `Итог: есть предупреждения (${warnings})`
        : 'Итог: всё в порядке',
  );
  return lines.join('\n');
}
