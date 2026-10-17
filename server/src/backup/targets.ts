import path from 'node:path';
import { z } from 'zod';
import { formatBytes } from '../lib/format.ts';
import { runPowerShellScript } from '../system/powershell.ts';
import { BackupError } from './files.ts';
import { parseTargetSpec } from './spec.ts';

export interface VolumeEntry {
  driveLetter: string;
  label: string;
  driveType: string;
  fileSystem: string;
  sizeBytes: number;
  freeBytes: number;
}

export type VolumeLister = () => Promise<VolumeEntry[]>;

const volumeSchema = z.object({
  driveLetter: z.string().regex(/^[A-Za-z]$/),
  label: z.string(),
  driveType: z.string(),
  fileSystem: z.string(),
  sizeBytes: z.number(),
  freeBytes: z.number(),
});

/** Normalises the output of the allowlisted `volumes` PowerShell script; bad items are dropped. */
export function parseVolumes(raw: unknown): VolumeEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const parsed = volumeSchema.safeParse(item);
    return parsed.success ? [{ ...parsed.data, driveLetter: parsed.data.driveLetter.toUpperCase() }] : [];
  });
}

/** Windows: Get-Volume through the fixed read-only script; elsewhere there are no labels to resolve. */
export const defaultVolumeLister: VolumeLister = async () => {
  const raw = await runPowerShellScript('volumes');
  return raw === 'unsupported' ? [] : parseVolumes(raw);
};

export interface ResolvedTarget {
  name: string;
  spec: string;
  root: string;
}

export interface UnresolvedTarget {
  name: string;
  spec: string;
  root: null;
  error: string;
}

export type TargetResolution = ResolvedTarget | UnresolvedTarget;

export interface ResolveDeps {
  listVolumes: VolumeLister;
  /** "C:" — targets there are called «основной диск». */
  systemDrive: string;
}

function pathTargetName(target: string, systemDrive: string): string {
  const drive = /^([a-zA-Z]):/.exec(target)?.[1]?.toUpperCase();
  if (!drive) return `папка ${target}`;
  return `${drive}:` === systemDrive.toUpperCase() ? 'основной диск' : `диск ${drive}:`;
}

export function labelTargetName(label: string): string {
  return `флешка «${label}»`;
}

/**
 * Turns BACKUP_TARGETS specs into folders. Each target resolves (or fails) on its own: a flash drive
 * that is not plugged in fails only its own target. Volumes are listed at most once, and only when
 * a label target is present.
 */
export async function resolveTargets(
  specs: readonly string[],
  deps: ResolveDeps,
): Promise<TargetResolution[]> {
  let volumes: Promise<VolumeEntry[]> | null = null;
  const results: TargetResolution[] = [];
  for (const raw of specs) {
    const spec = parseTargetSpec(raw);
    if ('error' in spec) {
      results.push({ name: raw.trim(), spec: raw.trim(), root: null, error: spec.error });
      continue;
    }
    if (spec.kind === 'path') {
      results.push({ name: pathTargetName(spec.path, deps.systemDrive), spec: spec.spec, root: spec.path });
      continue;
    }
    const name = labelTargetName(spec.label);
    volumes ??= deps.listVolumes();
    let list: VolumeEntry[];
    try {
      list = await volumes;
    } catch {
      results.push({
        name,
        spec: spec.spec,
        root: null,
        error: 'Не удалось получить список дисков от Windows',
      });
      continue;
    }
    const matches = list.filter((volume) => volume.label.toLowerCase() === spec.label.toLowerCase());
    const [match] = matches;
    if (!match) {
      results.push({ name, spec: spec.spec, root: null, error: `Флешка «${spec.label}» не подключена` });
    } else if (matches.length > 1) {
      const letters = matches.map((volume) => `${volume.driveLetter}:`).join(', ');
      results.push({
        name,
        spec: spec.spec,
        root: null,
        error: `Найдено несколько дисков с меткой «${spec.label}» (${letters}) — оставьте эту метку только у одного`,
      });
    } else {
      results.push({ name, spec: spec.spec, root: path.win32.join(`${match.driveLetter}:\\`, spec.subdir) });
    }
  }
  // Two targets on the same disk would get the same name.
  const seen = new Map<string, number>();
  for (const result of results) {
    const count = (seen.get(result.name) ?? 0) + 1;
    seen.set(result.name, count);
    if (count > 1) result.name = `${result.name} (${count})`;
  }
  return results;
}

/** Headroom on top of the snapshot size, so a backup never fills a disk to the last byte. */
export const FREE_SPACE_MARGIN_BYTES = 50 * 1024 * 1024;

export type FreeSpaceProbe = (folder: string) => Promise<{ freeBytes: number }>;

export async function checkFreeSpace(
  root: string,
  neededBytes: number,
  statfs: FreeSpaceProbe,
): Promise<void> {
  const { freeBytes } = await statfs(root);
  const required = neededBytes + FREE_SPACE_MARGIN_BYTES;
  if (freeBytes < required) {
    throw new BackupError(
      `Недостаточно места: свободно ${formatBytes(freeBytes)}, нужно не меньше ${formatBytes(required)}. ` +
        'Удалите старые копии (backup.cmd prune) или подключите носитель большего объёма.',
    );
  }
}
