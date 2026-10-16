import path from 'node:path';
import type { BackupInfo } from '../../../shared/api.ts';
import { BACKUP_STATUS_FILE, backupStatusSchema, type ParsedBackupStatus } from '../backup/status.ts';
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
export async function readBackupStatus(dataDir: string, clock: Clock): Promise<BackupInfo> {
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

function unreadable(): BackupInfo {
  return {
    state: 'unknown',
    lastSuccessAt: null,
    restoreTested: false,
    message: 'Файл состояния резервного копирования повреждён или не читается',
  };
}
