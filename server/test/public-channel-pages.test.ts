import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { publicRouteAllowed } from '../src/lib/channel.ts';

/*
 * Every address the web client calls is either open on the public address or closed on purpose. A new call
 * that is neither would fail there without anyone noticing.
 */
const CLOSED_ON_PURPOSE = [
  '/api/admin',
  '/api/downloads/',
  '/api/print/jobs',
  '/api/services/refresh',
  '/api/system/history',
  '/api/catalog/stream',
  '/api/media/file',
];

const WEB = path.join(import.meta.dirname, '..', '..', 'web', 'src');

function sources(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) files.push(...sources(full));
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) files.push(full);
  }
  return files;
}

describe('the pages of the portal and the public address', () => {
  it('has no client call that is closed by accident', () => {
    const calls = new Set<string>();
    for (const file of sources(WEB)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/['`"](\/api\/[A-Za-z0-9_/.-]+)/g)) {
        calls.add((match[1] ?? '').replace(/\/+$/, ''));
      }
    }
    expect(calls.size).toBeGreaterThan(40);
    const stream = { publicAllowMediaStream: false };
    const accidental = [...calls].filter(
      (call) =>
        !publicRouteAllowed('GET', call, stream) &&
        !publicRouteAllowed('POST', call, stream) &&
        !CLOSED_ON_PURPOSE.some((prefix) => call === prefix || call.startsWith(prefix)),
    );
    expect(accidental).toEqual([]);
  });
});
