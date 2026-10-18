import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  encryptPayload,
  generateVapidKeys,
  isPushEndpointAllowed,
  isValidVapidKeys,
  type PushFetch,
  sendPush,
  vapidAuthorization,
} from '../src/notify/webpush.ts';

/** The device's side of RFC 8291: what a browser does with the body it receives. */
function decrypt(body: Buffer, deviceKeys: ReturnType<typeof createECDH>, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const serverPublic = body.subarray(21, 21 + idLength);
  const shared = deviceKeys.computeSecret(serverPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), deviceKeys.getPublicKey(), serverPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const encrypted = body.subarray(21 + idLength);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
  const plain = Buffer.concat([
    decipher.update(encrypted.subarray(0, encrypted.length - 16)),
    decipher.final(),
  ]);
  expect(plain[plain.length - 1]).toBe(2);
  return plain.subarray(0, plain.length - 1).toString('utf8');
}

describe('Web Push encryption (RFC 8291)', () => {
  it('reproduces the example of the RFC byte for byte', () => {
    const server = createECDH('prime256v1');
    server.setPrivateKey(Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'));
    const body = encryptPayload(Buffer.from('When I grow up, I want to be a watermelon'), {
      userPublicKey: Buffer.from(
        'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        'base64url',
      ),
      authSecret: Buffer.from('BTBZMqHH6r4Tts7J_aSIgg', 'base64url'),
      serverKeys: server,
      salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
    });
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('a fresh message is readable only with the device key', () => {
    const device = createECDH('prime256v1');
    device.generateKeys();
    const auth = Buffer.from('0123456789abcdef');
    const body = encryptPayload(Buffer.from('Привет, это проверка'), {
      userPublicKey: device.getPublicKey(),
      authSecret: auth,
    });
    expect(decrypt(body, device, auth)).toBe('Привет, это проверка');
    const stranger = createECDH('prime256v1');
    stranger.generateKeys();
    expect(() => decrypt(body, stranger, auth)).toThrow();
  });

  it('refuses a payload that does not fit in one record and a malformed device key', () => {
    const device = createECDH('prime256v1');
    device.generateKeys();
    const auth = Buffer.alloc(16);
    expect(() =>
      encryptPayload(Buffer.alloc(5000), { userPublicKey: device.getPublicKey(), authSecret: auth }),
    ).toThrow();
    expect(() =>
      encryptPayload(Buffer.from('x'), { userPublicKey: Buffer.alloc(65), authSecret: auth }),
    ).toThrow();
    expect(() =>
      encryptPayload(Buffer.from('x'), { userPublicKey: device.getPublicKey(), authSecret: Buffer.alloc(3) }),
    ).toThrow();
  });
});

describe('VAPID', () => {
  it('signs a token the public key verifies, for the push service of the subscription', () => {
    const keys = generateVapidKeys();
    expect(isValidVapidKeys(keys)).toBe(true);
    expect(isValidVapidKeys({ ...keys, privateKey: generateVapidKeys().privateKey })).toBe(false);
    const header = vapidAuthorization(
      'https://fcm.googleapis.com/fcm/send/abc',
      keys,
      'mailto:a@example.org',
      1_000_000,
    );
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, head, claims, signature, k] = match as RegExpExecArray;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(Buffer.from(claims as string, 'base64url').toString())).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: 1_000_000 + 12 * 3600,
      sub: 'mailto:a@example.org',
    });
    const publicKey = Buffer.from(keys.publicKey, 'base64url');
    const key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: publicKey.subarray(1, 33).toString('base64url'),
        y: publicKey.subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${head}.${claims}`),
        { key, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature as string, 'base64url'),
      ),
    ).toBe(true);
  });
});

describe('push endpoints', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/x',
    'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://web.push.apple.com/x',
    'https://wns2-par02p.notify.windows.com/w/?token=x',
  ])('accepts the push service %s', (url) => expect(isPushEndpointAllowed(url)).toBe(true));

  it.each([
    'http://fcm.googleapis.com/x',
    'https://127.0.0.1/x',
    'https://localhost:8096/x',
    'https://192.168.1.139/x',
    'https://evil.example.com/x',
    'https://fcm.googleapis.com.evil.com/x',
    'https://fcm.googleapis.com:8443/x',
    'https://user:pw@fcm.googleapis.com/x',
    'not a url',
    'ftp://fcm.googleapis.com/x',
  ])('refuses %s: the server must not be made to call other addresses', (url) =>
    expect(isPushEndpointAllowed(url)).toBe(false),
  );
});

describe('sendPush', () => {
  const device = createECDH('prime256v1');
  device.generateKeys();
  const auth = Buffer.from('fedcba9876543210');
  const target = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    p256dh: device.getPublicKey().toString('base64url'),
    auth: auth.toString('base64url'),
  };
  const options = {
    keys: generateVapidKeys(),
    subject: 'https://server-home.example.ts.net',
    ttlSec: 60,
    urgency: 'high' as const,
    topic: 'chat-1',
    nowSec: 1_700_000_000,
  };

  it('posts the encrypted message with the headers the push service needs', async () => {
    let seen: Parameters<PushFetch> | undefined;
    const fetchLike: PushFetch = async (url, init) => {
      seen = [url, init];
      return { status: 201 };
    };
    expect(await sendPush(target, { title: 'Мама', body: 'Новое сообщение' }, options, fetchLike)).toBe(
      'sent',
    );
    const [url, init] = seen as Parameters<PushFetch>;
    expect(url).toBe(target.endpoint);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Encoding': 'aes128gcm',
      TTL: '60',
      Urgency: 'high',
      Topic: 'chat-1',
    });
    expect(init.headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);
    expect(JSON.parse(decrypt(init.body, device, auth))).toEqual({ title: 'Мама', body: 'Новое сообщение' });
  });

  it('tells «gone» for 404/410 and «failed» for other errors, a refused endpoint and a network error', async () => {
    const status =
      (code: number): PushFetch =>
      async () => ({ status: code });
    expect(await sendPush(target, {}, options, status(410))).toBe('gone');
    expect(await sendPush(target, {}, options, status(404))).toBe('gone');
    expect(await sendPush(target, {}, options, status(429))).toBe('failed');
    expect(await sendPush(target, {}, options, status(500))).toBe('failed');
    expect(
      await sendPush(target, {}, options, async () => {
        throw new Error('offline');
      }),
    ).toBe('failed');
    let called = false;
    expect(
      await sendPush({ ...target, endpoint: 'https://127.0.0.1/x' }, {}, options, async () => {
        called = true;
        return { status: 201 };
      }),
    ).toBe('failed');
    expect(called).toBe(false);
  });
});
