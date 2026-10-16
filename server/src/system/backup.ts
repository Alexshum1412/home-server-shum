import path from 'node:path';
import { z } from 'zod';
import type { BackupInfo } from '../../../shared/api.ts';
import { readJsonFile } from '../lib/json-store.ts';
import type { Clock } from '../lib/time.ts';

export const BACKUP_STALE_MS = 8 * 24 * 60 * 60 * 1000;

const isoDate = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'ожидается дата ISO 8601')
  .nullable()
  .optional();

const statusSchema = z.object({
  lastRunAt: isoDate,
  lastResult: z.enum(['ok', 'failed']).nullable().optional(),
  lastSuccessAt: isoDate,
  restoreTestedAt: isoDate,
});

const formatDate = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' });

/**
 * Reads the optional backup-status.json written by a future backup job.
 * Backup is never assumed: no file → not_configured.
 */
export async function readBackupStatus(dataDir: string, clock: Clock): Promise<BackupInfo> {
  let data: unknown;
  try {
    data = await readJsonFile(path.join(dataDir, 'backup-status.json'));
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
  const parsed = statusSchema.safeParse(data);
  if (!parsed.success) return unreadable();
  const status = parsed.data;
  const lastSuccessAt = status.lastSuccessAt ?? null;
  const restoreTested = Boolean(status.restoreTestedAt);
  const restoreNote = restoreTested ? '' : ' Восстановление из копии ещё не проверялось.';

  if (status.lastResult === 'failed') {
    return {
      state: 'failed',
      lastSuccessAt,
      restoreTested,
      message: `Последнее резервное копирование завершилось ошибкой.${restoreNote}`,
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
  if (clock().getTime() - Date.parse(lastSuccessAt) > BACKUP_STALE_MS) {
    return {
      state: 'stale',
      lastSuccessAt,
      restoreTested,
      message: `Последняя успешная копия устарела: ${formatDate(lastSuccessAt)} (UTC).${restoreNote}`,
    };
  }
  return {
    state: 'ok',
    lastSuccessAt,
    restoreTested,
    message: `Последняя успешная копия: ${formatDate(lastSuccessAt)} (UTC).${restoreNote}`,
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
