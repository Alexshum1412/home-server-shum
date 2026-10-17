import { randomBytes, randomInt, type ScryptOptions, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
/** N=2^15, r=8 needs 32 MiB; the Node default limit (32 MiB) is too tight. */
const MAX_MEM = 128 * 1024 * 1024;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 256;

/** A generated password works only for the first sign-in, and only for this long. */
export const TEMPORARY_PASSWORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** No look-alike characters (0/O, 1/l/I), so the password can be typed from a phone screen. */
const GENERATED_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GENERATED_GROUPS = 4;
const GENERATED_GROUP_LENGTH = 5;

/**
 * Random password from the OS CSPRNG: 4 groups of 5 characters separated by "-",
 * 20 × log2(56) ≈ 116 bits. Never stored anywhere except as a scrypt hash.
 */
export function generatePassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < GENERATED_GROUPS; g += 1) {
    let group = '';
    for (let i = 0; i < GENERATED_GROUP_LENGTH; i += 1) {
      group += GENERATED_ALPHABET[randomInt(GENERATED_ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join('-');
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** Unicode-normalise so the same visible password always hashes the same way. */
function normalise(password: string): string {
  return password.normalize('NFC');
}

/** Returns `scrypt$32768$8$1$<saltB64>$<hashB64>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(normalise(password), salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEM,
  });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), key.toString('base64')].join('$');
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, n, r, p, salt, hash] = parts;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  // Bounds stop a tampered users.json from making verification arbitrarily expensive.
  const validN = Number.isInteger(N) && N >= 1024 && N <= 1_048_576 && (N & (N - 1)) === 0;
  if (!validN || !Number.isInteger(R) || R < 1 || R > 32 || !Number.isInteger(P) || P < 1 || P > 16)
    return null;
  const saltBuf = Buffer.from(salt ?? '', 'base64');
  const hashBuf = Buffer.from(hash ?? '', 'base64');
  if (saltBuf.length < 8 || hashBuf.length < 16 || hashBuf.length > 128) return null;
  return { N, r: R, p: P, salt: saltBuf, hash: hashBuf };
}

/** Constant-time comparison; malformed hashes simply fail. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  try {
    const key = await scryptAsync(normalise(password), parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAX_MEM * 4,
    });
    return timingSafeEqual(key, parsed.hash);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Runs a full scrypt verification against a throw-away hash so that a login for an
 * unknown user takes as long as one for an existing user.
 */
export async function dummyVerify(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(18).toString('base64'));
  await verifyPassword(password, await dummyHash);
}

/** Password policy for the CLI; returns a Russian error or null. */
export function checkPasswordPolicy(password: string, username: string): string | null {
  if (Array.from(password).length < PASSWORD_MIN_LENGTH) {
    return `Пароль слишком короткий: нужно не меньше ${PASSWORD_MIN_LENGTH} символов.`;
  }
  // Same unit (UTF-16 length) as the login body validation, so every accepted password can sign in.
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Пароль слишком длинный: не больше ${PASSWORD_MAX_LENGTH} символов.`;
  }
  if (password.trim().toLowerCase() === username.toLowerCase())
    return 'Пароль не должен совпадать с логином.';
  return null;
}
