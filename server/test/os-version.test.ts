import { describe, expect, it } from 'vitest';
import { parseOsVersion } from '../src/system/os-version.ts';

describe('parseOsVersion', () => {
  it('formats edition, display version and full build with UBR', () => {
    expect(
      parseOsVersion({ product: 'Windows 10 Home', displayVersion: '22H2', build: '19045', ubr: 6456 }),
    ).toBe('Windows 10 Home 22H2 (сборка 19045.6456)');
  });

  it('omits missing parts instead of inventing them', () => {
    expect(parseOsVersion({ product: 'Windows 10 Home', displayVersion: '', build: '19045', ubr: 0 })).toBe(
      'Windows 10 Home (сборка 19045)',
    );
    expect(parseOsVersion({ product: 'Windows 10 Home', displayVersion: '22H2', build: '' })).toBe(
      'Windows 10 Home 22H2',
    );
  });

  it('returns null for unusable output', () => {
    expect(parseOsVersion(null)).toBeNull();
    expect(parseOsVersion([])).toBeNull();
    expect(parseOsVersion({ product: '' })).toBeNull();
    expect(parseOsVersion('Windows')).toBeNull();
  });
});
