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
  /** A mirror (the GitHub copy of the code): its failure is a remark, not a failed backup. */
  optional?: boolean;
  /** Room left on the disk after this run, and how many complete copies it holds. */
  freeBytes?: number | null;
  totalBytes?: number | null;
  snapshots?: number | null;
}

/** The encrypted copy for outside the house. */
export interface OffsiteStatus {
  configured: boolean;
  lastPackAt: string | null;
  lastFile: string | null;
  sizeBytes: number | null;
  /** The file was decrypted end to end and its authentication passed. */
  verifiedAt: string | null;
  /** A full test restore into a temporary folder passed. */
  testedAt: string | null;
  /** Why the last attempt failed (Russian, no secrets). */
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
  offsite: OffsiteStatus | null;
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
  optional: z.boolean().optional(),
  freeBytes: z.number().nullable().optional(),
  totalBytes: z.number().nullable().optional(),
  snapshots: z.number().nullable().optional(),
});

const offsiteSchema = z.object({
  configured: z.boolean(),
  lastPackAt: isoDate,
  lastFile: z.string().nullable().optional(),
  sizeBytes: z.number().nullable().optional(),
  verifiedAt: isoDate,
  testedAt: isoDate,
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
  offsite: offsiteSchema.nullable().optional().catch(undefined),
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
    ...(target.optional ? { optional: true } : {}),
    ...(target.freeBytes !== undefined ? { freeBytes: target.freeBytes } : {}),
    ...(target.totalBytes !== undefined ? { totalBytes: target.totalBytes } : {}),
    ...(target.snapshots !== undefined ? { snapshots: target.snapshots } : {}),
  }));
}

function normaliseOffsite(offsite: ParsedBackupStatus['offsite']): OffsiteStatus | null {
  if (!offsite) return null;
  return {
    configured: offsite.configured,
    lastPackAt: offsite.lastPackAt ?? null,
    lastFile: offsite.lastFile ?? null,
    sizeBytes: offsite.sizeBytes ?? null,
    verifiedAt: offsite.verifiedAt ?? null,
    testedAt: offsite.testedAt ?? null,
    error: offsite.error ?? null,
  };
}

export interface BackupRunRecord {
  at: string;
  ok: boolean;
  targets: BackupTargetStatus[];
  warnings: readonly string[];
  /** Changes to the encrypted-copy status (merged into what was recorded before); null — not set up. */
  offsite?: Partial<OffsiteStatus> | null;
}

function mergeOffsite(
  previous: OffsiteStatus | null,
  patch: Partial<OffsiteStatus> | null | undefined,
): OffsiteStatus | null {
  if (patch === null) return null;
  if (patch === undefined) return previous;
  return {
    configured: true,
    lastPackAt: null,
    lastFile: null,
    sizeBytes: null,
    verifiedAt: null,
    testedAt: null,
    error: null,
    ...previous,
    ...patch,
  };
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
    offsite: mergeOffsite(normaliseOffsite(previous.offsite), run.offsite),
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
    offsite: normaliseOffsite(previous.offsite),
  };
  await writeJsonAtomic(path.join(dataDir, BACKUP_STATUS_FILE), status);
  return status;
}

/** Records an offsite step (a pack, a check, a test restore); everything else stays as it was. */
export async function recordOffsite(
  dataDir: string,
  patch: Partial<OffsiteStatus>,
): Promise<BackupStatusFile> {
  const previous = await readPrevious(dataDir);
  const status: BackupStatusFile = {
    lastRunAt: previous.lastRunAt ?? null,
    lastResult: previous.lastResult ?? null,
    lastSuccessAt: previous.lastSuccessAt ?? null,
    restoreTestedAt: previous.restoreTestedAt ?? null,
    targets: normaliseTargets(previous.targets),
    warnings: previous.warnings ?? [],
    offsite: mergeOffsite(normaliseOffsite(previous.offsite), patch),
  };
  await writeJsonAtomic(path.join(dataDir, BACKUP_STATUS_FILE), status);
  return status;
}
