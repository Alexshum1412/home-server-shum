/**
 * Torrents in the family queue.
 *
 * The torrent client (aria2) does the downloading; the portal decides everything around it:
 * who may add, what is accepted (checked and rewritten file, safe trackers, no programs), where the
 * result goes (a fixed list of folders), who sees which task, and what the person is told.
 *
 * - A person first «checks» a link, a magnet or a file and sees what is inside; only then it starts.
 * - Programs and scripts inside a torrent are never downloaded (their files are left out).
 * - Trackers on the home network or the PC itself, and web seeds, never reach the client.
 * - Finished files get the «from the internet» mark; media folders are announced to Jellyfin.
 */
import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type {
  DownloadCheckResponse,
  DownloadDestination,
  DownloadState,
  DownloadTaskView,
  TorrentEngineView,
} from '../../../shared/api.ts';
import { isBlockedName } from '../files/names.ts';
import { createSerialQueue, readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import { type Clock, isoNow } from '../lib/time.ts';
import { type Aria2, Aria2Down, Aria2Error, type Aria2Status } from './aria2.ts';
import { parseTorrent, rebuildTorrent, TorrentError, type TorrentMeta } from './bencode.ts';
import { buildMagnet, type Magnet, parseMagnet } from './magnet.ts';
import { DOWNLOADS_FOLDER, DownloadError } from './manager.ts';
import { isPublicAddress } from './net-guard.ts';

export const TORRENT_ID_PREFIX = 't-';
export const MAX_TORRENTS_PER_USER = 20;
const CHECK_TTL_MS = 15 * 60_000;
const METADATA_TIMEOUT_MS = 60_000;
const POLL_MS = 5000;
const MAX_TRACKERS = 30;

const DESTINATIONS: Record<DownloadDestination, { label: string; folder: string | null }> = {
  personal: { label: 'Файлы → Личное → Загрузки', folder: null },
  movies: { label: 'Общая медиатека → Фильмы', folder: 'Фильмы' },
  series: { label: 'Общая медиатека → Сериалы', folder: 'Сериалы' },
  cartoons: { label: 'Общая медиатека → Мультфильмы', folder: 'Мультфильмы' },
  music: { label: 'Общая медиатека → Музыка', folder: 'Музыка' },
};

export const destinationOptions = (): DownloadCheckResponse['destinations'] =>
  (Object.keys(DESTINATIONS) as DownloadDestination[]).map((id) => ({ id, label: DESTINATIONS[id].label }));

const recordSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{40}$/),
  owner: z.string(),
  name: z.string(),
  destination: z.enum(['personal', 'movies', 'series', 'cartoons', 'music']),
  dir: z.string(),
  addedAt: z.string(),
  totalBytes: z.number(),
  selected: z.array(z.number().int()),
  fileCount: z.number().int(),
  skipped: z.number().int(),
  paths: z.array(z.string()),
  /** One file saved as <dir>\<name>; otherwise the files are inside the folder <dir>\<name>. */
  single: z.boolean().default(false),
  state: z.enum(['active', 'completed', 'failed']),
  completedAt: z.string().nullable(),
  error: z.string().nullable(),
  uploadedBytes: z.number(),
  notified: z.enum(['done', 'fail']).nullable(),
});
type Record_ = z.infer<typeof recordSchema>;
const fileSchema = z.object({ version: z.literal(1), items: z.array(recordSchema) });

interface PendingCheck {
  id: string;
  owner: string;
  expiresAt: number;
  status: 'ready' | 'pending' | 'failed';
  error: string | null;
  magnet: Magnet | null;
  meta: TorrentMeta | null;
  trackers: string[];
  aborted: boolean;
}

export interface TorrentEvents {
  action: 'download.add' | 'download.done' | 'download.fail' | 'download.cancel';
  actor: string;
  detail: string;
}

export interface TorrentManagerOptions {
  dataDir: string;
  filesRoot: string;
  mediaRoot: string;
  aria2: Aria2;
  /** Where the client keeps magnet metadata while the person looks at it (inside the data folder). */
  metadataDir: string;
  maxBytes: number;
  minFreeBytes: number;
  seedRatio: number;
  uploadLimitKb: number;
  /** The client program exists on this PC (to tell «not installed» from «not running»). */
  clientInstalled: () => boolean;
  freeBytes: (dir: string) => Promise<number | null>;
  clock: Clock;
  onEvent?: (event: TorrentEvents) => void;
  /** A download into the shared media library finished: tell Jellyfin to look for it. */
  onLibraryChanged?: () => Promise<void>;
  /** Resolves tracker names; tests replace it. */
  resolveHost?: (host: string) => Promise<string[]>;
  log?: (message: string) => void;
}

const ERROR_TEXT: Record<number, string> = {
  2: 'Время ожидания вышло: раздающие не отвечают.',
  3: 'Раздача не найдена.',
  5: 'Скорость скачивания слишком низкая.',
  6: 'Сетевая ошибка.',
  9: 'Не хватило места на диске сервера.',
  13: 'Файл с таким именем уже есть на диске.',
  15: 'Не удалось открыть файл на диске.',
  16: 'Не удалось создать файл на диске.',
  17: 'Ошибка записи на диск.',
  18: 'Не удалось создать папку.',
  19: 'Не удалось найти адрес раздающего (DNS).',
  21: 'Файл .torrent не читается клиентом.',
  22: 'Магнитная ссылка не читается клиентом.',
};

function describeError(code: string | undefined, message: string | undefined): string {
  const known = code ? ERROR_TEXT[Number(code)] : undefined;
  return known ?? `Ошибка торрент-клиента${message ? `: ${message.slice(0, 120)}` : ''}.`;
}

const num = (value: string | undefined): number => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

function problemOfTrackerHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.lan') ||
    host.endsWith('.internal') ||
    host.endsWith('.home') ||
    host.endsWith('.ts.net') ||
    !host.includes('.') // a bare name resolves only inside a home network
  );
}

export interface TorrentManager {
  engine(): Promise<TorrentEngineView>;
  start(): void;
  stop(): void;
  load(): Promise<void>;
  checkMagnet(owner: string, text: string): Promise<DownloadCheckResponse>;
  checkFile(owner: string, bytes: Buffer, fileName: string): Promise<DownloadCheckResponse>;
  getCheck(owner: string, checkId: string): DownloadCheckResponse | null;
  isTorrentCheck(checkId: string): boolean;
  add(owner: string, checkId: string, destination: DownloadDestination): Promise<DownloadTaskView>;
  list(owner: string | null): Promise<DownloadTaskView[]>;
  owns(id: string): boolean;
  act(
    id: string,
    action: 'pause' | 'resume' | 'cancel' | 'remove' | 'retry',
    actor: { username: string; isAdmin: boolean },
  ): Promise<DownloadTaskView | null>;
  /** One pass of the watcher (also called by a timer): finished and failed tasks. */
  poll(): Promise<void>;
}

export function createTorrentManager(options: TorrentManagerOptions): TorrentManager {
  const { aria2, clock } = options;
  const file = path.join(options.dataDir, 'torrents.json');
  const copies = path.join(options.dataDir, 'torrents');
  const queue = createSerialQueue();
  const records = new Map<string, Record_>();
  const checks = new Map<string, PendingCheck>();
  let timer: NodeJS.Timeout | null = null;
  let polling = false;
  const log = options.log ?? (() => undefined);
  const resolveHost =
    options.resolveHost ??
    (async (host: string) => (await dns.lookup(host, { all: true })).map((entry) => entry.address));
  const now = () => clock().getTime();

  const save = () =>
    queue
      .run(() => writeJsonAtomic(file, { version: 1, items: [...records.values()] }))
      .catch((error: unknown) => log(`Не удалось сохранить список торрентов: ${(error as Error).message}`));

  // --- the client ---------------------------------------------------------------------------

  async function engine(): Promise<TorrentEngineView> {
    try {
      await aria2.version();
      return { state: 'ok', message: 'Торрент-клиент работает.', hint: null };
    } catch (error) {
      if (error instanceof Aria2Error) {
        // It answers, but does not accept the portal's key (the settings file and the key file differ).
        return {
          state: 'down',
          message: 'Торрент-клиент не принимает ключ портала.',
          hint: 'Администратору: перезапустите программы командой scripts\\service.cmd restart aria2 — клиент перечитает ключ.',
        };
      }
      if (!(error instanceof Aria2Down)) throw error;
      if (!options.clientInstalled()) {
        return {
          state: 'not_installed',
          message: 'Торрент-клиент не установлен на домашнем компьютере.',
          hint: 'Администратору: выполните scripts\\torrent-setup.cmd (он скачает официальный aria2 и проверит его) — подробности в docs/runbooks/torrents.md. Обычные загрузки по ссылке работают и без него.',
        };
      }
      return {
        state: 'down',
        message: 'Торрент-клиент установлен, но не отвечает.',
        hint: 'Подождите минуту: его запускает и перезапускает супервизор. Если не помогло — администратору: scripts\\service.cmd restart aria2.',
      };
    }
  }

  async function requireEngine(): Promise<void> {
    const state = await engine();
    if (state.state !== 'ok')
      throw new DownloadError(503, 'torrent_unavailable', `${state.message} ${state.hint ?? ''}`.trim());
  }

  // --- trackers ------------------------------------------------------------------------------

  async function safeTrackers(urls: readonly string[]): Promise<string[]> {
    const accepted: string[] = [];
    const seen = new Set<string>();
    await Promise.all(
      urls.slice(0, 60).map(async (raw) => {
        let url: URL;
        try {
          url = new URL(raw);
        } catch {
          return;
        }
        if (!['http:', 'https:', 'udp:'].includes(url.protocol) || url.username || url.password) return;
        if (problemOfTrackerHost(url.hostname)) return;
        const host = url.hostname.replace(/^\[|\]$/g, '');
        let addresses: string[];
        try {
          addresses = /^[\d.]+$|:/.test(host)
            ? [host]
            : await Promise.race([
                resolveHost(host),
                new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
              ]);
        } catch {
          return;
        }
        if (addresses.length === 0 || !addresses.every((address) => isPublicAddress(address))) return;
        const key = url.href;
        if (seen.has(key)) return;
        seen.add(key);
        accepted.push(raw);
      }),
    );
    // Keep the order of the file (the first tracker is the main one).
    return urls.filter((raw) => accepted.includes(raw)).slice(0, MAX_TRACKERS);
  }

  // --- checking ------------------------------------------------------------------------------

  function dropExpiredChecks(): void {
    for (const [id, check] of checks) {
      if (check.expiresAt < now()) {
        check.aborted = true;
        checks.delete(id);
      }
    }
  }

  function viewOfCheck(check: PendingCheck): DownloadCheckResponse {
    const meta = check.meta;
    const files = meta
      ? meta.files.map((entry) => ({
          path: entry.path.join('/'),
          sizeBytes: entry.length,
          skipped: isBlockedName(entry.path[entry.path.length - 1] ?? ''),
        }))
      : [];
    const wanted = files.filter((entry) => !entry.skipped);
    return {
      checkId: check.id,
      kind: 'torrent',
      status: check.status,
      error: check.error,
      url: check.magnet ? `magnet:?xt=urn:btih:${check.magnet.infoHash}` : '',
      host: 'торрент',
      fileName: meta?.name ?? check.magnet?.name ?? 'Раздача',
      sizeBytes: meta ? meta.totalBytes : null,
      contentType: null,
      resumable: true,
      files: files.slice(0, 300),
      willDownload: meta
        ? { files: wanted.length, sizeBytes: wanted.reduce((sum, entry) => sum + entry.sizeBytes, 0) }
        : null,
      destinations: destinationOptions(),
    };
  }

  function newCheck(owner: string): PendingCheck {
    dropExpiredChecks();
    const check: PendingCheck = {
      id: randomUUID(),
      owner,
      expiresAt: now() + CHECK_TTL_MS,
      status: 'pending',
      error: null,
      magnet: null,
      meta: null,
      trackers: [],
      aborted: false,
    };
    checks.set(check.id, check);
    return check;
  }

  function refuseDuplicate(owner: string, infoHash: string): void {
    const existing = records.get(infoHash);
    if (existing && existing.state === 'active') {
      throw new DownloadError(409, 'duplicate', 'Эта раздача уже скачивается или стоит в очереди.');
    }
    const mine = [...records.values()].filter((r) => r.owner === owner && r.state === 'active').length;
    if (mine >= MAX_TORRENTS_PER_USER) {
      throw new DownloadError(
        429,
        'too_many_tasks',
        `Не больше ${MAX_TORRENTS_PER_USER} торрентов в очереди одновременно.`,
      );
    }
  }

  async function finishCheck(
    check: PendingCheck,
    meta: TorrentMeta,
    announced: readonly string[],
  ): Promise<void> {
    if (meta.v2Only) {
      check.status = 'failed';
      check.error =
        'Это торрент нового формата (v2), его этот клиент не скачает. Найдите версию раздачи с обычным (v1 или гибридным) файлом.';
      return;
    }
    check.meta = meta;
    check.trackers = await safeTrackers([...meta.trackers, ...announced]);
    const wanted = meta.files.filter((entry) => !isBlockedName(entry.path[entry.path.length - 1] ?? ''));
    if (wanted.length === 0) {
      check.status = 'failed';
      check.error = 'В этой раздаче только программы и скрипты (.exe, .bat и подобные): они не скачиваются.';
      return;
    }
    check.status = 'ready';
  }

  async function fetchMetadata(check: PendingCheck, magnet: Magnet): Promise<void> {
    await fsp.mkdir(options.metadataDir, { recursive: true });
    const trackers = await safeTrackers(magnet.trackers);
    check.trackers = trackers;
    let gid: string | null = null;
    const fail = (message: string) => {
      check.status = 'failed';
      check.error = message;
    };
    try {
      gid = await aria2.addUri([buildMagnet(magnet, trackers)], {
        dir: options.metadataDir,
        'bt-metadata-only': 'true',
        'bt-save-metadata': 'true',
        'follow-torrent': 'false',
        'bt-stop-timeout': '60',
      });
      const deadline = now() + METADATA_TIMEOUT_MS;
      for (;;) {
        if (check.aborted) return;
        const status = await aria2.tellStatus(gid, ['status', 'errorCode', 'errorMessage']);
        if (status.status === 'complete') break;
        if (status.status === 'error') {
          fail(describeError(status.errorCode, status.errorMessage));
          return;
        }
        if (now() > deadline) {
          fail(
            'Не удалось узнать состав раздачи за минуту: сейчас нет раздающих. Попробуйте позже или найдите другую ссылку.',
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      const metaFile = path.join(options.metadataDir, `${magnet.infoHash}.torrent`);
      const meta = parseTorrent(await fsp.readFile(metaFile));
      await fsp.rm(metaFile, { force: true });
      if (meta.infoHash !== magnet.infoHash) {
        fail('Клиент получил другую раздачу, чем в ссылке. Проверьте ссылку.');
        return;
      }
      await finishCheck(check, meta, trackers);
    } catch (error) {
      if (error instanceof TorrentError) fail(error.message);
      else if (error instanceof Aria2Down)
        fail('Торрент-клиент перестал отвечать. Повторите проверку чуть позже.');
      else fail('Не удалось получить состав раздачи.');
      log(`Магнитная ссылка не проверена: ${(error as Error).message}`);
    } finally {
      if (gid) {
        await aria2.remove(gid).catch(() => undefined);
        await aria2.removeDownloadResult(gid).catch(() => undefined);
      }
    }
  }

  async function checkMagnet(owner: string, text: string): Promise<DownloadCheckResponse> {
    const magnet = parseMagnet(text);
    if (!magnet)
      throw new DownloadError(
        400,
        'bad_magnet',
        'Это не магнитная ссылка. Она начинается с «magnet:?xt=urn:btih:».',
      );
    await requireEngine();
    refuseDuplicate(owner, magnet.infoHash);
    const check = newCheck(owner);
    check.magnet = magnet;
    void fetchMetadata(check, magnet);
    return viewOfCheck(check);
  }

  async function checkFile(owner: string, bytes: Buffer, fileName: string): Promise<DownloadCheckResponse> {
    let meta: TorrentMeta;
    try {
      meta = parseTorrent(bytes);
    } catch (error) {
      if (error instanceof TorrentError) throw new DownloadError(400, 'bad_torrent', error.message);
      throw error;
    }
    await requireEngine();
    refuseDuplicate(owner, meta.infoHash);
    const check = newCheck(owner);
    await finishCheck(check, meta, []);
    log(`Проверен файл ${fileName.slice(0, 60)}`);
    return viewOfCheck(check);
  }

  // --- adding --------------------------------------------------------------------------------

  function folderFor(owner: string, destination: DownloadDestination): string {
    const target = DESTINATIONS[destination];
    return target.folder === null
      ? path.join(options.filesRoot, 'users', owner, DOWNLOADS_FOLDER)
      : path.join(options.mediaRoot, target.folder);
  }

  const gidOf = (statuses: readonly Aria2Status[], infoHash: string) =>
    statuses.find((entry) => entry.infoHash === infoHash);

  async function submit(record: Record_, torrent: Buffer): Promise<void> {
    await fsp.mkdir(record.dir, { recursive: true });
    await aria2.addTorrent(torrent, {
      dir: record.dir,
      'select-file': record.selected.join(','),
      'seed-ratio': String(options.seedRatio),
      'seed-time': '1440',
      'max-upload-limit': `${options.uploadLimitKb}K`,
      'allow-overwrite': 'false',
      'auto-file-renaming': 'true',
      'bt-stop-timeout': '0',
    });
  }

  async function add(
    owner: string,
    checkId: string,
    destination: DownloadDestination,
  ): Promise<DownloadTaskView> {
    dropExpiredChecks();
    const check = checks.get(checkId);
    if (!check || check.owner !== owner || check.expiresAt < now()) {
      throw new DownloadError(
        400,
        'check_expired',
        'Сначала проверьте раздачу ещё раз — прошлая проверка устарела.',
      );
    }
    if (check.status !== 'ready' || !check.meta) {
      throw new DownloadError(
        409,
        'not_ready',
        check.status === 'failed'
          ? (check.error ?? 'Раздача не прошла проверку.')
          : 'Раздача ещё проверяется — подождите несколько секунд.',
      );
    }
    if (!(destination in DESTINATIONS))
      throw new DownloadError(400, 'bad_destination', 'Выберите, куда сохранить.');
    const meta = check.meta;
    await requireEngine();
    refuseDuplicate(owner, meta.infoHash);

    const selected: number[] = [];
    const paths: string[] = [];
    let wantedBytes = 0;
    meta.files.forEach((entry, index) => {
      if (isBlockedName(entry.path[entry.path.length - 1] ?? '')) return;
      selected.push(index + 1);
      paths.push(entry.path.join('/'));
      wantedBytes += entry.length;
    });
    if (wantedBytes > options.maxBytes) {
      throw new DownloadError(
        413,
        'too_large',
        `Раздача слишком большая: не больше ${Math.round(options.maxBytes / 1024 ** 3)} ГБ.`,
      );
    }
    const dir = folderFor(owner, destination);
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (error) {
      log(`Папка загрузок недоступна (${dir}): ${(error as Error).message}`);
      throw new DownloadError(
        507,
        'storage_error',
        'Папка для этой загрузки на сервере недоступна (диск отключён или повреждён). Сообщите администратору.',
      );
    }
    const free = await options.freeBytes(dir);
    if (free !== null && free - wantedBytes < options.minFreeBytes) {
      throw new DownloadError(
        507,
        'no_space',
        'На диске сервера мало места — загрузка не начата. Сообщите администратору.',
      );
    }

    const torrent = rebuildTorrent(meta.raw, check.trackers);
    const record: Record_ = {
      id: meta.infoHash,
      owner,
      name: meta.name,
      destination,
      dir,
      addedAt: isoNow(clock),
      totalBytes: wantedBytes,
      selected,
      fileCount: meta.files.length,
      skipped: meta.files.length - selected.length,
      paths,
      single: meta.single,
      state: 'active',
      completedAt: null,
      error: null,
      uploadedBytes: 0,
      notified: null,
    };
    try {
      await submit(record, torrent);
    } catch (error) {
      if (error instanceof Aria2Error && error.code === 1 && /already/i.test(error.message)) {
        throw new DownloadError(409, 'duplicate', 'Эта раздача уже есть в торрент-клиенте.');
      }
      if (error instanceof Aria2Down) throw new DownloadError(503, 'torrent_unavailable', error.message);
      throw new DownloadError(502, 'torrent_error', 'Торрент-клиент не принял раздачу.');
    }
    checks.delete(checkId);
    await fsp.mkdir(copies, { recursive: true });
    await fsp.writeFile(path.join(copies, `${meta.infoHash}.torrent`), torrent);
    records.set(record.id, record);
    await save();
    options.onEvent?.({ action: 'download.add', actor: owner, detail: `торрент: ${record.name}` });
    // Just handed over: what the client says now, or «в очереди» when it has not shown it yet.
    const known = (await allStatuses())?.find((entry) => entry.infoHash === record.id);
    return viewOf(record, known ?? { gid: '', status: 'waiting' });
  }

  // --- the list ------------------------------------------------------------------------------

  function viewOf(record: Record_, status: Aria2Status | undefined, engineDown = false): DownloadTaskView {
    const total = record.totalBytes;
    let state: DownloadState;
    let error: string | null = null;
    let received = 0;
    let speed: number | null = null;
    let uploadSpeed: number | null = null;
    let uploaded = record.uploadedBytes;
    let seeding = false;
    let seeders: number | null = null;
    let connections: number | null = null;
    if (record.state === 'completed' && !status) {
      state = 'completed';
      received = total;
    } else if (status) {
      received = Math.min(num(status.completedLength), total || num(status.completedLength));
      uploaded = Math.max(uploaded, num(status.uploadLength));
      connections = status.connections === undefined ? null : num(status.connections);
      seeders = status.numSeeders === undefined ? null : num(status.numSeeders);
      switch (status.status) {
        case 'active':
          if (status.seeder === 'true' || (total > 0 && received >= total)) {
            state = 'completed';
            seeding = true;
            received = total;
            uploadSpeed = num(status.uploadSpeed);
          } else {
            state = 'downloading';
            speed = num(status.downloadSpeed);
            uploadSpeed = num(status.uploadSpeed);
          }
          break;
        case 'waiting':
          state = 'queued';
          break;
        case 'paused':
          state = 'paused';
          break;
        case 'complete':
          state = 'completed';
          received = total;
          break;
        case 'error':
          state = 'failed';
          error = describeError(status.errorCode, status.errorMessage);
          break;
        default:
          state = 'canceled';
      }
    } else if (record.state === 'failed') {
      state = 'failed';
      error = record.error ?? 'Загрузка не удалась.';
    } else if (engineDown) {
      state = 'failed';
      error =
        'Торрент-клиент сейчас не отвечает: ход загрузки неизвестен. Когда он вернётся, загрузка продолжится сама.';
    } else {
      state = 'failed';
      error = 'Торрент-клиент потерял эту загрузку. Нажмите «Повторить».';
    }
    const left = total - received;
    return {
      id: `${TORRENT_ID_PREFIX}${record.id}`,
      owner: record.owner,
      url: `magnet:?xt=urn:btih:${record.id}`,
      host: 'торрент',
      fileName: record.name,
      sizeBytes: total,
      receivedBytes: received,
      state,
      error,
      createdAt: record.addedAt,
      updatedAt: record.completedAt ?? record.addedAt,
      completedAt: record.completedAt,
      speedBps: speed,
      kind: 'torrent',
      torrent: {
        seeding,
        uploadedBytes: uploaded,
        uploadSpeedBps: uploadSpeed,
        seeders,
        connections,
        etaSec: speed && speed > 0 && left > 0 ? Math.round(left / speed) : null,
        ratio: received > 0 ? Math.round((uploaded / received) * 100) / 100 : null,
        fileCount: record.selected.length,
      },
      destinationLabel: DESTINATIONS[record.destination].label,
      inLibrary: DESTINATIONS[record.destination].folder !== null && state === 'completed',
    };
  }

  async function allStatuses(): Promise<Aria2Status[] | null> {
    try {
      const [active, waiting, stopped] = await Promise.all([
        aria2.tellActive(),
        aria2.tellWaiting(),
        aria2.tellStopped(),
      ]);
      return [...active, ...waiting, ...stopped];
    } catch (error) {
      // Not answering, or not accepting the key: either way the client cannot be used right now.
      if (error instanceof Aria2Down || error instanceof Aria2Error) return null;
      throw error;
    }
  }

  async function list(owner: string | null): Promise<DownloadTaskView[]> {
    const statuses = await allStatuses();
    return [...records.values()]
      .filter((record) => owner === null || record.owner === owner)
      .map((record) => viewOf(record, statuses ? gidOf(statuses, record.id) : undefined, statuses === null))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  // --- finishing -----------------------------------------------------------------------------

  /** The absolute paths of the files this download writes. */
  function filesOf(record: Record_): string[] {
    if (record.single) return [path.join(record.dir, record.name)];
    const root = path.join(record.dir, record.name);
    return record.paths.map((relative) => path.join(root, ...relative.split('/')));
  }

  /** Marks the finished files «from the internet» (as a browser does) so Windows warns before opening programs. */
  async function markFromInternet(record: Record_): Promise<void> {
    if (process.platform !== 'win32') return;
    for (const target of filesOf(record).slice(0, 2000)) {
      await fsp
        .writeFile(`${target}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n')
        .catch(() => undefined);
    }
  }

  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      const statuses = await allStatuses();
      if (!statuses) return;
      let changed = false;
      for (const record of records.values()) {
        const status = gidOf(statuses, record.id);
        if (!status) continue;
        const done = status.status === 'complete' || (status.status === 'active' && status.seeder === 'true');
        if (done && record.state !== 'completed') {
          record.state = 'completed';
          record.completedAt = isoNow(clock);
          record.uploadedBytes = num(status.uploadLength);
          changed = true;
          await markFromInternet(record);
          if (record.notified !== 'done') {
            record.notified = 'done';
            options.onEvent?.({
              action: 'download.done',
              actor: record.owner,
              detail: `торрент: ${record.name}`,
            });
          }
          if (DESTINATIONS[record.destination].folder !== null) {
            options
              .onLibraryChanged?.()
              .catch((error: unknown) => log(`Jellyfin не обновил медиатеку: ${(error as Error).message}`));
          }
        } else if (status.status === 'error' && record.state !== 'failed') {
          record.state = 'failed';
          record.error = describeError(status.errorCode, status.errorMessage);
          changed = true;
          if (record.notified !== 'fail') {
            record.notified = 'fail';
            options.onEvent?.({
              action: 'download.fail',
              actor: record.owner,
              detail: `${record.name}: ${record.error}`,
            });
          }
        } else if (status.status === 'active' || status.status === 'waiting' || status.status === 'paused') {
          record.uploadedBytes = Math.max(record.uploadedBytes, num(status.uploadLength));
        }
      }
      if (changed) await save();
    } catch (error) {
      log(`Опрос торрент-клиента не удался: ${(error as Error).message}`);
    } finally {
      polling = false;
    }
  }

  // --- actions -------------------------------------------------------------------------------

  /** Removes what a cancelled or failed download left on disk: only its own selected files, only inside its folder. */
  async function removePartialFiles(record: Record_): Promise<void> {
    const root = path.join(record.dir, record.name);
    const targets = filesOf(record);
    const realDir = await fsp.realpath(record.dir).catch(() => null);
    if (!realDir) return;
    for (const target of targets) {
      const resolved = path.resolve(target);
      const relative = path.relative(realDir, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
      await fsp.rm(resolved, { force: true }).catch(() => undefined);
      await fsp.rm(`${resolved}.aria2`, { force: true }).catch(() => undefined);
    }
    // Folders that became empty (never one that still holds something).
    if (!record.single) await removeEmptyTree(root, realDir);
  }

  async function removeEmptyTree(dir: string, boundary: string): Promise<void> {
    const relative = path.relative(boundary, path.resolve(dir));
    if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') return;
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry);
      if ((await fsp.lstat(child).catch(() => null))?.isDirectory()) await removeEmptyTree(child, boundary);
    }
    await fsp.rmdir(dir).catch(() => undefined);
  }

  async function act(
    id: string,
    action: 'pause' | 'resume' | 'cancel' | 'remove' | 'retry',
    actor: { username: string; isAdmin: boolean },
  ): Promise<DownloadTaskView | null> {
    const hash = id.slice(TORRENT_ID_PREFIX.length);
    const record = records.get(hash);
    if (!record || (record.owner !== actor.username && !actor.isAdmin)) {
      throw new DownloadError(404, 'not_found', 'Такой загрузки нет.');
    }
    const statuses = await allStatuses();
    if (statuses === null && action !== 'remove') {
      throw new DownloadError(
        503,
        'torrent_unavailable',
        'Торрент-клиент сейчас не отвечает. Попробуйте через минуту.',
      );
    }
    const status = statuses ? gidOf(statuses, record.id) : undefined;
    const wrap = async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (error) {
        if (error instanceof Aria2Down) throw new DownloadError(503, 'torrent_unavailable', error.message);
        if (error instanceof Aria2Error)
          throw new DownloadError(
            409,
            'torrent_error',
            'Торрент-клиент не смог выполнить действие с этой загрузкой.',
          );
        throw error;
      }
    };
    switch (action) {
      case 'pause':
        if (!status) throw new DownloadError(409, 'bad_state', 'Эту загрузку нельзя поставить на паузу.');
        await wrap(() => aria2.pause(status.gid));
        break;
      case 'resume':
        if (!status)
          throw new DownloadError(409, 'bad_state', 'Эту загрузку нельзя продолжить: нажмите «Повторить».');
        await wrap(() => aria2.unpause(status.gid));
        break;
      case 'retry': {
        if (status && status.status !== 'error')
          throw new DownloadError(409, 'bad_state', 'Эта загрузка не требует повтора.');
        if (status) {
          await wrap(async () => {
            await aria2.remove(status.gid).catch(() => undefined);
            await aria2.removeDownloadResult(status.gid);
          });
        }
        let torrent: Buffer;
        try {
          torrent = await fsp.readFile(path.join(copies, `${record.id}.torrent`));
        } catch {
          throw new DownloadError(410, 'gone', 'Файл раздачи потерян. Добавьте торрент заново.');
        }
        record.state = 'active';
        record.error = null;
        record.notified = null;
        await wrap(() => submit(record, torrent));
        await save();
        break;
      }
      case 'cancel':
      case 'remove': {
        const live = status && ['active', 'waiting', 'paused'].includes(status.status);
        if (action === 'cancel' && record.state === 'completed' && !live) {
          throw new DownloadError(409, 'bad_state', 'Загрузка уже закончилась. Нажмите «Убрать из списка».');
        }
        if (status) {
          await wrap(async () => {
            if (live) await aria2.remove(status.gid).catch(() => undefined);
            await aria2.removeDownloadResult(status.gid).catch(() => undefined);
          });
        }
        // A finished download keeps its files; an unfinished one takes its crumbs with it.
        if (record.state !== 'completed') await removePartialFiles(record);
        records.delete(record.id);
        await fsp.rm(path.join(copies, `${record.id}.torrent`), { force: true }).catch(() => undefined);
        await save();
        if (action === 'cancel') {
          options.onEvent?.({
            action: 'download.cancel',
            actor: actor.username,
            detail: `торрент: ${record.name}`,
          });
        }
        return null;
      }
    }
    return viewOf(
      record,
      (await allStatuses())?.find((entry) => entry.infoHash === record.id),
    );
  }

  return {
    engine,
    async load() {
      let data: unknown;
      try {
        data = await readJsonFile(file);
      } catch (error) {
        log(`Файл torrents.json не прочитан: ${(error as Error).message}`);
        return;
      }
      if (data === undefined) return;
      const parsed = fileSchema.safeParse(data);
      if (!parsed.success) {
        log('Файл torrents.json имеет неверный формат: список торрентов не загружен.');
        return;
      }
      for (const record of parsed.data.items) records.set(record.id, record);
    },
    start() {
      if (timer) return;
      timer = setInterval(() => void poll(), POLL_MS);
      timer.unref();
      void poll();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const check of checks.values()) check.aborted = true;
    },
    checkMagnet,
    checkFile,
    getCheck(owner, checkId) {
      dropExpiredChecks();
      const check = checks.get(checkId);
      return check && check.owner === owner ? viewOfCheck(check) : null;
    },
    isTorrentCheck: (checkId) => checks.has(checkId),
    add,
    list,
    owns: (id) => id.startsWith(TORRENT_ID_PREFIX),
    act,
    poll,
  };
}
