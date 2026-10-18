/**
 * Web Push (RFC 8030 delivery, RFC 8291 message encryption with aes128gcm, RFC 8292 VAPID) with
 * nothing but node:crypto — no extra package to keep up to date.
 *
 * What the push service of the browser vendor (Google, Mozilla, Apple, Microsoft) sees: that the
 * portal sent something of N bytes to a device, and when. The content is encrypted so that only the
 * device can read it.
 */
import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  createPublicKey,
  type ECDH,
  hkdfSync,
  randomBytes,
  sign,
} from 'node:crypto';

const RECORD_SIZE = 4096;
/** Room left in one record for the padding delimiter and the 16-byte GCM tag. */
const MAX_PLAINTEXT = RECORD_SIZE - 17;

export interface VapidKeys {
  /** Uncompressed P-256 public key, base64url (what the browser's subscribe() takes). */
  publicKey: string;
  /** Raw 32-byte private key, base64url. A secret. */
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url'),
  };
}

/** The push services that real browsers use. A subscription naming any other server is refused. */
const PUSH_HOST_SUFFIXES = [
  '.googleapis.com', // Chrome, Edge, Android (FCM)
  '.mozilla.com', // Firefox
  '.push.apple.com', // Safari, iOS
  '.notify.windows.com', // Edge on Windows (WNS)
];

/** https only, and only a known push service: the server must not be made to call arbitrary addresses. */
export function isPushEndpointAllowed(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (url.port !== '' && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length));
}

export interface EncryptionInputs {
  /** Browser's P-256 public key (65 bytes) and auth secret (16 bytes) from the subscription. */
  userPublicKey: Buffer;
  authSecret: Buffer;
  /** Fixed values exist only for the test against the RFC's example. */
  serverKeys?: ECDH;
  salt?: Buffer;
}

/** RFC 8291 §3.4 + RFC 8188: one aes128gcm record with a 21+65 byte header. */
export function encryptPayload(plaintext: Buffer, input: EncryptionInputs): Buffer {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error('Сообщение для уведомления слишком длинное.');
  if (input.userPublicKey.length !== 65 || input.userPublicKey[0] !== 4) {
    throw new Error('Некорректный открытый ключ устройства.');
  }
  if (input.authSecret.length !== 16) throw new Error('Некорректный секрет устройства.');
  const server = input.serverKeys ?? createECDH('prime256v1');
  if (!input.serverKeys) server.generateKeys();
  const serverPublic = server.getPublicKey();
  const shared = server.computeSecret(input.userPublicKey);
  const salt = input.salt ?? randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), input.userPublicKey, serverPublic]);
  const ikm = hkdf(input.authSecret, shared, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marks the last (and only) record.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(serverPublic.length, 20);
  return Buffer.concat([header, serverPublic, body, cipher.getAuthTag()]);
}

function jwk(keys: VapidKeys) {
  const publicKey = Buffer.from(keys.publicKey, 'base64url');
  return {
    kty: 'EC',
    crv: 'P-256',
    x: publicKey.subarray(1, 33).toString('base64url'),
    y: publicKey.subarray(33, 65).toString('base64url'),
    d: keys.privateKey,
  };
}

/** RFC 8292 header value: "vapid t=<JWT>, k=<public key>". */
export function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  nowSec: number,
  ttlSec = 12 * 3600,
): string {
  const aud = new URL(endpoint).origin;
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({ aud, exp: nowSec + ttlSec, sub: subject })}`;
  const key = createPrivateKey({ key: jwk(keys), format: 'jwk' });
  const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${signature.toString('base64url')}, k=${keys.publicKey}`;
}

/** Whether a stored public key really is a point on the curve (guards against a corrupted file). */
export function isValidVapidKeys(keys: VapidKeys): boolean {
  try {
    const publicKey = Buffer.from(keys.publicKey, 'base64url');
    if (publicKey.length !== 65 || publicKey[0] !== 4) return false;
    const key = createPrivateKey({ key: jwk(keys), format: 'jwk' });
    const derived = createPublicKey(key).export({ format: 'jwk' });
    return derived.x === publicKey.subarray(1, 33).toString('base64url');
  } catch {
    return false;
  }
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushOptions {
  keys: VapidKeys;
  /** "mailto:" or https address of whoever runs the server; the push service may contact it. */
  subject: string;
  ttlSec: number;
  urgency: 'very-low' | 'low' | 'normal' | 'high';
  topic?: string;
  nowSec: number;
}

export type PushFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: Buffer; signal: AbortSignal },
) => Promise<{ status: number }>;

export type PushResult = 'sent' | 'gone' | 'failed';

/** Encrypts and posts one notification. `gone` — the device unsubscribed: forget the subscription. */
export async function sendPush(
  target: PushTarget,
  payload: unknown,
  options: PushOptions,
  fetchLike: PushFetch,
  timeoutMs = 10_000,
): Promise<PushResult> {
  if (!isPushEndpointAllowed(target.endpoint)) return 'failed';
  let body: Buffer;
  try {
    body = encryptPayload(Buffer.from(JSON.stringify(payload)), {
      userPublicKey: Buffer.from(target.p256dh, 'base64url'),
      authSecret: Buffer.from(target.auth, 'base64url'),
    });
  } catch {
    return 'failed';
  }
  const headers: Record<string, string> = {
    Authorization: vapidAuthorization(target.endpoint, options.keys, options.subject, options.nowSec),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(body.length),
    TTL: String(options.ttlSec),
    Urgency: options.urgency,
  };
  if (options.topic) headers.Topic = options.topic;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchLike(target.endpoint, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    if (response.status === 404 || response.status === 410) return 'gone';
    return response.status >= 200 && response.status < 300 ? 'sent' : 'failed';
  } catch {
    return 'failed';
  } finally {
    clearTimeout(timer);
  }
}
