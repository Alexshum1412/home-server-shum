import { createHash, randomBytes, randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

/** Random secret token (default 256 bits), base64url without padding. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
