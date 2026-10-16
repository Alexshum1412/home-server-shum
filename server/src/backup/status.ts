import path from 'node:path';
import { z } from 'zod';
import { readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';

/** Written into the data folder by the backup job; read by the dashboard (system/backup.ts). */
export const BACKUP_STATUS_FILE = 'backup-status.json';

export interface BackupTargetStatus {
  /** «основной диск», «флешка «reserve»» … */
  name: string;
  root: string | null;
  ok: boolean;
  snapshot: string | null;
  sizeBytes: number | null;
  /** Russian, without file contents or secrets. */
  error: string | null;
}

export interface BackupStatusFile {
  lastRunAt: string | null;
  lastResult: 'ok' | 'failed' | null;
  /** Only moves forward when every target succeeded. */
  lastSuccessAt: string | null;
  /** Only set by a restore test that fully passed. */
  restoreTestedAt: string | null;
  targets: BackupTargetStatus[];
  warnings: string[];
}

const isoDate = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'ожидается дата ISO 8601')
  .nullable()
  .optional();

const targetStatusSchema = z.object({
  name: z.string(),
  root: z.string().nullable().optional(),
  ok: z.boolean(),
  snapshot: z.string().nullable().optional(),
  sizeBytes: z.number().nullable().optional(),
  error: z.string().nullable().optional(),
});

/**
 * Shape of backup-status.json. The dates and the result are required to be valid; the per-target
 * details are informational, so a malformed `targets` or `warnings` is ignored instead of making
 * the whole status unreadable.
 */
export const backupStatusSchema = z.object({
  lastRunAt: isoDate,
  lastResult: z.enum(['ok', 'failed']).nullable().optional(),
  lastSuccessAt: isoDate,
  restoreTestedAt: isoDate,
  targets: z.array(targetStatusSchema).optional().catch(undefined),
  warnings: z.array(z.string()).optional().catch(undefined),
});

export type ParsedBackupStatus = z.infer<typeof backupStatusSchema>;

/** The previous status, or an empty one when missing or unreadable (it is about to be replaced). */
async function readPrevious(dataDir: string): Promise<ParsedBackupStatus> {
  try {
    const parsed = backupStatusSchema.safeParse(await readJsonFile(path.join(dataDir, BACKUP_STATUS_FILE)));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function normaliseTargets(targets: ParsedBackupStatus['targets']): BackupTargetStatus[] {
  return (targets ?? []).map((target) => ({
    name: target.name,
    root: target.root ?? null,
    ok: target.ok,
    snapshot: target.snapshot ?? null,
    sizeBytes: target.sizeBytes ?? null,
    error: target.error ?? null,
  }));
}

export interface BackupRunRecord {
  at: string;
  ok: boolean;
  targets: BackupTargetStatus[];
  warnings: readonly string[];
}

/** Records a backup run (atomic write); lastSuccessAt and restoreTestedAt are carried over. */
export async function recordBackupRun(dataDir: string, run: BackupRunRecord): Promise<BackupStatusFile> {
  const previous = await readPrevious(dataDir);
  const status: BackupStatusFile = {
    lastRunAt: run.at,
    lastResult: run.ok ? 'ok' : 'failed',
    lastSuccessAt: run.ok ? run.at : (previous.lastSuccessAt ?? null),
    restoreTestedAt: previous.restoreTestedAt ?? null,
    targets: run.targets.map((target) => ({ ...target })),
    warnings: [...run.warnings],
  };
  await writeJsonAtomic(path.join(dataDir, BACKUP_STATUS_FILE), status);
  return status;
}

/** Records a fully passed restore test; everything else is kept as it was. */
export async function recordRestoreTest(dataDir: string, at: string): Promise<BackupStatusFile> {
  const previous = await readPrevious(dataDir);
  const status: BackupStatusFile = {
    lastRunAt: previous.lastRunAt ?? null,
    lastResult: previous.lastResult ?? null,
    lastSuccessAt: previous.lastSuccessAt ?? null,
    restoreTestedAt: at,
    targets: normaliseTargets(previous.targets),
    warnings: previous.warnings ?? [],
  };
  await writeJsonAtomic(path.join(dataDir, BACKUP_STATUS_FILE), status);
  return status;
}
