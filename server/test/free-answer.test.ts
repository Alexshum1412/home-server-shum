import { describe, expect, it } from 'vitest';
import { cleanFreeAnswer } from '../src/olivia/chat.ts';

describe('cleanFreeAnswer', () => {
  it('keeps a plain answer', () => {
    expect(cleanFreeAnswer('  Минск.  ')).toBe('Минск.');
  });
  it('removes a whole think block', () => {
    expect(cleanFreeAnswer('<think>рассуждаю</think>\n\nМинск.')).toBe('Минск.');
  });
  it('drops the reasoning before a lone closing tag', () => {
    expect(cleanFreeAnswer('Минск?</think>\n\nМинск.')).toBe('Минск.');
  });
  it('rejects an answer that is only reasoning', () => {
    expect(cleanFreeAnswer('Thinking:\n\n1. Identify the question')).toBe('');
  });
});
