/** The real network behind the upload queue (see lib/uploader.ts): the portal's own API, nothing else. */
import type { StorageRoot, StorageSpace, UploadResponse } from '../../../shared/api.ts';
import type { HashQueryResponse, UploadSessionState } from '../../../shared/storage-extras.ts';
import { ApiFailure, apiGet, apiPost, NO_CONNECTION, toFailure } from '../api.ts';
import { OffsetError, type UploadApi } from './uploader.ts';

interface RawAnswer {
  status: number;
  text: string;
}

/** A raw PUT with progress (fetch cannot report how much of the body has gone) and a stop. */
function rawPut(
  url: string,
  body: Blob,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
): Promise<RawAnswer> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Остановлено', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Upload', '1');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };
    const onAbort = () => xhr.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    xhr.onload = () => {
      signal.removeEventListener('abort', onAbort);
      resolve({ status: xhr.status, text: xhr.responseText });
    };
    xhr.onerror = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new ApiFailure('network', NO_CONNECTION));
    };
    xhr.ontimeout = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new ApiFailure('timeout', 'Домашний сервер не ответил вовремя.'));
    };
    xhr.onabort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('Остановлено', 'AbortError'));
    };
    xhr.send(body);
  });
}

function failureOf(answer: RawAnswer): ApiFailure {
  let message = `Ошибка ${answer.status}`;
  let code: string | undefined;
  try {
    const parsed = JSON.parse(answer.text) as { message?: string; error?: string };
    message = parsed.message ?? message;
    code = parsed.error;
  } catch {
    // the proxy in front of the portal answers 502/503/504 without JSON while the portal restarts
    if (answer.status === 502 || answer.status === 503 || answer.status === 504) {
      return new ApiFailure('network', NO_CONNECTION, answer.status);
    }
  }
  return new ApiFailure('http', message, answer.status, code);
}

export function browserUploadApi(): UploadApi {
  return {
    hashes: (space, hashes) => apiPost<HashQueryResponse>('/api/storage/photos/hashes', { space, hashes }),

    async putSingle(root, params, body, onProgress, signal) {
      const query = new URLSearchParams({
        space: params.space,
        path: params.path,
        name: params.name,
        size: String(params.size),
        strip: params.strip ? '1' : '0',
      });
      if (params.sha256) query.set('sha256', params.sha256);
      const answer = await rawPut(
        `/api/storage/${root}/upload?${query.toString()}`,
        body,
        onProgress,
        signal,
      );
      if (answer.status < 200 || answer.status >= 300) throw failureOf(answer);
      return JSON.parse(answer.text) as UploadResponse;
    },

    startSession: (root, body) => apiPost<UploadSessionState>(`/api/storage/${root}/session`, body),

    async sessionStatus(root, id) {
      try {
        return await apiGet<UploadSessionState>(`/api/storage/${root}/session/${id}`);
      } catch (error) {
        const failure = toFailure(error);
        if (failure.status === 404) return null;
        throw error;
      }
    },

    async putPiece(root, id, offset, body, onProgress, signal) {
      const answer = await rawPut(
        `/api/storage/${root}/session/${id}?offset=${offset}`,
        body,
        onProgress,
        signal,
      );
      if (answer.status === 409) {
        try {
          const parsed = JSON.parse(answer.text) as { error?: string; receivedBytes?: number };
          if (parsed.error === 'offset_mismatch' && typeof parsed.receivedBytes === 'number') {
            throw new OffsetError(parsed.receivedBytes);
          }
        } catch (error) {
          if (error instanceof OffsetError) throw error;
        }
      }
      if (answer.status < 200 || answer.status >= 300) throw failureOf(answer);
      return (JSON.parse(answer.text) as { receivedBytes: number }).receivedBytes;
    },

    finish: (root, id) => apiPost<UploadResponse>(`/api/storage/${root}/session/${id}/finish`, {}),

    async cancelSession(root, id) {
      await apiPost(`/api/storage/${root}/session/${id}/cancel`, {});
    },

    async mkdir(root: StorageRoot, space: StorageSpace, path: string) {
      if (path === '') return;
      let parent = '';
      for (const name of path.split('/')) {
        try {
          await apiPost(`/api/storage/${root}/mkdir`, { space, path: parent, name });
        } catch (error) {
          // «уже есть» is what is wanted
          if (toFailure(error).status !== 409) throw error;
        }
        parent = parent === '' ? name : `${parent}/${name}`;
      }
    },
  };
}
