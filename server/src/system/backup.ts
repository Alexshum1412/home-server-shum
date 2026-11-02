import path from 'node:path';
import type { BackupInfo, BackupTargetView } from '../../../shared/api.ts';
import { BACKUP_STATUS_FILE, backupStatusSchema, type ParsedBackupStatus } from '../backup/status.ts';
import { formatBytes } from '../lib/format.ts';
import { readJsonFile } from '../lib/json-store.ts';
import type { Clock } from '../lib/time.ts';

export const BACKUP_STALE_MS = 8 * 24 * 60 * 60 * 1000;

const MAX_ERROR_CHARS = 160;

const pad = (n: number) => String(n).padStart(2, '0');

/** "16.10 18:30" (server local time — the family's time); with the year when it is not this year. */
function formatWhen(iso: string, now: Date, forceYear = false): string {
  const d = new Date(iso);
  const year = forceYear || d.getFullYear() !== now.getFullYear() ? `.${d.getFullYear()}` : '';
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}${year} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type StatusTarget = NonNullable<ParsedBackupStatus['targets']>[number];

/** "основной диск — да, флешка «reserve» — нет" */
function summariseTargets(targets: readonly StatusTarget[]): string {
  return targets.map((target) => `${target.name} — ${target.ok ? 'да' : 'нет'}`).join(', ');
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Why each failed target failed, prefixed with its name unless the error already says it. */
function failureReasons(targets: readonly StatusTarget[]): string {
  return targets
    .filter((target) => !target.ok && target.error)
    .map((target) => {
      const error = (target.error ?? '').slice(0, MAX_ERROR_CHARS);
      const named = error.toLowerCase().includes(target.name.toLowerCase());
      const label = target.name.charAt(0).toUpperCase() + target.name.slice(1);
      return sentence(named ? error : `${label}: ${error}`);
    })
    .join(' ');
}

/**
 * Reads backup-status.json written by the backup job (server/src/cli/backup.ts).
 * Backup is never assumed: no file → not_configured. A run is ok only when every target is ok.
 */
async function readBackupBase(dataDir: string, clock: Clock): Promise<BackupInfo> {
  let data: unknown;
  try {
    data = await readJsonFile(path.join(dataDir, BACKUP_STATUS_FILE));
  } catch {
    return unreadable();
  }
  if (data === undefined) {
    return {
      state: 'not_configured',
      lastSuccessAt: null,
      restoreTested: false,
      message: 'Резервное копирование ещё не настроено',
    };
  }
  const parsed = backupStatusSchema.safeParse(data);
  if (!parsed.success) return unreadable();
  const status = parsed.data;
  const now = clock();
  const targets = status.targets ?? [];
  const lastSuccessAt = status.lastSuccessAt ?? null;
  const restoreTested = Boolean(status.restoreTestedAt);
  const restoreNote = restoreTested ? '' : ' Восстановление из копии ещё не проверялось.';
  // A failed optional mirror (the GitHub copy of the code) is a remark, never a failed backup.
  const failed = status.lastResult === 'failed' || targets.some((target) => !target.ok && !target.optional);

  if (failed) {
    const when = status.lastRunAt ? ` ${formatWhen(status.lastRunAt, now)}` : '';
    const head =
      targets.length > 0
        ? `Копирование${when}: ${summariseTargets(targets)}. ${failureReasons(targets)}`
        : `Последнее резервное копирование${when} завершилось ошибкой.`;
    const previous = lastSuccessAt
      ? ` Последняя полная копия: ${formatWhen(lastSuccessAt, now)}.`
      : ' Полных копий ещё не было.';
    return {
      state: 'failed',
      lastSuccessAt,
      restoreTested,
      message: `${head.trim()}${previous}${restoreNote}`,
    };
  }
  if (lastSuccessAt === null) {
    return {
      state: 'not_configured',
      lastSuccessAt: null,
      restoreTested,
      message: 'Резервное копирование ещё ни разу не завершилось успешно',
    };
  }
  if (now.getTime() - Date.parse(lastSuccessAt) > BACKUP_STALE_MS) {
    return {
      state: 'stale',
      lastSuccessAt,
      restoreTested,
      message: `Последняя успешная копия устарела: ${formatWhen(lastSuccessAt, now, true)}.${restoreNote}`,
    };
  }
  const summary =
    targets.length > 0
      ? `Последняя копия ${formatWhen(lastSuccessAt, now)}: ${summariseTargets(targets)}.`
      : `Последняя успешная копия: ${formatWhen(lastSuccessAt, now)}.`;
  const remarks =
    (status.warnings ?? []).length > 0
      ? ' Есть замечания — подробности в журнале резервного копирования.'
      : '';
  return {
    state: 'ok',
    lastSuccessAt,
    restoreTested,
    message: `${summary}${remarks}${restoreNote}`,
  };
}

/** Free room below which the status page warns: twice a copy, but never less than a gigabyte. */
export const MIN_HEADROOM_BYTES = 1024 ** 3;
/** An encrypted copy older than this is called out of date. */
export const OFFSITE_STALE_MS = 21 * 24 * 60 * 60 * 1000;

/** Disks that will soon be unable to take the next copy. Used by the status page and by the alerts. */
export function capacityWarnings(targets: readonly BackupTargetView[]): string[] {
  const warnings: string[] = [];
  for (const target of targets) {
    if (target.optional || target.freeBytes === null) continue;
    const need = Math.max(2 * (target.sizeBytes ?? 0), MIN_HEADROOM_BYTES);
    const tight = target.freeBytes < need;
    const low =
      target.totalBytes !== null && target.totalBytes > 0 && target.freeBytes / target.totalBytes < 0.1;
    if (tight || low) {
      warnings.push(
        `На «${target.name}» осталось ${formatBytes(target.freeBytes)}${target.sizeBytes === null ? '' : `, одна копия занимает ${formatBytes(target.sizeBytes)}`}: места хватит ненадолго. Подключите носитель побольше или уменьшите BACKUP_KEEP; пока места хватает, прежние копии не удаляются.`,
      );
    }
  }
  return warnings;
}

function offsiteView(status: ParsedBackupStatus, now: Date): NonNullable<BackupInfo['offsite']> {
  const offsite = status.offsite;
  if (!offsite?.configured) {
    return {
      state: 'not_configured',
      lastAt: null,
      tested: false,
      message: 'Зашифрованной копии вне дома нет: все копии лежат дома (диск и флешка), и не зашифрованы.',
    };
  }
  const lastAt = offsite.lastPackAt ?? null;
  const tested = Boolean(offsite.testedAt);
  if (offsite.error && /Ключ шифрования не найден/.test(offsite.error)) {
    return { state: 'no_key', lastAt, tested, message: offsite.error };
  }
  if (offsite.error && lastAt === null) {
    return {
      state: 'failed',
      lastAt,
      tested,
      message: `Зашифрованную копию сделать не удалось: ${offsite.error}`,
    };
  }
  if (lastAt === null) {
    return { state: 'failed', lastAt, tested, message: 'Зашифрованная копия ещё ни разу не была сделана.' };
  }
  const old = now.getTime() - Date.parse(lastAt) > OFFSITE_STALE_MS;
  const when = formatWhen(lastAt, now, true);
  if (offsite.error) {
    return {
      state: 'failed',
      lastAt,
      tested,
      message: `Последняя зашифрованная копия: ${when}; новую сделать не удалось: ${offsite.error}`,
    };
  }
  if (old) {
    return {
      state: 'stale',
      lastAt,
      tested,
      message: `Зашифрованная копия вне дома устарела: ${when}. Подключите носитель и запустите копирование.`,
    };
  }
  return {
    state: 'ok',
    lastAt,
    tested,
    message: `Последняя зашифрованная копия: ${when}, целостность проверена${tested ? ', пробное восстановление проходило' : ', пробное восстановление ещё не проходило'}. Носитель с ней должен храниться вне дома.`,
  };
}

/** Where copies are kept, room left, and the plain remarks; added on top of the basic state. */
async function readBackupExtras(
  dataDir: string,
  clock: Clock,
): Promise<Pick<BackupInfo, 'targets' | 'offsite' | 'notes'> | null> {
  let data: unknown;
  try {
    data = await readJsonFile(path.join(dataDir, BACKUP_STATUS_FILE));
  } catch {
    return null;
  }
  if (data === undefined) return null;
  const parsed = backupStatusSchema.safeParse(data);
  if (!parsed.success) return null;
  const status = parsed.data;
  const targets: BackupTargetView[] = (status.targets ?? []).map((target) => ({
    name: target.name,
    ok: target.ok,
    optional: target.optional === true,
    lastSnapshot: target.snapshot ?? null,
    sizeBytes: target.sizeBytes ?? null,
    freeBytes: target.freeBytes ?? null,
    totalBytes: target.totalBytes ?? null,
    snapshots: target.snapshots ?? null,
    error: target.error ?? null,
  }));
  const offsite = offsiteView(status, clock());
  const notes = [...capacityWarnings(targets)];
  if (offsite.state !== 'ok') notes.push(offsite.message);
  return { targets, offsite, notes };
}

/**
 * The backup state for the status page: the basic state (never assumed: no file means «not configured») plus
 * where the copies are, how much room is left and what the owner should do about the copy for outside the house.
 */
export async function readBackupStatus(dataDir: string, clock: Clock): Promise<BackupInfo> {
  const base = await readBackupBase(dataDir, clock);
  const extras = await readBackupExtras(dataDir, clock);
  return extras ? { ...base, ...extras } : base;
}

function unreadable(): BackupInfo {
  return {
    state: 'unknown',
    lastSuccessAt: null,
    restoreTested: false,
    message: 'Файл состояния резервного копирования повреждён или не читается',
  };
}
