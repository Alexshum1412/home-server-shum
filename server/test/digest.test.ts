import { afterEach, describe, expect, it } from 'vitest';
import type { StoredUser } from '../src/auth/users.ts';
import { createDigest, isChatId, isTime } from '../src/digest/digest.ts';
import { weatherWord } from '../src/digest/external.ts';
import type { DigestLlm } from '../src/digest/llm.ts';
import { createFakeClock, makeTempDir, removeDir } from './helpers.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

const person = (username: string, role: 'admin' | 'family' = 'family'): StoredUser =>
  ({
    id: `id-${username}`,
    username,
    displayName: username === 'mama' ? 'Мама' : 'Папа',
    role,
  }) as StoredUser;

async function setup(llm?: Partial<DigestLlm>) {
  const dir = await makeTempDir('fd-digest-');
  cleanup.push(() => removeDir(dir));
  const clock = createFakeClock('2026-10-20T04:00:00.000Z'); // 07:00 in Moscow
  const told: Array<{ users: readonly string[]; title: string }> = [];
  const asked: string[] = [];
  const stub = {
    bigAvailable: () => false,
    quick: async (name: string, lines: string[]) => {
      asked.push(`${name}:${lines.length}`);
      return llm?.quick ? llm.quick(name, lines) : null;
    },
    session: async (
      work: (
        w: (n: string, l: string[]) => Promise<{ text: string | null; model: 'big' | 'quick' }>,
      ) => Promise<unknown>,
    ) => work(async (name, lines) => ({ text: await stub.quick(name, lines), model: 'quick' as const })),
  } as unknown as DigestLlm;
  const digest = createDigest({
    dataDir: dir,
    clock,
    users: async () => [person('mama'), person('papa', 'admin')],
    sources: {
      tasks: async (u) => (u.username === 'mama' ? ['Сегодня: «Позвонить бабушке»'] : []),
      events: async () => [],
      deadlines: async () => [],
      downloads: async () => [],
      server: async () => ['Сервер: всё в порядке'],
    },
    llm: stub,
    notify: async (input) => void told.push({ users: input.users, title: input.title }),
    telegramTokenFile: `${dir}\\no-token`,
    fetch: (async () => new Response('{}', { status: 500 })) as typeof fetch,
  });
  return { digest, clock, told, asked, dir };
}

describe('morning digest', () => {
  it('validates the time and the Telegram number', () => {
    expect(isTime('07:30')).toBe(true);
    expect(isTime('7:30')).toBe(false);
    expect(isTime('24:00')).toBe(false);
    expect(isChatId('')).toBe(true);
    expect(isChatId('-100123456')).toBe(true);
    expect(isChatId('abc')).toBe(false);
    expect(weatherWord(61)).toBe('дождь');
  });

  it('without a model it is written from a template with only that person’s facts, and once in five minutes', async () => {
    const { digest, told } = await setup();
    const result = await digest.runNow(person('mama'));
    expect(result).not.toBe('too_soon');
    if (result === 'too_soon') return;
    expect(result.how).toBe('template');
    expect(result.text).toContain('Доброе утро, Мама!');
    expect(result.text).toContain('Позвонить бабушке');
    expect(result.text).not.toContain('Сервер: всё в порядке'); // administrators only
    expect(told).toHaveLength(1);
    expect(await digest.runNow(person('mama'))).toBe('too_soon');
    const state = await digest.state('mama');
    expect(state.mine.last?.how).toBe('template');
  });

  it('the model’s text is used when it answers, and the administrator also gets the server lines', async () => {
    const { digest } = await setup({ quick: async (name) => `Привет, ${name}! Хорошего дня.` });
    const admin = await digest.runNow(person('papa', 'admin'));
    expect(admin).toMatchObject({ how: 'model' });
    expect(typeof admin === 'object' ? admin.text : '').toMatch(/^Привет, Папа! Хорошего дня\.\n\n🖥 Сервер\n• Сервер: /);
  });

  it('goes out once a day at the set time, for those who want it, and a person can switch it off', async () => {
    const { digest, clock, told } = await setup();
    await digest.tick(); // 07:00, before 07:30
    expect(told).toHaveLength(0);
    clock.advance(40 * 60_000); // 07:40
    await digest.tick();
    expect(told.map((n) => n.users[0]).sort()).toEqual(['id-mama', 'id-papa']);
    await digest.tick();
    expect(told).toHaveLength(2); // not again today
    clock.advance(24 * 3_600_000);
    await digest.setMine('mama', { enabled: false });
    await digest.tick();
    expect(told).toHaveLength(3);
    expect(told[2]?.users[0]).toBe('id-papa');
  });
});
