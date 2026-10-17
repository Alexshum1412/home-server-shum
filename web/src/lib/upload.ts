/**
 * Uploads to the family storage: a raw PUT with X-Upload: 1 (the server's CSRF rule for uploads),
 * through XMLHttpRequest because fetch() cannot report upload progress.
 */
import type { StorageRoot, StorageSpace, UploadResponse } from '../../../shared/api.ts';
import { ApiFailure, NO_CONNECTION } from '../api.ts';

export interface UploadTarget {
  root: StorageRoot;
  space: StorageSpace;
  path: string;
}

export function storageQuery(target: UploadTarget, extra: Record<string, string> = {}): string {
  return new URLSearchParams({ space: target.space, path: target.path, ...extra }).toString();
}

export function putRaw(
  url: string,
  body: Blob,
  onProgress?: (loaded: number, total: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Upload', '1');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded, event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.responseText);
        return;
      }
      let message = `Ошибка ${xhr.status}`;
      let code: string | undefined;
      try {
        const parsed = JSON.parse(xhr.responseText) as { message?: string; error?: string };
        message = parsed.message ?? message;
        code = parsed.error;
      } catch {
        // not JSON
      }
      reject(new ApiFailure('http', message, xhr.status, code));
    };
    xhr.onerror = () => reject(new ApiFailure('network', NO_CONNECTION));
    xhr.ontimeout = () => reject(new ApiFailure('timeout', 'Домашний сервер не ответил вовремя.'));
    xhr.send(body);
  });
}

export async function uploadFile(
  target: UploadTarget,
  file: File,
  onProgress?: (loaded: number, total: number) => void,
): Promise<UploadResponse> {
  const query = storageQuery(target, { name: file.name, size: String(file.size) });
  const text = await putRaw(`/api/storage/${target.root}/upload?${query}`, file, onProgress);
  return JSON.parse(text) as UploadResponse;
}

/**
 * A small JPEG preview (longest side 360 px) made by the browser from an image file; null when
 * the browser cannot decode the format (e.g. HEIC in Chrome) — the gallery then shows an icon.
 */
export async function makeThumbnail(file: File): Promise<Blob | null> {
  if (!file.type.startsWith('image/') || typeof createImageBitmap !== 'function') return null;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 360 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  } catch {
    return null;
  }
}

export async function uploadThumbnail(target: UploadTarget, name: string, thumb: Blob): Promise<void> {
  await putRaw(`/api/storage/${target.root}/thumb?${storageQuery(target, { name })}`, thumb);
}

/** "2026-10" folder for a photo, from the file's own date (falls back to today). */
export function monthFolder(file: File, now = new Date()): string {
  const date = file.lastModified ? new Date(file.lastModified) : now;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
