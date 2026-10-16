import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuditLog } from '../src/audit/log.ts';
import { ADMIN, addUser, createFakeClock, createTestApp, login, makeTempDir, removeDir } from './helpers.ts';

let dir: string;

beforeEach(async () => {
  dir = await makeTempDir('fd-audit-');
});

afterEach(async () => {
  await removeDir(dir);
});

describe('audit log', () => {
  it('appends JSON lines and reads the latest entries newest first', async () => {
    const clock = createFakeClock();
    const audit = createAuditLog(dir, { clock });
    for (let i = 0; i < 5; i += 1) {
      clock.advance(1000);
      await audit.write({ action: 'login.success', actor: `user${i}`, ip: '127.0.0.1' });
    }
    const latest = await audit.readLatest(3);
    expect(latest.map((e) => e.actor)).toEqual(['user4', 'user3', 'user2']);
    expect(latest[0]).toEqual({
      time: '2026-10-16T10:00:05.000Z',
      action: 'login.success',
      actor: 'user4',
      ip: '127.0.0.1',
      detail: null,
    });
    const lines = (await readFile(path.join(dir, 'audit.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('serialises concurrent writes without tearing lines', async () => {
    const audit = createAuditLog(dir, { clock: createFakeClock() });
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        audit.write({ action: 'logout', actor: `u${i}`, ip: null, detail: 'кириллица и "кавычки"' }),
      ),
    );
    const entries = await audit.readLatest(500);
    expect(entries).toHaveLength(50);
    expect(new Set(entries.map((e) => e.actor)).size).toBe(50);
  });

  it('rotates at the size limit keeping three old files, and reads across them', async () => {
    const audit = createAuditLog(dir, { clock: createFakeClock(), maxBytes: 400 });
    for (let i = 0; i < 40; i += 1) {
      await audit.write({ action: 'services.refresh', actor: `admin${i}`, ip: '127.0.0.1' });
    }
    const files = (await readdir(dir)).sort();
    expect(files).toEqual(['audit.1.jsonl', 'audit.2.jsonl', 'audit.3.jsonl', 'audit.jsonl']);
    const entries = await audit.readLatest(500);
    expect(entries[0]?.actor).toBe('admin39');
    const numbers = entries.map((e) => Number(e.actor?.slice(5)));
    expect(numbers).toEqual([...numbers].sort((a, b) => b - a));
    expect(entries.length).toBeLessThan(40);
  });

  it('strips control characters and bounds field length', async () => {
    const audit = createAuditLog(dir, { clock: createFakeClock() });
    await audit.write({ action: 'login.failure', actor: 'a\nb', ip: '1.2.3.4', detail: 'x'.repeat(1000) });
    const [entry] = await audit.readLatest(1);
    expect(entry?.actor).toBe('a b');
    expect(entry?.detail).toHaveLength(200);
  });

  it('caps readLatest at 500 and skips broken lines', async () => {
    const audit = createAuditLog(dir, { clock: createFakeClock() });
    await audit.write({ action: 'logout', actor: 'one', ip: null });
    const { appendFile } = await import('node:fs/promises');
    await appendFile(path.join(dir, 'audit.jsonl'), 'not json\n{"half":\n');
    await audit.write({ action: 'logout', actor: 'two', ip: null });
    const entries = await audit.readLatest(10_000);
    expect(entries.map((e) => e.actor)).toEqual(['two', 'one']);
  });

  it('counts only valid entries: broken lines never hide newer entries behind older files', async () => {
    const entry = (actor: string, time: string) =>
      `${JSON.stringify({ time, action: 'logout', actor, ip: null, detail: null })}\n`;
    await writeFile(path.join(dir, 'audit.1.jsonl'), entry('rotated-old', '2026-10-16T08:00:00.000Z'));
    await writeFile(
      path.join(dir, 'audit.jsonl'),
      `${entry('a', '2026-10-16T09:00:00.000Z')}${entry('b', '2026-10-16T09:00:01.000Z')}junk1\n{"half":\n["x"]\n`,
    );
    const audit = createAuditLog(dir, { clock: createFakeClock() });
    expect((await audit.readLatest(2)).map((e) => e.actor)).toEqual(['b', 'a']);
    expect((await audit.readLatest(3)).map((e) => e.actor)).toEqual(['b', 'a', 'rotated-old']);
    expect((await audit.readLatest(1)).map((e) => e.actor)).toEqual(['b']);
  });

  it('starts a new line after a torn last line, so the next entry is not lost', async () => {
    const file = path.join(dir, 'audit.jsonl');
    const old = JSON.stringify({
      time: '2026-10-16T09:00:00.000Z',
      action: 'logout',
      actor: 'old',
      ip: null,
      detail: null,
    });
    // The previous run crashed in the middle of an append.
    await writeFile(file, `${old}\n{"time":"2026-10-16T09:00:01.000Z","action":"lo`);
    const audit = createAuditLog(dir, { clock: createFakeClock() });
    await audit.write({ action: 'logout', actor: 'new', ip: null });
    await audit.write({ action: 'logout', actor: 'newer', ip: null });
    expect((await audit.readLatest(10)).map((e) => e.actor)).toEqual(['newer', 'new', 'old']);
    const lines = (await readFile(file, 'utf8')).split('\n');
    expect(lines).toHaveLength(5); // old, torn, new, newer, '' after the final newline
    expect(lines.filter((line) => line === '')).toHaveLength(1);

    // A clean file gets no extra blank line on the next start.
    const restarted = createAuditLog(dir, { clock: createFakeClock() });
    await restarted.write({ action: 'logout', actor: 'after-restart', ip: null });
    const again = (await readFile(file, 'utf8')).split('\n');
    expect(again).toHaveLength(6);
    expect(again.filter((line) => line === '')).toHaveLength(1);
    expect((await restarted.readLatest(1))[0]?.actor).toBe('after-restart');
  });

  it('never records passwords, tokens or cookies from real requests', async () => {
    const t = await createTestApp({ dataDir: dir });
    try {
      await addUser(dir, t.clock, ADMIN);
      await login(t.app, ADMIN.username, 'wrong-secret-password');
      await login(t.app, 'secret-password-in-username-field!', 'wrong-secret-password');
      const { cookie } = await login(t.app, ADMIN.username, ADMIN.password);
      await t.app.inject({
        method: 'POST',
        url: '/api/logout',
        headers: { cookie: cookie ?? '' },
        payload: {},
      });
      const raw = await readFile(path.join(dir, 'audit.jsonl'), 'utf8');
      expect(raw).not.toContain('wrong-secret-password');
      expect(raw).not.toContain(ADMIN.password);
      expect(raw).not.toContain('secret-password-in-username-field');
      expect(raw).not.toContain(cookie?.split('=')[1] ?? 'no-cookie');
      expect(raw).not.toContain('scrypt$');
      const actions = raw
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).action);
      expect(actions).toEqual(['login.failure', 'login.failure', 'login.success', 'logout']);
    } finally {
      await t.app.close();
    }
  });
});
