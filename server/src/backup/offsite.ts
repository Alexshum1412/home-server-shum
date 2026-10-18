/**
 * The encrypted copy for outside the house: the newest verified snapshot is packed into one `.fsbk` file in
 * a folder the owner chooses (an external disk, a folder a trusted sync client watches, a relative's drive).
 * The portal never uploads anything itself and never holds the key anywhere but the key file. Restoring
 * always goes into a new empty folder and the result is checked against the snapshot's own manifest.
 */
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { errorCode } from '../lib/json-store.ts';
import type { Clock } from '../lib/time.ts';
import { packTree, unpackTree } from './archive.ts';
import { CryptError, decryptStream, encryptStream, parseRecoveryCode, readKeyFile } from './crypt.ts';
import { BackupError, describeError, isInsideOrSame, realpathOrSelf, removeTree } from './files.ts';
import { assertSafeTargetRoot } from './retention.ts';
import { readManifest, SNAPSHOT_PREFIX, verifySnapshot } from './snapshot.ts';
import { checkFreeSpace, type FreeSpaceProbe } from './targets.ts';

export const OFFSITE_PREFIX = 'family-offsite-';
export const OFFSITE_EXT = '.fsbk';
const OFFSITE_RE = /^family-offsite-(\d{8})-(\d{6})(-\d+)?\.fsbk$/;
const PARTIAL_RE = /^family-offsite-\d{8}-\d{6}(-\d+)?\.fsbk\.partial$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface OffsiteSettings {
  /** Where the encrypted files are written. */
  readonly dir: string;
  /** File with the key (outside Git, outside the data folder). */
  readonly keyFile: string;
  /** How many encrypted copies to keep. */
  readonly keep: number;
  /** A new one is made when the newest is older than this many days. */
  readonly everyDays: number;
}

export interface OffsiteDeps {
  readonly clock: Clock;
  readonly statfs: FreeSpaceProbe;
  readonly dataDir: string;
  readonly gitExe: string;
  readonly tempDir: string;
}

export interface OffsiteEntry {
  name: string;
  file: string;
  sizeBytes: number;
  /** From the name (UTC). */
  createdAt: Date;
}

export async function loadKey(
  settings: Pick<OffsiteSettings, 'keyFile'>,
  recoveryCode?: string,
): Promise<Buffer> {
  return recoveryCode ? parseRecoveryCode(recoveryCode) : readKeyFile(settings.keyFile);
}

function createdAtOf(name: string): Date | null {
  const match = OFFSITE_RE.exec(name);
  if (!match) return null;
  const [, day = '', time = ''] = match;
  const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Newest first. */
export async function listOffsite(dir: string): Promise<OffsiteEntry[]> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  const entries: OffsiteEntry[] = [];
  for (const name of names) {
    const createdAt = createdAtOf(name);
    if (!createdAt) continue;
    const file = path.join(dir, name);
    const stats = await fsp.lstat(file).catch(() => null);
    if (stats?.isFile()) entries.push({ name, file, sizeBytes: stats.size, createdAt });
  }
  return entries.sort((a, b) => (a.name < b.name ? 1 : -1));
}

export interface PackResult {
  file: string;
  name: string;
  snapshot: string;
  sizeBytes: number;
  files: number;
  /** True when this snapshot had already been packed and nothing was written. */
  existed: boolean;
}

/** Checks that an encrypted file is whole and authentic without writing anything: decrypts it end to end. */
export async function verifyOffsiteFile(
  file: string,
  key: Buffer,
): Promise<{ files: number; bytes: number }> {
  return unpackTree(decryptStream(key, createReadStream(file)), null);
}

/** Packs one verified snapshot into `settings.dir`; the file is written under a temporary name and verified first. */
export async function packOffsite(
  snapshotDir: string,
  settings: OffsiteSettings,
  key: Buffer,
  deps: OffsiteDeps,
): Promise<PackResult> {
  const snapshot = path.resolve(snapshotDir);
  const snapshotName = path.basename(snapshot);
  if (!snapshotName.startsWith(SNAPSHOT_PREFIX)) throw new BackupError(`Это не папка копии: ${snapshot}`);
  const dir = path.resolve(settings.dir);
  await assertSafeTargetRoot(dir, deps.dataDir);
  if (isInsideOrSame(dir, snapshot) || isInsideOrSame(snapshot, dir)) {
    throw new BackupError('Папка для копии вне дома не может лежать внутри копии или содержать её');
  }
  const { manifest, problem } = await readManifest(snapshot);
  if (!manifest) throw new BackupError(problem ?? 'Копия не читается');
  await fsp.mkdir(dir, { recursive: true });

  const name = `${OFFSITE_PREFIX}${snapshotName.slice(SNAPSHOT_PREFIX.length)}${OFFSITE_EXT}`;
  const final = path.join(dir, name);
  const existing = await fsp.lstat(final).catch(() => null);
  if (existing?.isFile()) {
    return {
      file: final,
      name,
      snapshot: snapshotName,
      sizeBytes: existing.size,
      files: manifest.files.length + 1,
      existed: true,
    };
  }
  const plainBytes = manifest.files.reduce((sum, file) => sum + file.size, 0);
  await checkFreeSpace(dir, plainBytes + Math.ceil(plainBytes / 1024) + 1024 * 1024, deps.statfs);

  const partial = `${final}.partial`;
  try {
    await pipeline(
      Readable.from(encryptStream(key, packTree(snapshot)), { objectMode: false }),
      createWriteStream(partial, { flags: 'wx' }),
    );
    const handle = await fsp.open(partial, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const check = await verifyOffsiteFile(partial, key);
    if (check.files !== manifest.files.length + 1) {
      throw new BackupError(
        `В зашифрованном файле ${check.files} файлов, а в копии ${manifest.files.length + 1}`,
      );
    }
    await fsp.rename(partial, final);
  } catch (error) {
    await fsp.rm(partial, { force: true }).catch(() => undefined);
    throw error;
  }
  const size = (await fsp.stat(final)).size;
  return {
    file: final,
    name,
    snapshot: snapshotName,
    sizeBytes: size,
    files: manifest.files.length + 1,
    existed: false,
  };
}

export interface RestoreOffsiteResult {
  dest: string;
  files: number;
  bytes: number;
}

async function assertEmptyDestination(
  dest: string,
  liveDataDir: string,
  sourceFile: string,
): Promise<boolean> {
  const real = await realpathOrSelf(dest);
  for (const live of [path.resolve(liveDataDir), await realpathOrSelf(liveDataDir)]) {
    if (isInsideOrSame(dest, live) || isInsideOrSame(real, live)) {
      throw new BackupError(
        `Нельзя восстанавливать в рабочую папку данных портала (${live}). Восстановите в новую пустую папку, затем при остановленном сервере замените данные вручную.`,
      );
    }
  }
  if (isInsideOrSame(sourceFile, dest))
    throw new BackupError('Папка для восстановления не может содержать сам зашифрованный файл');
  const stats = await fsp.lstat(dest).catch((error: unknown) => {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  });
  if (stats === null) return true;
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new BackupError(`${dest} уже существует и не является пустой папкой — выберите новую папку`);
  }
  if ((await fsp.readdir(dest)).length > 0)
    throw new BackupError(`Папка ${dest} не пуста — выберите пустую или новую папку`);
  return false;
}

/** Decrypts into a new empty folder and checks the result against the snapshot's manifest. */
export async function restoreOffsite(
  file: string,
  key: Buffer,
  destDir: string,
  deps: Pick<OffsiteDeps, 'gitExe' | 'tempDir' | 'dataDir'>,
): Promise<RestoreOffsiteResult> {
  const source = path.resolve(file);
  const dest = path.resolve(destDir);
  const created = await assertEmptyDestination(dest, deps.dataDir, source);
  try {
    const unpacked = await unpackTree(decryptStream(key, createReadStream(source)), dest);
    const check = await verifySnapshot(dest, { gitExe: deps.gitExe, tempDir: deps.tempDir });
    if (!check.ok)
      throw new BackupError(
        `Распакованная копия не прошла проверку: ${check.problems.slice(0, 5).join('; ')}`,
      );
    return { dest, files: unpacked.files, bytes: unpacked.bytes };
  } catch (error) {
    // A half-written restore is useless and may be mistaken for a good one.
    if (created) await removeTree(dest, path.dirname(dest)).catch(() => undefined);
    throw error;
  }
}

/** Restores the file into a temporary folder, checks it and removes the folder. Returns what was found. */
export async function testRestoreOffsite(
  file: string,
  key: Buffer,
  deps: Pick<OffsiteDeps, 'gitExe' | 'tempDir' | 'dataDir'>,
): Promise<RestoreOffsiteResult> {
  await fsp.mkdir(deps.tempDir, { recursive: true });
  const scratch = await fsp.mkdtemp(path.join(deps.tempDir, 'family-offsite-test-'));
  try {
    return await restoreOffsite(file, key, path.join(scratch, 'restore'), deps);
  } finally {
    await removeTree(scratch, deps.tempDir).catch(() => undefined);
  }
}

/** Keeps the newest `keep` encrypted files; abandoned `.partial` files older than a day go too. */
export async function pruneOffsite(
  dir: string,
  keep: number,
  clock: Clock,
  protect: readonly string[] = [],
): Promise<{ kept: string[]; removed: string[] }> {
  const result = { kept: [] as string[], removed: [] as string[] };
  const entries = await listOffsite(dir);
  for (const [index, entry] of entries.entries()) {
    if (index < keep || protect.includes(entry.name)) {
      result.kept.push(entry.name);
      continue;
    }
    await fsp.unlink(entry.file);
    result.removed.push(entry.name);
  }
  for (const name of await fsp.readdir(dir).catch(() => [] as string[])) {
    if (!PARTIAL_RE.test(name)) continue;
    const file = path.join(dir, name);
    const stats = await fsp.lstat(file).catch(() => null);
    if (stats?.isFile() && clock().getTime() - stats.mtimeMs > DAY_MS)
      await fsp.unlink(file).catch(() => undefined);
  }
  return result;
}

export interface OffsiteRunOutcome {
  /** false = nothing was due. */
  ran: boolean;
  ok: boolean;
  message: string;
  pack?: PackResult;
  /** Entries kept after pruning. */
  keptCount?: number;
}

/**
 * Makes an encrypted copy when the newest is older than `everyDays` (or there is none). Never throws: the
 * outcome is a message for the status page, because the local copies are the ones that must not be blocked.
 */
export async function runOffsiteIfDue(
  snapshotDir: string,
  settings: OffsiteSettings,
  deps: OffsiteDeps,
  options: { force?: boolean } = {},
): Promise<OffsiteRunOutcome> {
  try {
    const [newest] = await listOffsite(settings.dir);
    const due =
      options.force === true ||
      !newest ||
      deps.clock().getTime() - newest.createdAt.getTime() >= settings.everyDays * DAY_MS;
    if (!due)
      return { ran: false, ok: true, message: `Свежая зашифрованная копия уже есть (${newest?.name ?? ''})` };
    let key: Buffer;
    try {
      key = await loadKey(settings);
    } catch (error) {
      return {
        ran: true,
        ok: false,
        message: error instanceof CryptError ? error.message : describeError(error),
      };
    }
    const pack = await packOffsite(snapshotDir, settings, key, deps);
    const pruned = await pruneOffsite(settings.dir, settings.keep, deps.clock, [pack.name]);
    return {
      ran: true,
      ok: true,
      message: `Зашифрованная копия ${pack.name} записана и проверена`,
      pack,
      keptCount: pruned.kept.length,
    };
  } catch (error) {
    return { ran: true, ok: false, message: describeError(error) };
  }
}
