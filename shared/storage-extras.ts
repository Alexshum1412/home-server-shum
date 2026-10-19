/** Contract of the sturdier uploads, the duplicate check, the trash view, albums and quotas of «Файлы» и «Фото». */
import type { StorageSpace, UploadResponse } from './api.ts';

/** How full a person's own space is. `level` is what the page says: nothing, a warning from 90 %, a refusal at 100 %. */
export interface QuotaState {
  usedBytes: number;
  limitBytes: number;
  level: 'ok' | 'warn' | 'full';
}

/** POST /api/storage/:root/session — starts an upload that survives a broken connection. */
export interface UploadSessionRequest {
  space: StorageSpace;
  path: string;
  name: string;
  size: number;
  /** JPEG only: take the place of shooting, the camera and the editor's notes out (default: yes). */
  strip?: boolean;
  /** SHA-256 of the file as it is on the phone (hex), checked when the last piece has arrived. */
  sha256?: string;
}

export interface UploadSessionState {
  id: string;
  name: string;
  size: number;
  /** How many bytes the server holds: the next piece must start exactly here. */
  receivedBytes: number;
  /** The largest piece the server takes at once. */
  chunkBytes: number;
}

/** PUT /api/storage/:root/session/:id?offset= answered 409 when the offset is not where the server is. */
export interface UploadOffsetMismatch {
  error: 'offset_mismatch';
  message: string;
  receivedBytes: number;
}

export type FinishUploadResponse = UploadResponse;

/** POST /api/storage/photos/hashes — which of these files the person's photos already hold. */
export interface HashQueryRequest {
  space: StorageSpace;
  /** Lowercase hex SHA-256 of the files on the phone, at most 200 at a time. */
  hashes: string[];
}

export interface HashQueryResponse {
  /** The hashes that are already stored (so the file need not be sent again). */
  known: string[];
  /** False while older photos are still being checked: a missing answer is then «not known yet», not «new». */
  complete: boolean;
  /** How many older photos are not checked yet. */
  pending: number;
}

/** GET /api/storage/:root/trash?space= */
export interface TrashEntry {
  /** Name in the trash; the key for «Вернуть». */
  id: string;
  /** The name the item had. */
  name: string;
  type: 'dir' | 'file';
  sizeBytes: number | null;
  deletedAt: string | null;
  /** The folder it came from ('' = the top), when the portal remembers. */
  from: string | null;
}

export interface TrashResponse {
  entries: TrashEntry[];
}

/** GET /api/storage/photos/albums?space= */
export interface AlbumEntry {
  name: string;
  count: number;
  /** A photo of the album that has a preview, for the picture on its card. */
  cover: string | null;
}

export interface AlbumsResponse {
  albums: AlbumEntry[];
}

/** The folder of the photo library that holds the albums. */
export const ALBUMS_FOLDER = 'Альбомы';
