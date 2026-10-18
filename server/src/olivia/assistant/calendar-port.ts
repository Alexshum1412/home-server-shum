import type { CalendarOccurrence } from '../../../../shared/api.ts';

/** The part of the calendar store the assistant uses (read only). */
export interface CalendarStoreLike {
  occurrences(
    viewer: { username: string; isAdmin: boolean },
    from: string,
    to: string,
  ): Promise<{ occurrences: CalendarOccurrence[]; truncated: boolean }>;
}
