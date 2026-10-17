import type {
  Alert,
  BackupInfo,
  HealthLevel,
  Measured,
  PhysicalDiskInfo,
  ProgramStatus,
  Role,
  TailscaleInfo,
  TailscaleState,
  VolumeInfo,
} from '../../../shared/api.ts';
import { formatBytes } from '../lib/format.ts';
import { freePercent } from './volumes.ts';

export type AlertAudience = 'all' | 'admin';

export interface AudienceAlert extends Alert {
  audience: AlertAudience;
  /** Admin variant of `text` with technical detail; everyone else gets the plain `text`. */
  adminText?: string;
}

export interface AlertInputs {
  backup: BackupInfo;
  volumes: readonly VolumeInfo[];
  /** null when the disk probe has no data (then no disk alerts are produced). */
  disks: readonly PhysicalDiskInfo[] | null;
  tailscale: TailscaleInfo;
  servicesConfigError: string | null;
  /** Supervisor state; omitted in old callers and tests. */
  programs?: Measured<ProgramStatus[]>;
}

export const CRITICAL_FREE_PERCENT = 5;

/** Tailscale states that mean remote access is confirmed to be down. */
export const TAILSCALE_DOWN_STATES: ReadonlySet<TailscaleState> = new Set<TailscaleState>([
  'stopped',
  'needs_login',
  'not_installed',
]);

/** Ends a reason with a full stop unless it already ends with punctuation. */
function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…)]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Alerts are built only from real probe results; nothing is assumed. */
export function buildAlerts(inputs: AlertInputs): AudienceAlert[] {
  const alerts: AudienceAlert[] = [];
  const { backup, tailscale } = inputs;

  if (backup.state === 'not_configured') {
    alerts.push({
      id: 'backup-not-configured',
      level: 'warning',
      audience: 'all',
      title: 'Резервные копии не настроены',
      text: 'Фотографии и документы на домашнем сервере пока хранятся в одном экземпляре — копии нет. Если диск выйдет из строя, их не удастся восстановить. Попросите администратора настроить резервное копирование.',
    });
  } else if (backup.state === 'failed') {
    alerts.push({
      id: 'backup-failed',
      level: 'critical',
      audience: 'all',
      title: 'Резервное копирование не удалось',
      text: 'Последняя попытка сохранить копию семейных файлов завершилась ошибкой. Сообщите администратору.',
    });
  } else if (backup.state === 'stale') {
    alerts.push({
      id: 'backup-stale',
      level: 'warning',
      audience: 'all',
      title: 'Резервная копия устарела',
      text: 'Свежей копии семейных файлов нет больше недели — новые фотографии и документы не защищены. Сообщите администратору.',
    });
  }

  for (const volume of inputs.volumes) {
    if (!volume.lowSpace) continue;
    const percent = freePercent(volume);
    const free = volume.freeBytes === null ? 'мало' : formatBytes(volume.freeBytes);
    const critical = percent !== null && percent < CRITICAL_FREE_PERCENT;
    alerts.push({
      id: `volume-low-${volume.path.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'root'}`,
      level: critical ? 'critical' : 'warning',
      audience: 'all',
      title: `Заканчивается место на диске ${volume.path}`,
      text: `Свободно ${free}${percent === null ? '' : ` (${Math.floor(percent)} %)`}. Новые фото, фильмы и файлы могут перестать сохраняться — попросите администратора освободить место.`,
    });
  }

  inputs.disks?.forEach((disk, index) => {
    if (disk.health !== 'warning' && disk.health !== 'unhealthy') return;
    alerts.push({
      id: `disk-${index}`,
      level: 'warning',
      audience: 'admin',
      title: `Проблема с диском «${disk.model}»`,
      text:
        disk.note ??
        `Windows сообщает состояние диска «${disk.rawHealth || 'неизвестно'}». Проверьте SMART и убедитесь, что есть резервная копия.`,
    });
  });

  // Only states Tailscale itself confirmed. 'unknown' (probe error, timeout, "Starting") is not
  // evidence of an outage, so it never raises this alert.
  if (TAILSCALE_DOWN_STATES.has(tailscale.state)) {
    alerts.push({
      id: 'tailscale-not-running',
      level: 'warning',
      audience: 'all',
      title: 'Удалённый доступ не работает',
      // Family members get plain words only; the technical reason is for the admin.
      text: 'Родственники вне дома сейчас не смогут открыть семейный сервер. Сообщите администратору.',
      adminText: [
        'Родственники вне дома (в том числе из других стран) сейчас не смогут открыть семейный сервер.',
        tailscale.reason ? asSentence(tailscale.reason) : '',
        'Проверьте Tailscale на сервере.',
      ]
        .filter(Boolean)
        .join(' '),
    });
  }

  const programs = inputs.programs;
  if (programs && programs.value === null && programs.reason) {
    alerts.push({
      id: 'supervisor-not-running',
      level: 'warning',
      audience: 'admin',
      title: 'Супервизор не запущен',
      text: `${asSentence(programs.reason)} Запустите портал командой start.cmd (папка scripts проекта) — супервизор запустится вместе с ним.`,
    });
  }
  for (const program of programs?.value ?? []) {
    if (program.state === 'backoff') {
      alerts.push({
        id: `program-crash-${program.name}`,
        level: 'critical',
        audience: 'all',
        title: `«${program.title}» перезапускается после сбоя`,
        text: 'Сервис завершился с ошибкой и сейчас перезапускается автоматически. Если это повторяется, сообщите администратору.',
        adminText: `Сбоев с момента запуска супервизора: ${program.restarts}. Подробности — в журнале supervisor.log (папка logs данных портала).`,
      });
    } else if (program.state === 'stopped') {
      alerts.push({
        id: `program-stopped-${program.name}`,
        level: 'warning',
        audience: 'admin',
        title: `«${program.title}» остановлен`,
        text: 'Программа остановлена вручную и не работает. Запустить снова: start.cmd или команда start супервизора.',
      });
    } else if (program.restarts >= 3) {
      alerts.push({
        id: `program-unstable-${program.name}`,
        level: 'warning',
        audience: 'admin',
        title: `«${program.title}» работает нестабильно`,
        text: `После сбоев программа перезапускалась ${program.restarts} раз(а) с момента запуска супервизора. Посмотрите supervisor.log и журналы программы.`,
      });
    }
  }

  if (inputs.servicesConfigError) {
    alerts.push({
      id: 'services-config-error',
      level: 'warning',
      audience: 'admin',
      title: 'Ошибка в файле services.json',
      text: `${inputs.servicesConfigError}. Пока файл не исправлен, список сервисов пуст.`,
    });
  }

  return alerts;
}

export function alertsForRole(alerts: readonly AudienceAlert[], role: Role): Alert[] {
  return alerts
    .filter((alert) => role === 'admin' || alert.audience === 'all')
    .map(({ audience: _audience, adminText, ...alert }) =>
      role === 'admin' && adminText ? { ...alert, text: adminText } : alert,
    );
}

const OVERALL_TEXT: Record<HealthLevel, string> = {
  ok: 'Всё работает',
  warning: 'Работает, есть предупреждения',
  error: 'Есть проблемы, нужна помощь администратора',
  unknown: 'Нет данных о состоянии сервера',
};

/** One level for the whole server from the alerts this user can see and the core measurements. */
export function overallHealth(
  alerts: readonly Alert[],
  coreMeasured: boolean,
): { level: HealthLevel; text: string } {
  let level: HealthLevel = 'ok';
  if (alerts.some((a) => a.level === 'critical')) level = 'error';
  else if (alerts.some((a) => a.level === 'warning')) level = 'warning';
  else if (!coreMeasured) level = 'unknown';
  return { level, text: OVERALL_TEXT[level] };
}
