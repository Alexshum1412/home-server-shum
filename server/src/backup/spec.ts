import path from 'node:path';

/**
 * Backup target specification (BACKUP_TARGETS item):
 *   - an absolute folder path, e.g. `C:\FamilyServer\backups`;
 *   - `label:<VolumeLabel>\<subdir>` — a folder on the volume with that label, wherever Windows mounted it
 *     (a flash drive may get a different letter after reconnecting). The sub-folder is mandatory:
 *     backups never go to a drive root.
 */
export type TargetSpec =
  | { readonly kind: 'path'; readonly spec: string; readonly path: string }
  | { readonly kind: 'label'; readonly spec: string; readonly label: string; readonly subdir: string };

const LABEL_PREFIX = /^label:/i;
/** NTFS allows up to 32 characters in a volume label. */
const LABEL_RE = /^[^\\/:*?"<>|]{1,32}$/;
const SEGMENT_RE = /^[^\\/:*?"<>|]+$/;

/** Absolute path with a drive letter or a UNC share (not "\folder", which depends on the current drive). */
export function isAbsoluteTargetPath(value: string): boolean {
  if (process.platform === 'win32') {
    return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
  }
  return path.isAbsolute(value);
}

/** Relative sub-folder: no empty, "." or ".." segments, no characters Windows forbids. */
function parseSubdir(value: string): string | null {
  const segments = value.split(/[\\/]+/).filter((segment) => segment !== '');
  if (segments.length === 0) return null;
  const valid = segments.every(
    (segment) =>
      segment !== '.' && segment !== '..' && SEGMENT_RE.test(segment) && segment.trim() === segment,
  );
  return valid ? segments.join('\\') : null;
}

/** Parses one spec; returns a Russian problem description instead of throwing. */
export function parseTargetSpec(raw: string): TargetSpec | { error: string } {
  const spec = raw.trim();
  if (LABEL_PREFIX.test(spec)) {
    const rest = spec.replace(LABEL_PREFIX, '');
    const sep = rest.search(/[\\/]/);
    const label = (sep === -1 ? rest : rest.slice(0, sep)).trim();
    if (!LABEL_RE.test(label)) {
      return { error: `«${spec}»: после label: укажите метку диска (до 32 символов)` };
    }
    const subdir = sep === -1 ? null : parseSubdir(rest.slice(sep + 1));
    if (subdir === null) {
      return {
        error: `«${spec}»: укажите папку на диске, например label:${label}\\FamilyServerBackups (в корень диска копии не пишутся)`,
      };
    }
    return { kind: 'label', spec, label, subdir };
  }
  if (!isAbsoluteTargetPath(spec)) {
    return {
      error: `«${spec}»: нужен полный путь к папке (например C:\\FamilyServer\\backups) или label:<метка>\\<папка>`,
    };
  }
  return { kind: 'path', spec, path: path.resolve(spec) };
}

/** Splits a ';'-separated list, dropping blanks. */
export function splitList(value: string): string[] {
  return value
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}
