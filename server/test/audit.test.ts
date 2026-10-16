import { readdir, readFile } from 'node:fs/promises';
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
