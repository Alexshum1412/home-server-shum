import { describe, expect, it } from 'vitest';
import { KIND, sanitizeReport } from '../src/admin/sanitize.ts';

const CONTEXT = {
  names: ['mama', 'Мама', 'sasha-canary', 'Саша Иванов'],
  hosts: ['SERVER-HOME', 'family.example-home.org'],
};

/** Every one of these must be gone from the output, whatever form it was written in. */
const CANARIES = [
  'hunter2-CANARY',
  'CanaryPass123',
  'abcdefghijklmnop1234',
  'SESSIONCANARY123456',
  'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.c2lnbmF0dXJlLWNhbmFyeQ',
  'mama@example.org',
  'C:\\FamilyData\\Files\\users\\mama\\Notes\\secret.txt',
  'FamilyData',
  'users\\papa',
  'Alex-Canary',
  '192.168.1.57',
  '100.101.102.103',
  '8.8.4.4',
  'fd7a:115c:a1e0::1234',
  'fe80::abcd',
  'server-home.tailabc123.ts.net',
  'SERVER-HOME',
  'family.example-home.org',
  'sasha-canary',
  'Саша Иванов',
  'секретное сообщение',
  'a3f5c9d1e7b24680a3f5c9d1e7b24680a3f5c9d1',
];

const REPORT = [
  'start password=hunter2-CANARY',
  '{"user":"x","password":"CanaryPass123","ok":true}',
  'Authorization: Bearer abcdefghijklmnop1234',
  'Cookie: fs_session=SESSIONCANARY123456; theme=light',
  'github token: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.c2lnbmF0dXJlLWNhbmFyeQ end',
  'owner mama@example.org wrote',
  'file C:\\FamilyData\\Files\\users\\mama\\Notes\\secret.txt failed',
  'escaped "C:\\\\FamilyData\\\\Photos\\\\users\\\\papa\\\\a.jpg" in json',
  'relative users\\papa\\Documents\\x.pdf',
  'windows C:\\Users\\Alex-Canary\\AppData\\Local\\x',
  'lan 192.168.1.57 and tailnet 100.101.102.103 and public 8.8.4.4',
  'v6 fd7a:115c:a1e0::1234 and fe80::abcd',
  'host server-home.tailabc123.ts.net / SERVER-HOME / family.example-home.org',
  'login sasha-canary by Саша Иванов, mama and Мама',
  '{"id":"1","text":"секретное сообщение","at":"now"}',
  'commit a3f5c9d1e7b24680a3f5c9d1e7b24680a3f5c9d1 built',
].join('\n');

describe('the diagnostic report sanitiser', () => {
  it('leaves none of the canary secrets, names, addresses or texts in the output', () => {
    const { text } = sanitizeReport(REPORT, CONTEXT);
    for (const canary of CANARIES) expect(text, canary).not.toContain(canary);
  });

  it('says what it removed, by kind and number', () => {
    const { removed } = sanitizeReport(REPORT, CONTEXT);
    const byKind = Object.fromEntries(removed.map((entry) => [entry.what, entry.count]));
    for (const kind of Object.values(KIND)) expect(byKind[kind], kind).toBeGreaterThan(0);
  });

  it('keeps what a helper needs: states, numbers, versions, loopback, times, ports and ordinary words', () => {
    const plain = [
      'Портал: Работает, перезапусков после сбоя: 2',
      'tests passed: 12, tokens: 3, session: true',
      'Windows 10.0.19045.6456 build, Node v24.11.0, version 0.7.0-dev',
      'listening on 127.0.0.1:8070 and 0.0.0.0, ::1',
      'at 10:25:33 the disk C:\\ had 120 ГБ free',
      'C:\\FamilyServer\\data\\dashboard\\logs\\supervisor.log',
      'inside the considered residence',
    ].join('\n');
    const { text, removed } = sanitizeReport(plain, CONTEXT);
    expect(text).toBe(plain);
    expect(removed).toEqual([]);
  });

  it('keeps JSON valid: the markers stay inside the quotes', () => {
    const json = JSON.stringify({
      config: {
        dataDir: 'C:\\FamilyData\\Files',
        publicUrl: 'https://server-home.tailabc123.ts.net',
        port: 8070,
      },
      note: { text: 'секретное сообщение', body: 'ещё одно', ok: true },
      auth: { password: 'CanaryPass123', token: 'abcdefghijklmnop1234', count: 4 },
      ip: '192.168.1.57',
    });
    const { text } = sanitizeReport(json, CONTEXT);
    const parsed = JSON.parse(text) as {
      config: { port: number };
      note: { ok: boolean };
      auth: { count: number };
    };
    expect(parsed.config.port).toBe(8070);
    expect(parsed.note.ok).toBe(true);
    expect(parsed.auth.count).toBe(4);
    expect(text).not.toContain('CanaryPass123');
    expect(text).not.toContain('ещё одно');
  });

  it('does not take a name that is part of another word, and ignores very short names', () => {
    const { text } = sanitizeReport('мамонт и Мама, ma и mama2', { names: ['Мама', 'ma'] });
    expect(text).toContain('мамонт');
    expect(text).toContain('mama2');
    expect(text).not.toMatch(/Мама/);
  });

  it('is fast on very long lines of hyphens and letters', () => {
    const started = Date.now();
    sanitizeReport(`${'abc-'.repeat(4000)}x`, CONTEXT);
    sanitizeReport(`${'a.'.repeat(4000)}=1`, CONTEXT);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
