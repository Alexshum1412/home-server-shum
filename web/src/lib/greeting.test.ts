import { describe, expect, it } from 'vitest';
import { greetingFor, greetingLine } from './greeting.ts';

describe('greetingFor', () => {
  it.each([
    [0, 'Доброй ночи'],
    [4, 'Доброй ночи'],
    [5, 'Доброе утро'],
    [11, 'Доброе утро'],
    [12, 'Добрый день'],
    [16, 'Добрый день'],
    [17, 'Добрый вечер'],
    [22, 'Добрый вечер'],
    [23, 'Доброй ночи'],
  ])('hour %i → «%s»', (hour, expected) => {
    expect(greetingFor(hour)).toBe(expected);
  });
});

describe('greetingLine', () => {
  it('adds the display name', () => {
    expect(greetingLine(9, 'Мама')).toBe('Доброе утро, Мама');
    expect(greetingLine(18, '  Папа ')).toBe('Добрый вечер, Папа');
  });

  it('greets without a name when there is none', () => {
    expect(greetingLine(13, null)).toBe('Добрый день');
    expect(greetingLine(13, undefined)).toBe('Добрый день');
    expect(greetingLine(13, '   ')).toBe('Добрый день');
  });
});
