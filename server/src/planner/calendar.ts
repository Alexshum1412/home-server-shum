/**
 * The family calendar: events in calendar.json (in the portal's data folder, so every backup has
 * them). Family events are visible to everybody who is signed in, private ones only to their author.
 * The author and administrators may change or delete an event.
 */
import path from 'node:path';
import { z } from 'zod';
import type { CalendarEventInput, CalendarEventView, CalendarOccurrence } from '../../../shared/api.ts';
import { newId } from '../lib/ids.ts';
import { createSerialQueue, readJsonFile, writeJsonAtomic } from '../lib/json-store.ts';
import { type Clock, isoNow } from '../lib/time.ts';
import { daysBetween, eachDay, isRealDate, isTime, occursOn } from './dates.ts';

export class CalendarError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const MAX_EVENTS = 5000;
export const MAX_RANGE_DAYS = 120;
export const TITLE_MAX = 120;
export const NOTE_MAX = 1000;

interface StoredEvent extends CalendarEventInput {
  id: string;
  owner: string;
  ownerName: string;
  createdAt: string;
  updatedAt: string;
}

const eventSchema = z.object({
  id: z.string().min(1),
  owner: z.string().min(1),
  ownerName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  title: z.string().min(1).max(TITLE_MAX),
  date: z.string().refine(isRealDate),
  endDate: z.string().refine(isRealDate).nullable(),
  time: z.string().refine(isTime).nullable(),
  endTime: z.string().refine(isTime).nullable(),
  repeat: z.enum(['none', 'weekly', 'monthly', 'yearly']),
  note: z.string().max(NOTE_MAX),
  private: z.boolean(),
});
const fileSchema = z.object({ version: z.literal(1), events: z.array(eventSchema) });

/** What a request may contain; checked again with plain words below. */
export const eventInputSchema = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX),
  date: z.string(),
  endDate: z.string().nullable().default(null),
  time: z.string().nullable().default(null),
  endTime: z.string().nullable().default(null),
  repeat: z.enum(['none', 'weekly', 'monthly', 'yearly']).default('none'),
  note: z.string().max(NOTE_MAX).default(''),
  private: z.boolean().default(false),
});

/** Checks the combination of fields; returns a Russian problem or the clean input. */
export function checkInput(raw: z.infer<typeof eventInputSchema>): CalendarEventInput {
  const bad = (message: string) => new CalendarError(400, 'bad_event', message);
  if (!isRealDate(raw.date)) throw bad('Укажите настоящую дату.');
  const endDate = raw.endDate === '' ? null : raw.endDate;
  if (endDate !== null) {
    if (!isRealDate(endDate)) throw bad('Дата окончания указана неверно.');
    if (endDate < raw.date) throw bad('Событие не может закончиться раньше, чем началось.');
    if (endDate === raw.date) return checkInput({ ...raw, endDate: null });
    if (raw.repeat !== 'none') throw bad('Повторяющееся событие может занимать только один день.');
    if (daysBetween(raw.date, endDate) > 60) throw bad('Событие не может длиться больше 60 дней.');
  }
  const time = raw.time === '' ? null : raw.time;
  const endTime = raw.endTime === '' ? null : raw.endTime;
  if (time !== null && !isTime(time)) throw bad('Время указано неверно (например, 18:30).');
  if (endTime !== null) {
    if (time === null) throw bad('Время окончания можно указать только вместе с временем начала.');
    if (!isTime(endTime)) throw bad('Время окончания указано неверно.');
    if (endDate === null && endTime <= time) throw bad('Окончание должно быть позже начала.');
  }
  return {
    title: raw.title.trim(),
    date: raw.date,
    endDate,
    time,
    endTime,
    repeat: raw.repeat,
    note: raw.note.trim(),
    private: raw.private,
  };
}

export interface Viewer {
  username: string;
  isAdmin: boolean;
}

export function createCalendarStore(dataDir: string, options: { clock: Clock }) {
  const file = path.join(dataDir, 'calendar.json');
  const queue = createSerialQueue();

  async function read(): Promise<StoredEvent[]> {
    let data: unknown;
    try {
      data = await readJsonFile(file);
    } catch {
      throw new CalendarError(
        503,
        'unavailable',
        'Файл календаря на сервере повреждён. Сообщите администратору.',
      );
    }
    if (data === undefined) return [];
    const parsed = fileSchema.safeParse(data);
    if (!parsed.success) {
      throw new CalendarError(
        503,
        'unavailable',
        'Файл календаря на сервере имеет неверный формат. Сообщите администратору.',
      );
    }
    return parsed.data.events;
  }

  const visible = (event: StoredEvent, viewer: Viewer) => !event.private || event.owner === viewer.username;
  const view = (event: StoredEvent, viewer: Viewer): CalendarEventView => ({
    ...event,
    canEdit: event.owner === viewer.username || viewer.isAdmin,
  });

  return {
    file,

    async visibleEvents(viewer: Viewer): Promise<CalendarEventView[]> {
      return (await read()).filter((event) => visible(event, viewer)).map((event) => view(event, viewer));
    },

    /** Every appearance of the events in [from, to] that this person may see, ordered by day and time. */
    async occurrences(viewer: Viewer, from: string, to: string): Promise<CalendarOccurrence[]> {
      if (!isRealDate(from) || !isRealDate(to) || to < from) {
        throw new CalendarError(400, 'bad_range', 'Неверный период.');
      }
      if (daysBetween(from, to) >= MAX_RANGE_DAYS) {
        throw new CalendarError(400, 'bad_range', `Период не больше ${MAX_RANGE_DAYS} дней.`);
      }
      const events = (await read()).filter((event) => visible(event, viewer));
      const out: CalendarOccurrence[] = [];
      for (const event of events) {
        const last = event.endDate ?? event.date;
        if (event.repeat === 'none' && (last < from || event.date > to)) continue;
        if (event.repeat !== 'none' && event.date > to) continue;
        for (const day of eachDay(from, to)) {
          const hit =
            event.repeat === 'none'
              ? day >= event.date && day <= last
              : occursOn(event.date, event.repeat, day);
          if (hit) out.push({ day, event: view(event, viewer) });
        }
      }
      return out.sort(
        (a, b) =>
          a.day.localeCompare(b.day) ||
          (a.event.time ?? '').localeCompare(b.event.time ?? '') ||
          a.event.title.localeCompare(b.event.title, 'ru'),
      );
    },

    create(viewer: Viewer & { displayName: string }, input: CalendarEventInput): Promise<CalendarEventView> {
      return queue.run(async () => {
        const events = await read();
        if (events.length >= MAX_EVENTS) {
          throw new CalendarError(409, 'too_many', 'В календаре слишком много событий. Удалите старые.');
        }
        const now = isoNow(options.clock);
        const event: StoredEvent = {
          ...input,
          id: newId(),
          owner: viewer.username,
          ownerName: viewer.displayName,
          createdAt: now,
          updatedAt: now,
        };
        await writeJsonAtomic(file, { version: 1, events: [...events, event] });
        return view(event, viewer);
      });
    },

    update(viewer: Viewer, id: string, input: CalendarEventInput): Promise<CalendarEventView> {
      return queue.run(async () => {
        const events = await read();
        const index = events.findIndex((event) => event.id === id);
        const existing = events[index];
        if (!existing || !visible(existing, viewer)) {
          throw new CalendarError(404, 'not_found', 'Такого события нет.');
        }
        if (existing.owner !== viewer.username && !viewer.isAdmin) {
          throw new CalendarError(
            403,
            'forbidden',
            'Изменить событие может только тот, кто его добавил, или администратор.',
          );
        }
        const updated: StoredEvent = { ...existing, ...input, updatedAt: isoNow(options.clock) };
        const next = events.slice();
        next[index] = updated;
        await writeJsonAtomic(file, { version: 1, events: next });
        return view(updated, viewer);
      });
    },

    remove(viewer: Viewer, id: string): Promise<void> {
      return queue.run(async () => {
        const events = await read();
        const existing = events.find((event) => event.id === id);
        if (!existing || !visible(existing, viewer)) {
          throw new CalendarError(404, 'not_found', 'Такого события нет.');
        }
        if (existing.owner !== viewer.username && !viewer.isAdmin) {
          throw new CalendarError(
            403,
            'forbidden',
            'Удалить событие может только тот, кто его добавил, или администратор.',
          );
        }
        await writeJsonAtomic(file, { version: 1, events: events.filter((event) => event.id !== id) });
      });
    },
  };
}

export type CalendarStore = ReturnType<typeof createCalendarStore>;
