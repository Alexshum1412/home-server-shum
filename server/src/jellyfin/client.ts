/**
 * Read-only view of Jellyfin for the portal's cinema page: libraries, posters, search, details and
 * the file itself. Jellyfin stays the media server; nothing here changes its data.
 *
 * The API key never leaves the server: the browser asks the portal (signed in), the portal asks
 * Jellyfin on 127.0.0.1 and passes on only what the page needs. Item ids are checked before they
 * are put into an address, and only the few paths below are ever requested.
 */
import type {
  CatalogDetailResponse,
  CatalogItem,
  CatalogKind,
  CatalogLibrary,
  CatalogPlayback,
} from '../../../shared/api.ts';

export class JellyfinError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const ITEM_ID_RE = /^[0-9a-f]{32}$/i;

/** What Jellyfin sends for one item (only the fields used here). */
interface BaseItem {
  Id?: string;
  Name?: string;
  Type?: string;
  ProductionYear?: number;
  Genres?: string[];
  RunTimeTicks?: number;
  CommunityRating?: number;
  ImageTags?: Record<string, string>;
  SeriesName?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  Overview?: string;
  CollectionType?: string;
  MediaSources?: Array<{
    Container?: string;
    RunTimeTicks?: number;
    MediaStreams?: Array<{ Type?: string; Codec?: string; Width?: number; Height?: number }>;
  }>;
}

interface ItemsPage {
  Items?: BaseItem[];
  TotalRecordCount?: number;
}

const KIND: Record<string, CatalogKind> = {
  Movie: 'movie',
  Series: 'series',
  Season: 'season',
  Episode: 'episode',
  Audio: 'track',
  MusicAlbum: 'album',
  // In a «books» library a folder is one book; its files are the chapters.
  Folder: 'book',
  AudioBook: 'audiobook',
  Video: 'video',
};

const LIBRARY_KIND: Record<string, CatalogLibrary['kind']> = {
  movies: 'movies',
  tvshows: 'tvshows',
  music: 'music',
  books: 'books',
  homevideos: 'homevideos',
};

const FIELDS = 'Genres,ProductionYear,RunTimeTicks,CommunityRating,ImageTags';
const TICKS_PER_SECOND = 10_000_000;
/** What the catalogue shows as a card. A book is a folder (see list()), a chapter is shown inside its book. */
const LISTED_TYPES = 'Movie,Series,MusicAlbum,Video';

export interface JellyfinSettings {
  /** Always an address on this PC (checked by the caller). */
  baseUrl: string;
  /** Reads the saved API key; null when Jellyfin has not been set up. */
  apiKey: () => string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface Resume {
  positionSec: number;
  durationSec: number;
}

export interface JellyfinClient {
  /** null when the cinema works; otherwise why not, in plain words. */
  availability(): Promise<string | null>;
  libraries(): Promise<CatalogLibrary[]>;
  genres(): Promise<string[]>;
  list(
    options: {
      parentId?: string;
      search?: string;
      genre?: string;
      sort: 'name' | 'added' | 'year';
      start: number;
      limit: number;
    },
    resume: (id: string) => Resume | undefined,
  ): Promise<{ items: CatalogItem[]; total: number }>;
  byIds(ids: readonly string[], resume: (id: string) => Resume | undefined): Promise<CatalogItem[]>;
  detail(
    id: string,
    resume: (id: string) => Resume | undefined,
  ): Promise<Omit<CatalogDetailResponse, 'jellyfinUrl'>>;
  /** The picture of an item (a poster), as a ready response to pass on. */
  image(id: string, width: number): Promise<Response>;
  /** The media file as it is on disk, for a browser that can play it; honours a Range header. */
  stream(
    id: string,
    media: 'video' | 'audio',
    range: string | undefined,
    signal: AbortSignal,
  ): Promise<Response>;
}

const SAFE_CONTAINERS = new Set([
  'mp4',
  'm4v',
  'mov',
  'webm',
  'mp3',
  'm4a',
  'm4b',
  'ogg',
  'oga',
  'opus',
  'flac',
  'wav',
  'aac',
]);
const SAFE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const SAFE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le']);

/** How the file can be played by a browser, from what Jellyfin knows about it. Pure; tested on its own. */
export function judgePlayback(info: {
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  media: 'video' | 'audio' | null;
}): { playback: CatalogPlayback; note: string | null } {
  if (info.media === null) return { playback: 'jellyfin', note: null };
  const containers = (info.container ?? '').toLowerCase().split(',');
  const matroska = containers.some((name) => ['matroska', 'mkv'].includes(name.trim()));
  const video = info.videoCodec?.toLowerCase() ?? null;
  const audio = info.audioCodec?.toLowerCase() ?? null;
  // Jellyfin names both MKV and WebM «matroska,webm»: it is a WebM only with WebM's own codecs.
  const webm =
    matroska &&
    video !== null &&
    ['vp8', 'vp9', 'av1'].includes(video) &&
    (audio === null || ['opus', 'vorbis'].includes(audio));
  const containerOk = containers.some(
    (name) => SAFE_CONTAINERS.has(name.trim()) && !(name.trim() === 'webm' && matroska && !webm),
  );
  const videoOk = info.media === 'audio' || video === null || SAFE_VIDEO.has(video);
  const audioOk = audio === null || SAFE_AUDIO.has(audio);
  if (containerOk && videoOk && audioOk) return { playback: 'direct', note: null };
  if (matroska && videoOk && audioOk && video !== null) {
    return {
      playback: 'maybe',
      note: 'Файл в формате MKV: Chrome и Edge обычно его играют, Safari и Firefox — нет. Если не заиграет, откройте в Jellyfin.',
    };
  }
  const why: string[] = [];
  if (!containerOk) why.push(`контейнер ${info.container ?? 'неизвестен'}`);
  if (!videoOk) why.push(`видео ${video}`);
  if (!audioOk) why.push(`звук ${audio}`);
  return {
    playback: 'jellyfin',
    note: `Браузер не умеет играть этот файл как есть (${why.join(', ')}). Jellyfin перекодирует его на лету — откройте в Jellyfin.`,
  };
}

export function createJellyfinClient(settings: JellyfinSettings): JellyfinClient {
  const doFetch = settings.fetch ?? fetch;
  const timeout = settings.timeoutMs ?? 8000;

  async function call(
    path: string,
    init: { headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number | null } = {},
  ): Promise<Response> {
    const key = settings.apiKey();
    if (!key) {
      throw new JellyfinError(
        503,
        'not_configured',
        'Кинотека не подключена: у сервера нет ключа Jellyfin. Администратору нужно выполнить scripts\\jellyfin-setup.cmd.',
      );
    }
    const signals: AbortSignal[] = [];
    if (init.signal) signals.push(init.signal);
    if (init.timeoutMs !== null) signals.push(AbortSignal.timeout(init.timeoutMs ?? timeout));
    let response: Response;
    try {
      response = await doFetch(`${settings.baseUrl}${path}`, {
        headers: { Authorization: `MediaBrowser Token="${key}"`, ...init.headers },
        signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new JellyfinError(
        502,
        'unreachable',
        'Jellyfin не отвечает. Проверьте «Состояние системы»: возможно, он перезапускается.',
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new JellyfinError(
        502,
        'unauthorized',
        'Jellyfin не принял ключ сервера. Администратору нужно выполнить scripts\\jellyfin-setup.cmd заново.',
      );
    }
    if (response.status === 404)
      throw new JellyfinError(404, 'not_found', 'Такого фильма или файла в медиатеке нет.');
    if (!response.ok && response.status !== 206) {
      throw new JellyfinError(502, 'bad_answer', `Jellyfin ответил ошибкой (код ${response.status}).`);
    }
    return response;
  }

  async function json<T>(path: string): Promise<T> {
    const response = await call(path);
    try {
      return (await response.json()) as T;
    } catch {
      throw new JellyfinError(502, 'bad_answer', 'Jellyfin прислал ответ, который не удалось прочитать.');
    }
  }

  function toItem(raw: BaseItem, resume: (id: string) => Resume | undefined): CatalogItem | null {
    const id = raw.Id;
    if (!id || !ITEM_ID_RE.test(id)) return null;
    const progress = resume(id);
    const ticks = raw.RunTimeTicks ?? raw.MediaSources?.[0]?.RunTimeTicks;
    return {
      id: id.toLowerCase(),
      title: raw.Name?.trim() || 'Без названия',
      kind: KIND[raw.Type ?? ''] ?? 'other',
      year: typeof raw.ProductionYear === 'number' ? raw.ProductionYear : null,
      genres: (raw.Genres ?? []).slice(0, 6),
      runtimeMin: ticks ? Math.max(1, Math.round(ticks / TICKS_PER_SECOND / 60)) : null,
      rating: typeof raw.CommunityRating === 'number' ? Math.round(raw.CommunityRating * 10) / 10 : null,
      hasPoster: Boolean(raw.ImageTags?.Primary),
      seriesTitle: raw.SeriesName ?? null,
      season: typeof raw.ParentIndexNumber === 'number' ? raw.ParentIndexNumber : null,
      episode: typeof raw.IndexNumber === 'number' ? raw.IndexNumber : null,
      resumeSec: progress ? Math.round(progress.positionSec) : null,
      durationSec: progress
        ? Math.round(progress.durationSec)
        : ticks
          ? Math.round(ticks / TICKS_PER_SECOND)
          : null,
    };
  }

  const items = (page: ItemsPage, resume: (id: string) => Resume | undefined): CatalogItem[] =>
    (page.Items ?? []).map((raw) => toItem(raw, resume)).filter((item): item is CatalogItem => item !== null);

  const encode = (value: string) => encodeURIComponent(value);

  return {
    async availability() {
      try {
        await call('/System/Info');
        return null;
      } catch (error) {
        return error instanceof JellyfinError ? error.message : 'Jellyfin недоступен.';
      }
    },

    async libraries() {
      const page = await json<ItemsPage>('/Library/MediaFolders');
      return (page.Items ?? [])
        .filter((raw) => raw.Id && ITEM_ID_RE.test(raw.Id))
        .map((raw) => ({
          id: (raw.Id as string).toLowerCase(),
          name: raw.Name ?? 'Библиотека',
          kind: LIBRARY_KIND[raw.CollectionType ?? ''] ?? 'other',
        }));
    },

    async genres() {
      const page = await json<ItemsPage>(
        `/Genres?Recursive=true&IncludeItemTypes=Movie,Series&SortBy=SortName`,
      );
      return (page.Items ?? []).map((raw) => raw.Name ?? '').filter((name) => name !== '');
    },

    async list(options, resume) {
      const libraries = await this.libraries();
      const parent = libraries.find((library) => library.id === options.parentId?.toLowerCase());
      const types = parent?.kind === 'books' ? 'Folder' : LISTED_TYPES;
      const sort = {
        name: 'SortName&SortOrder=Ascending',
        added: 'DateCreated&SortOrder=Descending',
        year: 'ProductionYear,SortName&SortOrder=Descending',
      }[options.sort];
      const query = [
        // A book is a direct child of its library: no need (and no wish) to go deeper.
        parent?.kind === 'books' ? 'Recursive=false' : 'Recursive=true',
        `IncludeItemTypes=${types}`,
        `Fields=${FIELDS}`,
        `SortBy=${sort}`,
        `StartIndex=${options.start}`,
        `Limit=${options.limit}`,
        options.parentId ? `ParentId=${options.parentId}` : '',
        options.search ? `searchTerm=${encode(options.search)}` : '',
        options.genre ? `Genres=${encode(options.genre)}` : '',
      ]
        .filter((part) => part !== '')
        .join('&');
      const page = await json<ItemsPage>(`/Items?${query}`);
      return { items: items(page, resume), total: page.TotalRecordCount ?? 0 };
    },

    async byIds(ids, resume) {
      const clean = ids.filter((id) => ITEM_ID_RE.test(id));
      if (clean.length === 0) return [];
      const page = await json<ItemsPage>(`/Items?Ids=${clean.join(',')}&Fields=${FIELDS}`);
      const found = new Map(items(page, resume).map((item) => [item.id, item]));
      return clean
        .map((id) => found.get(id.toLowerCase()))
        .filter((item): item is CatalogItem => item !== undefined);
    },

    async detail(id, resume) {
      if (!ITEM_ID_RE.test(id))
        throw new JellyfinError(404, 'not_found', 'Такого фильма или файла в медиатеке нет.');
      const page = await json<ItemsPage>(`/Items?Ids=${id}&Fields=${FIELDS},Overview,MediaSources`);
      const raw = page.Items?.[0];
      const item = raw ? toItem(raw, resume) : null;
      if (!raw || !item)
        throw new JellyfinError(404, 'not_found', 'Такого фильма или файла в медиатеке нет.');
      const source = raw.MediaSources?.[0];
      const video = source?.MediaStreams?.find((stream) => stream.Type === 'Video');
      const audio = source?.MediaStreams?.find((stream) => stream.Type === 'Audio');
      const playable =
        ['movie', 'episode', 'video', 'track', 'audiobook'].includes(item.kind) && source !== undefined;
      const media: 'video' | 'audio' | null = !playable
        ? null
        : video && item.kind !== 'track' && item.kind !== 'audiobook'
          ? 'video'
          : 'audio';
      const verdict = judgePlayback({
        container: source?.Container ?? null,
        videoCodec: video?.Codec ?? null,
        audioCodec: audio?.Codec ?? null,
        media,
      });
      let children: CatalogItem[] = [];
      if (item.kind === 'series') {
        children = items(
          await json<ItemsPage>(
            `/Items?ParentId=${id}&IncludeItemTypes=Season&SortBy=IndexNumber&Fields=${FIELDS}`,
          ),
          resume,
        );
      } else if (item.kind === 'season') {
        children = items(
          await json<ItemsPage>(
            `/Items?ParentId=${id}&IncludeItemTypes=Episode&SortBy=IndexNumber&Fields=${FIELDS}`,
          ),
          resume,
        );
      } else if (item.kind === 'album' || item.kind === 'book') {
        children = items(
          await json<ItemsPage>(
            `/Items?ParentId=${id}&IncludeItemTypes=Audio,AudioBook&SortBy=ParentIndexNumber,IndexNumber,SortName&Fields=${FIELDS}`,
          ),
          resume,
        );
      }
      return {
        item,
        overview: raw.Overview?.trim() || null,
        container: source?.Container ?? null,
        videoCodec: video?.Codec ?? null,
        audioCodec: audio?.Codec ?? null,
        width: video?.Width ?? null,
        height: video?.Height ?? null,
        playback: verdict.playback,
        playbackNote: verdict.note,
        media,
        children,
      };
    },

    async image(id, width) {
      if (!ITEM_ID_RE.test(id)) throw new JellyfinError(404, 'not_found', 'Нет картинки.');
      return call(
        `/Items/${id}/Images/Primary?maxWidth=${Math.min(Math.max(Math.trunc(width), 64), 800)}&quality=80`,
      );
    },

    async stream(id, media, range, signal) {
      if (!ITEM_ID_RE.test(id)) throw new JellyfinError(404, 'not_found', 'Такого файла в медиатеке нет.');
      const path =
        media === 'video'
          ? `/Videos/${id}/stream?static=true&mediaSourceId=${id}`
          : `/Audio/${id}/stream?static=true`;
      // A file is streamed for as long as it is watched: no overall time limit, only the client's own abort.
      return call(path, { headers: range ? { Range: range } : {}, signal, timeoutMs: null });
    },
  };
}
