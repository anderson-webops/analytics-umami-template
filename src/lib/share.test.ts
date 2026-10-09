import { describe, expect, test } from 'vitest';
import { EVENT_COLUMNS, SESSION_COLUMNS } from './constants';
import {
  allowShareFilter,
  canViewShareSection,
  excludeShareFilterParam,
  getMetricShareSections,
  getShareTheme,
  getValueShareSections,
  restrictShareAuthToSection,
} from './share';

describe('getMetricShareSections', () => {
  test('classifies every accepted metric type and rejects unknown types', () => {
    for (const type of [...SESSION_COLUMNS, ...EVENT_COLUMNS, 'channel']) {
      expect(getMetricShareSections(type), type).not.toBeNull();
    }

    expect(getMetricShareSections('constructor')).toBeNull();
    expect(getMetricShareSections('newDimension')).toBeNull();
  });
});

describe('getValueShareSections', () => {
  test('requires the requested dimension section even when filtering is enabled', () => {
    expect(getValueShareSections('distinctId', true)).toEqual(['compare', 'sessions']);
    expect(getValueShareSections('event', true)).toEqual([
      'compare',
      'events',
      'journeys',
      'attribution',
    ]);
  });

  test('limits filter-disabled shares to journey and attribution selectors', () => {
    expect(getValueShareSections('path', false)).toEqual(['journeys', 'attribution']);
    expect(getValueShareSections('event', false)).toEqual(['journeys', 'attribution']);
    expect(getValueShareSections('distinctId', false)).toBeNull();
    expect(getValueShareSections('constructor', true)).toBeNull();
  });
});

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

describe('restrictShareAuthToSection', () => {
  const section = ['overview', 'compare'] as const;
  const user = { id: 'owner', username: 'owner', role: 'user', isAdmin: false };

  test('removes only a restricted share grant and preserves independent user access', () => {
    const auth = {
      user,
      shareToken: { websiteId: 'shared', parameters: { events: true } },
    };

    expect(restrictShareAuthToSection(auth, [...section])).toEqual({
      user,
      shareToken: undefined,
    });
    expect(auth.shareToken.websiteId).toBe('shared');
  });

  test('keeps enabled and legacy sectionless shares', () => {
    for (const parameters of [{ overview: true }, { compare: true }, {}]) {
      const auth = { shareToken: { websiteId: 'shared', parameters } };
      expect(restrictShareAuthToSection(auth, [...section])).toBe(auth);
    }
  });

  test('does not grant access when there is no share or user', () => {
    const auth = {};
    expect(restrictShareAuthToSection(auth, [...section])).toBe(auth);
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
