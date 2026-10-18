/**
 * Notifications on this device (Web Push). The browser creates a subscription at its own push
 * service; the portal keeps it and uses it when the page is closed. Nothing is sent without the
 * person's permission, and it can be switched off at any time.
 */

import type { NotificationsResponse, PushSubscriptionRequest } from '../../../shared/api.ts';
import { apiPost } from '../api.ts';

export interface PushSupport {
  ok: boolean;
  /** Russian explanation when `ok` is false: what to do. */
  reason: string | null;
}

function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

export function isInstalledApp(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) {
    return {
      ok: false,
      reason:
        'Уведомления работают только по защищённому адресу (https://…) — откройте портал по адресу из раздела «Подключение».',
    };
  }
  if (isIos() && !isInstalledApp()) {
    return {
      ok: false,
      reason:
        'На iPhone уведомления работают только у приложения на экране «Домой»: в Safari нажмите «Поделиться» → «На экран “Домой”», откройте портал оттуда и вернитесь сюда.',
    };
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { ok: false, reason: 'Этот браузер не умеет получать уведомления, когда портал закрыт.' };
  }
  return { ok: true, reason: null };
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Браузер';
  const system = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iPhone'
        : /Mac OS/.test(ua)
          ? 'Mac'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return system ? `${browser} · ${system}` : browser;
}

export async function thisDeviceSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    return (await registration?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

export type EnableResult = { ok: true; state: NotificationsResponse } | { ok: false; reason: string };

export async function enablePush(publicKey: string): Promise<EnableResult> {
  const support = pushSupport();
  if (!support.ok) return { ok: false, reason: support.reason ?? 'Уведомления недоступны.' };
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return {
      ok: false,
      reason:
        permission === 'denied'
          ? 'Уведомления запрещены для этого сайта. Разрешите их в настройках браузера (значок замка рядом с адресом) и повторите.'
          : 'Вы не разрешили уведомления.',
    };
  }
  let registration = await navigator.serviceWorker.getRegistration();
  if (!registration) {
    return { ok: false, reason: 'Приложение ещё не готово к уведомлениям. Обновите страницу и повторите.' };
  }
  registration = await navigator.serviceWorker.ready;
  try {
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(publicKey),
      }));
    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
      return { ok: false, reason: 'Браузер не выдал данные для уведомлений. Попробуйте другой браузер.' };
    }
    const body: PushSubscriptionRequest = {
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      label: deviceLabel(),
    };
    return { ok: true, state: await apiPost<NotificationsResponse>('/api/notifications/subscribe', body) };
  } catch (error) {
    const message = (error as Error).message;
    return {
      ok: false,
      reason: message ? `Не удалось включить уведомления: ${message}` : 'Не удалось включить уведомления.',
    };
  }
}

export async function disablePush(): Promise<NotificationsResponse | null> {
  const subscription = await thisDeviceSubscription();
  if (!subscription) return null;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe().catch(() => false);
  return apiPost<NotificationsResponse>('/api/notifications/unsubscribe', { endpoint });
}
