import { describe, expect, it } from 'vitest';
import { dayLabel, hueOf, initials, listTime, sameDay, splitLinks } from './format.ts';

describe('chat formatting', () => {
  const now = new Date(2026, 9, 18, 12, 0);

  it('names today, yesterday and older days', () => {
    expect(dayLabel(new Date(2026, 9, 18, 8, 5).toISOString(), now)).toBe('Сегодня');
    expect(dayLabel(new Date(2026, 9, 17, 23, 59).toISOString(), now)).toBe('Вчера');
    expect(dayLabel(new Date(2026, 9, 1, 9).toISOString(), now)).toBe('1 октября');
    expect(dayLabel(new Date(2025, 11, 31, 9).toISOString(), now)).toBe('31 декабря 2025 г.');
    expect(dayLabel('not a date', now)).toBe('');
  });

  it('shows the clock for today in the list and the day otherwise', () => {
    expect(listTime(new Date(2026, 9, 18, 8, 5).toISOString(), now)).toMatch(/^08[:.]05$/);
    expect(listTime(new Date(2026, 9, 17, 8, 5).toISOString(), now)).toBe('Вчера');
  });

  it('tells whether two moments are on one day', () => {
    expect(sameDay(new Date(2026, 9, 18, 1).toISOString(), new Date(2026, 9, 18, 23).toISOString())).toBe(
      true,
    );
    expect(sameDay(new Date(2026, 9, 17, 23).toISOString(), new Date(2026, 9, 18, 0, 1).toISOString())).toBe(
      false,
    );
  });

  it('makes initials', () => {
    expect(initials('Мама')).toBe('М');
    expect(initials('  света  иванова ')).toBe('СИ');
    expect(initials('')).toBe('?');
  });

  it('gives a person the same colour every time', () => {
    expect(hueOf('u1')).toBe(hueOf('u1'));
    expect(hueOf('u1')).not.toBe(hueOf('u2'));
    expect(hueOf('anything')).toBeLessThan(360);
  });

  it('finds links without taking the punctuation after them', () => {
    expect(splitLinks('Смотри https://example.org/a?b=1, и всё.')).toEqual([
      { kind: 'text', text: 'Смотри ' },
      { kind: 'link', text: 'https://example.org/a?b=1', href: 'https://example.org/a?b=1' },
      { kind: 'text', text: ', и всё.' },
    ]);
    expect(splitLinks('(http://a.example)')).toEqual([
      { kind: 'text', text: '(' },
      { kind: 'link', text: 'http://a.example', href: 'http://a.example/' },
      { kind: 'text', text: ')' },
    ]);
  });

  it('never links anything but http(s)', () => {
    expect(splitLinks('javascript:alert(1) ftp://x data:text/html,x')).toEqual([
      { kind: 'text', text: 'javascript:alert(1) ftp://x data:text/html,x' },
    ]);
    expect(splitLinks('')).toEqual([]);
  });
});
