/**
 * Encrypted container for copies that leave the house («.fsbk»): AES-256-GCM in 1 MiB chunks, one key per
 * owner (a file outside the repository plus a printed recovery code). Every chunk is authenticated together
 * with the header, its number and an «is last» flag, so a wrong key, a damaged byte, a cut-off file, swapped
 * chunks or appended data are all refused. Nothing here sends anything anywhere.
 *
 * Layout: magic «FSBK», version, key id (4), salt (16), nonce prefix (4), chunk size (4), then chunks
 * [length (4) | last flag (1) | ciphertext | tag (16)]. The per-file key is HKDF-SHA256(key, salt).
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export class CryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptError';
  }
}

export const KEY_BYTES = 32;
export const CHUNK_BYTES = 1024 * 1024;
const MAGIC = Buffer.from('FSBK');
const VERSION = 1;
const HEADER_BYTES = 4 + 1 + 4 + 16 + 4 + 4;
const TAG_BYTES = 16;
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;

export function generateKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** Lets a wrong key be told from a damaged file; it reveals nothing useful about the key. */
export function keyId(key: Buffer): Buffer {
  const once = createHash('sha256').update(key).digest();
  return createHash('sha256').update(once).digest().subarray(0, 4);
}

// --- the key on disk and on paper -------------------------------------------------------------

const KEY_FILE_RE = /^[0-9a-f]{64}$/i;

export async function readKeyFile(file: string): Promise<Buffer> {
  let text: string;
  try {
    text = (await fsp.readFile(file, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CryptError(
        `Ключ шифрования не найден (${file}). Создайте его: scripts\\backup.cmd offsite init-key`,
      );
    }
    throw error;
  }
  if (!KEY_FILE_RE.test(text))
    throw new CryptError(`Файл ключа повреждён (${file}): ожидалось 64 шестнадцатеричных знака`);
  return Buffer.from(text, 'hex');
}

/** Creates the key file; refuses to overwrite an existing one (the old copies would become unreadable). */
export async function writeNewKeyFile(file: string, key: Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  try {
    await fsp.writeFile(file, `${key.toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CryptError(
        `Ключ уже существует (${file}). Замена ключа сделала бы прежние копии нечитаемыми.`,
      );
    }
    throw error;
  }
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    const index = B32.indexOf(char);
    if (index < 0) throw new CryptError('В коде восстановления есть недопустимые знаки');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function checksum(key: Buffer): string {
  const digest = createHash('sha256').update('fsbk-recovery-v1').update(key).digest();
  return base32(digest.subarray(0, 3)).slice(0, 4);
}

/** 14 groups of 4 letters and digits: 52 for the key and 4 as a check, so a typo is noticed. */
export function formatRecoveryCode(key: Buffer): string {
  const text = base32(key) + checksum(key);
  return (text.match(/.{1,4}/g) ?? []).join('-');
}

export function parseRecoveryCode(code: string): Buffer {
  const text = code.toUpperCase().replace(/[^A-Z2-7]/g, '');
  if (text.length !== 56)
    throw new CryptError('Код восстановления должен состоять из 56 знаков (14 групп по 4)');
  const key = unbase32(text.slice(0, 52)).subarray(0, KEY_BYTES);
  if (key.length !== KEY_BYTES) throw new CryptError('Код восстановления неверен');
  const expected = Buffer.from(checksum(key));
  const given = Buffer.from(text.slice(52));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new CryptError('В коде восстановления ошибка: проверьте буквы и цифры');
  }
  return key;
}

// --- reading exact byte counts from a stream ---------------------------------------------------

/** Reads exact numbers of bytes from an async stream of buffers. */
export class ByteReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private buffer: Buffer = Buffer.alloc(0);
  private ended = false;

  constructor(source: AsyncIterable<Buffer>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async fill(need: number): Promise<void> {
    while (this.buffer.length < need && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) this.ended = true;
      else
        this.buffer =
          this.buffer.length === 0 ? Buffer.from(next.value) : Buffer.concat([this.buffer, next.value]);
    }
  }

  /** Exactly `count` bytes; null when the stream ended before the first byte; an error in the middle. */
  async read(count: number): Promise<Buffer | null> {
    if (count === 0) return Buffer.alloc(0);
    await this.fill(count);
    if (this.buffer.length === 0 && this.ended) return null;
    if (this.buffer.length < count)
      throw new CryptError('Файл обрывается раньше времени (обрезан или не дописан)');
    const out = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return out;
  }

  /** `count` bytes in pieces of at most 1 MiB (for big file bodies). */
  async *take(count: number): AsyncGenerator<Buffer> {
    let left = count;
    while (left > 0) {
      const piece = await this.read(Math.min(left, CHUNK_BYTES));
      if (piece === null) throw new CryptError('Файл обрывается раньше времени (обрезан или не дописан)');
      left -= piece.length;
      yield piece;
    }
  }

  /** True when nothing more can be read. */
  async atEnd(): Promise<boolean> {
    await this.fill(1);
    return this.buffer.length === 0 && this.ended;
  }
}

// --- encryption and decryption ----------------------------------------------------------------

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

function u64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(value);
  return out;
}

function chunkParts(header: Buffer, noncePrefix: Buffer, counter: bigint, last: boolean) {
  const flag = Buffer.from([last ? 1 : 0]);
  return {
    flag,
    nonce: Buffer.concat([noncePrefix, u64(counter)]),
    aad: Buffer.concat([header, u64(counter), flag]),
  };
}

function subKey(key: Buffer, salt: Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new CryptError('Ключ должен быть длиной 32 байта');
  return Buffer.from(hkdfSync('sha256', key, salt, 'family-backup/v1', KEY_BYTES));
}

/** Encrypts a stream of plain buffers into the container. */
export async function* encryptStream(key: Buffer, plain: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const salt = randomBytes(16);
  const noncePrefix = randomBytes(4);
  const header = Buffer.concat([
    MAGIC,
    Buffer.from([VERSION]),
    keyId(key),
    salt,
    noncePrefix,
    u32(CHUNK_BYTES),
  ]);
  const derived = subKey(key, salt);
  yield header;
  let counter = 0n;
  let pending: Buffer = Buffer.alloc(0);
  const seal = (data: Buffer, last: boolean): Buffer => {
    const { flag, nonce, aad } = chunkParts(header, noncePrefix, counter, last);
    counter += 1n;
    const cipher = createCipheriv('aes-256-gcm', derived, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([u32(body.length), flag, body, cipher.getAuthTag()]);
  };
  for await (const piece of plain) {
    pending = pending.length === 0 ? Buffer.from(piece) : Buffer.concat([pending, piece]);
    // One chunk is always held back: the last one must carry the «last» flag.
    while (pending.length > CHUNK_BYTES) {
      yield seal(pending.subarray(0, CHUNK_BYTES), false);
      pending = pending.subarray(CHUNK_BYTES);
    }
  }
  yield seal(pending, true);
}

/** Decrypts the container; throws a CryptError for a wrong key, damage, truncation or extra data. */
export async function* decryptStream(key: Buffer, encrypted: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  const reader = new ByteReader(encrypted);
  const header = await reader.read(HEADER_BYTES);
  if (header === null || !header.subarray(0, 4).equals(MAGIC)) {
    throw new CryptError('Это не зашифрованная копия (нет заголовка FSBK)');
  }
  if (header[4] !== VERSION) throw new CryptError(`Неизвестная версия формата: ${header[4]}`);
  if (!header.subarray(5, 9).equals(keyId(key))) {
    throw new CryptError(
      'Копия зашифрована другим ключом: возьмите ключ или код восстановления, с которым её делали',
    );
  }
  const salt = header.subarray(9, 25);
  const noncePrefix = header.subarray(25, 29);
  const chunkSize = header.readUInt32BE(29);
  if (chunkSize < 1024 || chunkSize > MAX_CHUNK_BYTES) throw new CryptError('Заголовок копии повреждён');
  const derived = subKey(key, salt);
  let counter = 0n;
  for (;;) {
    const lead = await reader.read(5);
    if (lead === null) throw new CryptError('Файл обрывается раньше времени (обрезан или не дописан)');
    const length = lead.readUInt32BE(0);
    const last = lead[4] === 1;
    if (lead[4] !== 0 && lead[4] !== 1) throw new CryptError('Файл повреждён (неверный признак блока)');
    if (length > chunkSize) throw new CryptError('Файл повреждён (слишком большой блок)');
    const body = await reader.read(length + TAG_BYTES);
    if (body === null) throw new CryptError('Файл обрывается раньше времени (обрезан или не дописан)');
    const { nonce, aad } = chunkParts(header, noncePrefix, counter, last);
    counter += 1n;
    const decipher = createDecipheriv('aes-256-gcm', derived, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(body.subarray(length));
    let plain: Buffer;
    try {
      plain = Buffer.concat([decipher.update(body.subarray(0, length)), decipher.final()]);
    } catch {
      throw new CryptError('Файл повреждён или изменён: проверка подлинности не пройдена');
    }
    yield plain;
    if (last) {
      if (!(await reader.atEnd())) throw new CryptError('После конца копии есть лишние данные');
      return;
    }
  }
}
