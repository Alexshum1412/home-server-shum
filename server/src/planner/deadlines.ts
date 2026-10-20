import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { DeadlineInput, DeadlineView } from '../../../shared/extras.ts';
import { createSerialQueue, readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import type { Clock } from '../lib/time.ts';
import { daysBetween, isRealDate } from './dates.ts';
import { localMoment } from './task-dates.ts';

export class DeadlineError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'DeadlineError';
    this.status = status;
    this.code = code;
  }
}

export const MAX_DEADLINES = 2000;
export const MAX_PER_USER = 300;
const KINDS = ['document', 'warranty', 'subscription', 'service', 'other'] as const;

const storedSchema = z.object({
  id: z.string(),
  owner: z.string(),
  ownerName: z.string(),
  title: z.string(),
  kind: z.enum(KINDS),
  expires: z.string(),
  remindDays: z.array(z.number().int().min(0).max(730)),
  note: z.string(),
  shared: z.boolean(),
  /** «days before» values already told, so that each reminder is sent once. */
  told: z.array(z.number().int()).default([]),
});
type Stored = z.infer<typeof storedSchema>;
const fileSchema = z.object({ version: z.literal(1), items: z.array(storedSchema) });

export const deadlineBody = z
  .object({
    title: z.string().max(300).default(''),
    kind: z.enum(KINDS).default('other'),
    expires: z.string().max(10).default(''),
    remindDays: z.array(z.number().finite()).max(10).default([30, 7, 1]),
    note: z.string().max(2000).default(''),
    shared: z.boolean().default(false),
  })
  .strict();

/** Plain words for a wrong input, or the cleaned input. */
export function checkDeadline(raw: z.infer<typeof deadlineBody>): DeadlineInput {
  const title = raw.title.trim();
  if (title === '')
    throw new DeadlineError(400, 'bad_title', 'Напишите, что это за срок (например, «Страховка машины»).');
  if (Array.from(title).length > 120)
    throw new DeadlineError(400, 'bad_title', 'Название — до 120 символов.');
  if (!isRealDate(raw.expires))
    throw new DeadlineError(400, 'bad_date', 'Укажите дату окончания (год-месяц-день).');
  const days = [...new Set(raw.remindDays.map((n) => Math.round(n)).filter((n) => n >= 0 && n <= 730))].sort(
    (a, b) => b - a,
  );
  return {
    title,
    kind: raw.kind,
    expires: raw.expires,
    remindDays: days,
    note: raw.note.trim(),
    shared: raw.shared,
  };
}

export interface DeadlineJob {
  id: string;
  owner: string;
  shared: boolean;
  title: string;
  expires: string;
  daysLeft: number;
}

export function createDeadlineStore(dataDir: string, options: { clock: Clock }) {
  const file = path.join(dataDir, 'deadlines.json');
  const queue = createSerialQueue();
  const today = () => localMoment(options.clock()).day;

  async function read(): Promise<Stored[]> {
    let data: unknown;
    try {
      data = await readJsonFile(file);
    } catch {
      throw new DeadlineError(
        503,
        'unavailable',
        'Файл сроков на сервере повреждён. Сообщите администратору.',
      );
    }
    if (data === undefined) return [];
    const parsed = fileSchema.safeParse(data);
    if (!parsed.success) throw new DeadlineError(503, 'unavailable', 'Файл сроков имеет неверный формат.');
    return parsed.data.items;
  }
  const write = (items: Stored[]) => writeJsonAtomic(file, { version: 1, items });

  const view = (item: Stored, me: string): DeadlineView => ({
    id: item.id,
    owner: item.owner,
    ownerName: item.ownerName,
    title: item.title,
    kind: item.kind,
    expires: item.expires,
    remindDays: item.remindDays,
    note: item.note,
    shared: item.shared,
    daysLeft: daysBetween(today(), item.expires),
    mine: item.owner === me,
  });

  /** A private item is its author's alone, administrators included. */
  const visible = (item: Stored, me: string) => item.shared || item.owner === me;

  return {
    async list(me: string): Promise<DeadlineView[]> {
      return (await read())
        .filter((item) => visible(item, me))
        .map((item) => view(item, me))
        .sort((a, b) => a.daysLeft - b.daysLeft);
    },
    /** For the morning digest: what ends within `days` days (or already ended in the last week). */
    async soon(me: string, days: number): Promise<DeadlineView[]> {
      return (await this.list(me)).filter((item) => item.daysLeft <= days && item.daysLeft >= -7);
    },
    create(me: { username: string; displayName: string }, input: DeadlineInput): Promise<DeadlineView> {
      return queue.run(async () => {
        const items = await read();
        if (
          items.length >= MAX_DEADLINES ||
          items.filter((i) => i.owner === me.username).length >= MAX_PER_USER
        ) {
          throw new DeadlineError(409, 'too_many', 'Слишком много сроков: уберите ненужные.');
        }
        const item: Stored = {
          id: randomUUID(),
          owner: me.username,
          ownerName: me.displayName,
          ...input,
          told: [],
        };
        items.push(item);
        await write(items);
        return view(item, me.username);
      });
    },
    update(
      me: { username: string; isAdmin: boolean },
      id: string,
      input: DeadlineInput,
    ): Promise<DeadlineView> {
      return queue.run(async () => {
        const items = await read();
        const item = items.find((entry) => entry.id === id);
        if (!item || !visible(item, me.username))
          throw new DeadlineError(404, 'not_found', 'Такого срока нет.');
        if (item.owner !== me.username && !me.isAdmin) {
          throw new DeadlineError(
            403,
            'forbidden',
            'Чужой срок может менять только его автор или администратор.',
          );
        }
        Object.assign(item, input, { told: item.expires === input.expires ? item.told : [] });
        await write(items);
        return view(item, me.username);
      });
    },
    remove(me: { username: string; isAdmin: boolean }, id: string): Promise<void> {
      return queue.run(async () => {
        const items = await read();
        const index = items.findIndex((entry) => entry.id === id);
        const item = items[index];
        if (!item || !visible(item, me.username))
          throw new DeadlineError(404, 'not_found', 'Такого срока нет.');
        if (item.owner !== me.username && !me.isAdmin) {
          throw new DeadlineError(
            403,
            'forbidden',
            'Чужой срок может убрать только его автор или администратор.',
          );
        }
        items.splice(index, 1);
        await write(items);
      });
    },
    /**
     * The reminders due today. The «already told» mark is written before the job is handed out, so one
     * reminder is told once, not by the next hour and not again after a restart.
     */
    dueReminders(): Promise<DeadlineJob[]> {
      return queue.run(async () => {
        const items = await read();
        const now = today();
        const jobs: DeadlineJob[] = [];
        for (const item of items) {
          const left = daysBetween(now, item.expires);
          // The largest boundary already passed that was not told yet (a PC that was off does not lose a reminder).
          const due = item.remindDays.filter((d) => left <= d && !item.told.includes(d));
          if (due.length === 0 || left < -7) continue;
          item.told.push(...due);
          jobs.push({
            id: item.id,
            owner: item.owner,
            shared: item.shared,
            title: item.title,
            expires: item.expires,
            daysLeft: left,
          });
        }
        if (jobs.length > 0) await write(items);
        return jobs;
      });
    },
    async retireOwner(username: string): Promise<number> {
      return queue.run(async () => {
        const items = await read();
        const keep = items.filter((item) => item.owner !== username || item.shared);
        if (keep.length !== items.length) await write(keep);
        return items.length - keep.length;
      });
    },
  };
}

export type DeadlineStore = ReturnType<typeof createDeadlineStore>;
