import { describe, expect, test } from 'vitest';
import { getSafeNavigationTarget, isSafeHttpsUrl, isSafeHttpUrl } from './security';

describe('safe URL handling', () => {
  test('accepts internal paths and ordinary HTTP(S) destinations', () => {
    expect(getSafeNavigationTarget('/settings?tab=profile')).toEqual({
      url: '/settings?tab=profile',
      external: false,
    });
    expect(getSafeNavigationTarget('https://example.com/path')).toEqual({
      url: 'https://example.com/path',
      external: true,
    });
    expect(isSafeHttpUrl('http://example.com')).toBe(true);
    expect(isSafeHttpsUrl('https://example.com/logo.svg')).toBe(true);
  });

  test('rejects executable, credentialed, protocol-relative, and ambiguous paths', () => {
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,unsafe',
      'https://user:password@example.com',
      '//attacker.example/path',
      '/\\attacker.example/path',
      'settings',
    ]) {
      expect(getSafeNavigationTarget(value)).toBeNull();
    }

    expect(isSafeHttpsUrl('http://example.com')).toBe(false);
  });
});
