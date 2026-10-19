/**
 * The local language model listens only on this PC's loopback address, but any program (or web page
 * open in a browser here) can reach a loopback port. So llama-server is started with an access key: a
 * random value made once, kept in the portal's data folder (never in Git), read by the supervisor, which
 * hands the file to llama-server, and by the portal, which sends it as a bearer token with every request.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const KEY_RE = /^[0-9a-f]{64}$/;

export function llamaKeyFile(dataDir: string): string {
  return path.join(dataDir, 'llama-api.key');
}

/** The saved key, or null when there is none (the model was never started by the supervisor). */
export function readLlamaKey(file: string): string | null {
  try {
    const key = readFileSync(file, 'utf8').trim();
    return KEY_RE.test(key) ? key : null;
  } catch {
    return null;
  }
}

/** The supervisor's side: makes the key once and returns the file name. */
export function ensureLlamaKeyFile(dataDir: string): string {
  const file = llamaKeyFile(dataDir);
  if (readLlamaKey(file) !== null) return file;
  mkdirSync(dataDir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return file;
}

/** Headers for a request to the model: the key when there is one. */
export function llamaHeaders(keyFile: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = keyFile ? readLlamaKey(keyFile) : null;
  if (key !== null) headers.authorization = `Bearer ${key}`;
  return headers;
}
