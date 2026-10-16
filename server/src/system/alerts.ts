import type {
  Alert,
  BackupInfo,
  PhysicalDiskInfo,
  Role,
  TailscaleInfo,
  VolumeInfo,
} from '../../../shared/api.ts';
import { formatBytes } from '../lib/time.ts';
import { freePercent } from './volumes.ts';

export type AlertAudience = 'all' | 'admin';

export interface AudienceAlert extends Alert {
  audience: AlertAudience;
}

export interface AlertInputs {
  backup: BackupInfo;
  volumes: readonly VolumeInfo[];
  /** null when the disk probe has no data (then no disk alerts are produced). */
  disks: readonly PhysicalDiskInfo[] | null;
  tailscale: TailscaleInfo;
  servicesConfigError: string | null;
}

export const CRITICAL_FREE_PERCENT = 5;

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

  if (
    tailscale.state === 'stopped' ||
    tailscale.state === 'needs_login' ||
    tailscale.state === 'not_installed'
  ) {
    alerts.push({
      id: 'tailscale-not-running',
      level: 'warning',
      audience: 'all',
      title: 'Удалённый доступ не работает',
      text: [
        'Родственники вне дома (в том числе из других стран) сейчас не смогут открыть семейный сервер.',
        tailscale.reason ? `${tailscale.reason}.` : '',
        'Попросите администратора проверить Tailscale.',
      ]
        .filter(Boolean)
        .join(' '),
    });
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
    .map(({ audience: _audience, ...alert }) => alert);
}
