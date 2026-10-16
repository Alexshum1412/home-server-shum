import type { DiskHealth, PhysicalDiskInfo } from '../../../shared/api.ts';
import { formatBytes } from '../lib/time.ts';

/** Seagate drives in a firmware-failure state report an internal identity such as "ST_M13FQBL". */
const FIRMWARE_IDENTITY = /^ST_[A-Z0-9]+$/;
const FIRMWARE_IDENTITY_MAX_BYTES = 16e9;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

function mapHealth(raw: string): DiskHealth {
  switch (raw.toLowerCase()) {
    case 'healthy':
      return 'healthy';
    case 'warning':
      return 'warning';
    case 'unhealthy':
      return 'unhealthy';
    default:
      return 'unknown';
  }
}

/** Normalises the output of the `physicalDisks` PowerShell script. */
export function parsePhysicalDisks(raw: unknown): PhysicalDiskInfo[] {
  const list = Array.isArray(raw) ? raw : asRecord(raw) ? [raw] : [];
  const disks: PhysicalDiskInfo[] = [];
  for (const entry of list) {
    const item = asRecord(entry);
    if (!item) continue;
    const model = text(item.model) || 'Неизвестный диск';
    const size = typeof item.sizeBytes === 'number' ? item.sizeBytes : Number(text(item.sizeBytes));
    const sizeBytes = Number.isFinite(size) && size >= 0 && text(item.sizeBytes) !== '' ? size : null;
    const busType = text(item.busType) || 'Unknown';
    const rawHealth = text(item.health);
    let health = mapHealth(rawHealth);
    let note: string | null = null;
    if (FIRMWARE_IDENTITY.test(model) && sizeBytes !== null && sizeBytes < FIRMWARE_IDENTITY_MAX_BYTES) {
      health = 'warning';
      note =
        `Диск определяется некорректно (модель «${model}», ${formatBytes(sizeBytes)} вместо ожидаемого объёма). ` +
        'Так бывает при сбое прошивки или неисправности накопителя Seagate. ' +
        'Не инициализируйте и не форматируйте его — нужна проверка кабелей, BIOS и SMART.';
    } else if (busType.toUpperCase() === 'USB') {
      note = 'Съёмный USB-накопитель';
    }
    disks.push({
      model,
      sizeBytes,
      mediaType: text(item.mediaType) || 'Unspecified',
      busType,
      health,
      rawHealth,
      rawOperational: text(item.operational),
      note,
    });
  }
  return disks;
}
