/**
 * Typed access to the portal API. Every request has a 10 s timeout, sends the
 * session cookie (same origin only) and turns every failure into an ApiFailure
 * with a Russian message that is safe to show.
 */
import type { ApiError } from '../../shared/api.ts';

export const REQUEST_TIMEOUT_MS = 10_000;
export const NO_CONNECTION = 'Нет связи с домашним сервером';

export type FailureKind = 'network' | 'timeout' | 'http';

export class ApiFailure extends Error {
  readonly kind: FailureKind;
  readonly status: number | undefined;
  readonly code: string | undefined;

  constructor(kind: FailureKind, message: string, status?: number, code?: string) {
    super(message);
    this.name = 'ApiFailure';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }

  /** True when the server could not be reached at all (as opposed to an error answer). */
  get unreachable(): boolean {
    return this.kind !== 'http';
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** Do not broadcast a 401 (the session probe and the login form handle it themselves). */
  quiet401?: boolean;
}

// --- 401 broadcast -----------------------------------------------------------

const unauthorizedListeners = new Set<() => void>();

/** Subscribe to "the session is gone" (any API call answered 401). Returns an unsubscribe function. */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

function emitUnauthorized(): void {
  for (const listener of unauthorizedListeners) listener();
}

// --- helpers ----------------------------------------------------------------

function combineSignals(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Maps a fetch/body exception to an ApiFailure; a caller-initiated abort is re-thrown as is. */
function transportFailure(error: unknown): unknown {
  if (isAbortError(error)) return error;
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new ApiFailure('timeout', 'Домашний сервер не ответил за 10 секунд.');
  }
  return new ApiFailure('network', NO_CONNECTION);
}

function fallbackMessage(status: number): string {
  if (status === 401) return 'Нужно войти заново.';
  if (status === 403) return 'Недостаточно прав для этого действия.';
  if (status === 404) return 'Не найдено.';
  if (status === 429) return 'Слишком много запросов. Попробуйте чуть позже.';
  if (status >= 500) return `Ошибка на домашнем сервере (код ${status}).`;
  return `Запрос не выполнен (код ${status}).`;
}

function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ApiError).message === 'string' &&
    typeof (value as ApiError).error === 'string'
  );
}

async function failureFromResponse(response: Response): Promise<ApiFailure> {
  let body: unknown = null;
  try {
    if (response.headers.get('content-type')?.includes('application/json')) body = await response.json();
  } catch {
    body = null;
  }
  if (isApiError(body)) return new ApiFailure('http', body.message, response.status, body.error);
  // A proxy in front of the portal (Tailscale Serve) answers 502/503/504 when the portal is down.
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    return new ApiFailure('network', NO_CONNECTION, response.status);
  }
  return new ApiFailure('http', fallbackMessage(response.status), response.status);
}

async function send(method: 'GET' | 'POST', path: string, body: unknown, options: RequestOptions) {
  const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
  if (options.signal) signals.push(options.signal);
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal: combineSignals(signals),
  };
  if (method === 'POST') {
    init.headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    throw transportFailure(error);
  }
  if (!response.ok) {
    const failure = await failureFromResponse(response);
    if (response.status === 401 && !options.quiet401) emitUnauthorized();
    throw failure;
  }
  return response;
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch (error) {
    const mapped = transportFailure(error);
    if (mapped instanceof ApiFailure && mapped.kind === 'network') {
      throw new ApiFailure('http', 'Сервер прислал ответ, который не удалось прочитать.', response.status);
    }
    throw mapped;
  }
}

// --- public API -------------------------------------------------------------

export async function apiGet<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return readJson<T>(await send('GET', path, undefined, options));
}

export async function apiPost<T>(path: string, body: unknown = {}, options: RequestOptions = {}): Promise<T> {
  return readJson<T>(await send('POST', path, body, options));
}

/** Downloads a file-like response (diagnostics) and returns it with a suggested file name. */
export async function apiDownload(
  path: string,
  fallbackName: string,
  options: RequestOptions = {},
): Promise<{ blob: Blob; filename: string }> {
  const response = await send('GET', path, undefined, options);
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  let filename = fallbackName;
  if (match?.[1]) {
    try {
      filename = decodeURIComponent(match[1]);
    } catch {
      filename = match[1];
    }
  }
  try {
    return { blob: await response.blob(), filename: filename.replace(/[\\/:*?"<>|]/g, '_') };
  } catch (error) {
    throw transportFailure(error);
  }
}

/** Any thrown value as an ApiFailure (unknown errors count as a lost connection). */
export function toFailure(error: unknown): ApiFailure {
  if (error instanceof ApiFailure) return error;
  return new ApiFailure('network', NO_CONNECTION);
}
