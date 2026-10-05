import { describe, expect, test } from 'vitest';
import {
  allowShareFilter,
  canViewShareSection,
  excludeShareFilterParam,
  getShareTheme,
} from './share';

describe('canViewShareSection', () => {
  test('keeps ordinary users and legacy sectionless shares unrestricted', () => {
    expect(canViewShareSection(undefined, 'sessions')).toBe(true);
    expect(canViewShareSection({}, 'sessions')).toBe(true);
    expect(canViewShareSection({ allowFilter: false }, 'sessions')).toBe(true);
  });

  test('does not treat an adjacent section as session-profile access', () => {
    for (const section of ['events', 'realtime', 'revenue'] as const) {
      expect(canViewShareSection({ sessions: false, [section]: true }, 'sessions')).toBe(false);
    }

    expect(canViewShareSection({ sessions: true, events: false }, 'sessions')).toBe(true);
    expect(canViewShareSection({ sessions: false, events: true }, ['sessions', 'events'])).toBe(
      true,
    );
  });
});

describe('allowShareFilter', () => {
  test('returns true when parameters are missing', () => {
    expect(allowShareFilter()).toBe(true);
    expect(allowShareFilter(null)).toBe(true);
  });

  test('returns true unless allowFilter is explicitly false', () => {
    expect(allowShareFilter({ allowFilter: true } as any)).toBe(true);
    expect(allowShareFilter({} as any)).toBe(true);
    expect(allowShareFilter({ allowFilter: false } as any)).toBe(false);
  });
});

describe('getShareTheme', () => {
  test('returns light or dark when valid', () => {
    expect(getShareTheme({ theme: 'light' } as any)).toBe('light');
    expect(getShareTheme({ theme: 'dark' } as any)).toBe('dark');
  });

  test('returns undefined for missing or invalid themes', () => {
    expect(getShareTheme()).toBeUndefined();
    expect(getShareTheme(null)).toBeUndefined();
    expect(getShareTheme({ theme: 'blue' } as any)).toBeUndefined();
  });
});

describe('excludeShareFilterParam', () => {
  test('returns true for known filter columns', () => {
    expect(excludeShareFilterParam('path')).toBe(true);
    expect(excludeShareFilterParam('country')).toBe(true);
  });

  test('strips trailing digits before matching filter columns', () => {
    expect(excludeShareFilterParam('path2')).toBe(true);
  });

  test('returns true for reserved query params', () => {
    expect(excludeShareFilterParam('segment')).toBe(true);
    expect(excludeShareFilterParam('cohort')).toBe(true);
    expect(excludeShareFilterParam('match')).toBe(true);
    expect(excludeShareFilterParam('excludeBounce')).toBe(true);
  });

  test('returns false for unrelated keys', () => {
    expect(excludeShareFilterParam('foo')).toBe(false);
  });
});
