import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  API_KEY_PREFIX,
  generateApiKey,
  getApiKeyPrefix,
  getCanonicalApiPath,
  hashApiKey,
  isApiKey,
  isApiKeyBlockedPath,
  isApiKeyBlockedRequest,
  isApiKeyEnabled,
  redactWebsiteShareId,
} from './api-key';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isApiKeyBlockedRequest', () => {
  test.each([
    ['POST', '/api/teams'],
    ['POST', '/api/teams/join'],
    ['POST', '/api/teams/team-1'],
    ['DELETE', '/api/teams/team-1'],
    ['POST', '/api/teams/team-1/users'],
    ['POST', '/api/teams/team-1/users/user-2'],
    ['DELETE', '/api/teams/team-1/users/user-2'],
    ['POST', '/api/teams/team-1/owner'],
    ['POST', '/api/share'],
    ['GET', '/api/share/id/share-1'],
    ['POST', '/api/share/id/share-1'],
    ['DELETE', '/api/share/id/share-1'],
    ['POST', '/api/websites/site-1/shares'],
    ['POST', '/api/boards/board-1/shares'],
    ['POST', '/api/links/link-1/shares'],
    ['POST', '/api/pixels/pixel-1/shares'],
    ['GET', '/api/websites/site-1/shares'],
    ['POST', '/api/websites/site-1/transfer'],
  ])('rejects %s %s for an ordinary API key', (method, path) => {
    expect(isApiKeyBlockedRequest(path, method)).toBe(true);
  });

  test('allows unrelated reads and data operations', () => {
    for (const [method, path] of [
      ['GET', '/api/teams'],
      ['GET', '/api/teams/team-1'],
      ['GET', '/api/teams/team-1/users'],
      ['GET', '/api/websites/site-1/stats'],
      ['POST', '/api/websites/site-1/annotations'],
      ['POST', '/api/authors'],
    ]) {
      expect(isApiKeyBlockedRequest(path, method)).toBe(false);
    }
  });

  test('rejects aliases and encoded sensitive routes without matching neighbors', () => {
    const options = { basePath: '/analytics', apiUrl: '/data' };

    for (const path of [
      '/analytics/data/teams/team-1/users',
      '/analytics/teams/nav/data/teams/team-1/owner',
      '/analytics/data/websites/site-1/shares',
      '/analytics/data/%73hare/id/share-1',
      '/analytics/data/boards/board-1/shares/../shares',
      '/analytics/data/websites/site-1/transfer',
    ]) {
      expect(isApiKeyBlockedRequest(path, 'POST', options)).toBe(true);
    }

    expect(isApiKeyBlockedRequest('/api/teamsters', 'POST')).toBe(false);
    expect(isApiKeyBlockedRequest('/api/websites/site-1/shared', 'POST')).toBe(false);
  });
});

test('API-key website responses hide durable public-share slugs', () => {
  const website = { id: 'site-1', shareId: 'public-slug' };

  expect(redactWebsiteShareId(website, 'api-key')).toEqual({ id: 'site-1', shareId: null });
  expect(redactWebsiteShareId(website, 'session', false)).toEqual({
    id: 'site-1',
    shareId: null,
  });
  expect(redactWebsiteShareId(website, 'session')).toEqual({ id: 'site-1', shareId: null });
  expect(redactWebsiteShareId(website, 'session', true)).toEqual(website);
  expect(website.shareId).toBe('public-slug');
});

describe('generateApiKey', () => {
  test('produces umami_ followed by 32 base62 characters', () => {
    const key = generateApiKey();

    expect(key).toMatch(/^umami_[0-9a-zA-Z]{32}$/);
  });

  test('produces unique keys', () => {
    expect(generateApiKey()).not.toBe(generateApiKey());
  });
});

describe('hashApiKey', () => {
  test('is deterministic and does not equal the key', () => {
    const key = generateApiKey();

    expect(hashApiKey(key)).toBe(hashApiKey(key));
    expect(hashApiKey(key)).not.toBe(key);
    expect(hashApiKey(key)).toHaveLength(128);
  });
});

describe('getApiKeyPrefix', () => {
  test('returns the prefix plus the first 8 characters', () => {
    const key = `${API_KEY_PREFIX}abcdefghijklmnopqrstuvwxyz012345`;

    expect(getApiKeyPrefix(key)).toBe('umami_abcdefgh');
  });
});

describe('isApiKey', () => {
  test('detects api keys by prefix', () => {
    expect(isApiKey('umami_abc')).toBe(true);
    expect(isApiKey('eyJhbGciOi')).toBe(false);
    expect(isApiKey(undefined)).toBe(false);
    expect(isApiKey(null)).toBe(false);
  });
});

describe('isApiKeyBlockedPath', () => {
  test('blocks credential and admin routes', () => {
    expect(isApiKeyBlockedPath('/api/me/password')).toBe(true);
    expect(isApiKeyBlockedPath('/api/me/api-keys')).toBe(true);
    expect(isApiKeyBlockedPath('/api/me/api-keys/abc')).toBe(true);
    expect(isApiKeyBlockedPath('/api/2fa/status')).toBe(true);
    expect(isApiKeyBlockedPath('/api/auth/logout')).toBe(true);
    expect(isApiKeyBlockedPath('/api/users')).toBe(true);
    expect(isApiKeyBlockedPath('/api/users/abc/websites')).toBe(true);
    expect(isApiKeyBlockedPath('/api/admin/users')).toBe(true);
  });

  test('allows data routes', () => {
    expect(isApiKeyBlockedPath('/api/me')).toBe(false);
    expect(isApiKeyBlockedPath('/api/me/websites')).toBe(false);
    expect(isApiKeyBlockedPath('/api/me/teams')).toBe(false);
    expect(isApiKeyBlockedPath('/api/websites')).toBe(false);
    expect(isApiKeyBlockedPath('/api/websites/abc/stats')).toBe(false);
    expect(isApiKeyBlockedPath('/api/authors')).toBe(false);
  });

  test('blocks sensitive routes beneath BASE_PATH and relative API_URL aliases', () => {
    const options = { basePath: '/analytics', apiUrl: '/data' };

    expect(isApiKeyBlockedPath('/analytics/api/2fa/status', options)).toBe(true);
    expect(isApiKeyBlockedPath('/analytics/data/2fa/setup/initiate', options)).toBe(true);
    expect(isApiKeyBlockedPath('/analytics/data/admin/users', options)).toBe(true);
    expect(isApiKeyBlockedPath('/analytics/data/websites/site/stats', options)).toBe(false);
  });

  test('normalizes encoded and dot-segment aliases before enforcing the denylist', () => {
    expect(isApiKeyBlockedPath('/api/%32fa/setup/initiate')).toBe(true);
    expect(isApiKeyBlockedPath('/api/websites/../admin/users')).toBe(true);
    expect(getCanonicalApiPath('//api///me/password/')).toBe('/api/me/password');
  });

  test('canonicalizes team navigation prefixes before classifying API permissions', () => {
    for (const prefix of ['/teams/team-1', '/TEAMS/team-1', '/teams/team-1/teams/team-2']) {
      expect(getCanonicalApiPath(`${prefix}/api/websites`)).toBe('/api/websites');
      expect(isApiKeyBlockedPath(`${prefix}/api/me/password`)).toBe(true);
      expect(isApiKeyBlockedPath(`${prefix}/api/me/api-keys`)).toBe(true);
      expect(isApiKeyBlockedPath(`${prefix}/api/2fa/status`)).toBe(true);
      expect(isApiKeyBlockedPath(`${prefix}/api/users`)).toBe(true);
      expect(isApiKeyBlockedPath(`${prefix}/api/websites`)).toBe(false);
    }

    const options = { basePath: '/analytics', apiUrl: '/data' };
    expect(isApiKeyBlockedPath('/analytics/teams/team-1/data/admin/users', options)).toBe(true);
    expect(getCanonicalApiPath('/teams/team-1/api/teams/team-2')).toBe('/api/teams/team-2');
    expect(isApiKeyBlockedPath('/api/teams/team-1')).toBe(false);
  });

  test('matches rewrite ordering without decoding the discarded team identifier', () => {
    expect(getCanonicalApiPath('/teams/team%2Fone/api/websites')).toBe('/api/websites');
    expect(getCanonicalApiPath('/teams/team%5Cone/api/websites')).toBe('/api/websites');
    expect(getCanonicalApiPath('/teams/team-1/websites', { apiUrl: '/teams/team-1' })).toBe(
      '/api/websites',
    );
    expect(getCanonicalApiPath('/TEAMS/team-1/websites', { apiUrl: '/teams/team-1' })).toBe(
      '/api/websites',
    );
    expect(
      getCanonicalApiPath('/analytics/teams/team-1/websites', {
        basePath: '/analytics',
        apiUrl: '/teams/team-1',
      }),
    ).toBe('/api/websites');
  });

  test('team canonicalization agrees with the installed router on synthetic data paths', () => {
    const matchTeam = getPathMatch('/teams/:teamId/:path*');

    for (const teamId of ['team-1', 'team%2Fone', 'team%5Cone', 'team%252Fone']) {
      const pathname = `/teams/${teamId}/api/websites`;
      const match = matchTeam(pathname);
      expect(match).not.toBe(false);
      if (match) {
        expect(getCanonicalApiPath(pathname)).toBe(`/${match.path.join('/')}`);
      }
    }
  });

  test('normalizing a later parameter cannot erase a restricted route prefix', () => {
    for (const prefix of ['/api/users', '/teams/team-1/api/users', '/api/%75sers']) {
      expect(isApiKeyBlockedPath(`${prefix}/%2e%2e%2Fwebsites`)).toBe(true);
    }
    expect(isApiKeyBlockedPath('/api/websites/site-1')).toBe(false);
  });
});

describe('isApiKeyEnabled', () => {
  test('is disabled in cloud mode', () => {
    vi.stubEnv('CLOUD_MODE', '1');

    expect(isApiKeyEnabled()).toBe(false);
  });

  test('is enabled when CLOUD_MODE is unset', () => {
    vi.stubEnv('CLOUD_MODE', '');

    expect(isApiKeyEnabled()).toBe(true);
  });

  test('is enabled when CLOUD_MODE is explicitly false', () => {
    vi.stubEnv('CLOUD_MODE', '0');

    expect(isApiKeyEnabled()).toBe(true);
  });
});
