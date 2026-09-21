import { hash } from '@/lib/crypto';
import { isEnvEnabled } from '@/lib/env';
import { getRandomChars } from '@/lib/generate';

export const API_KEY_PREFIX = 'umami_';
export const API_KEY_LENGTH = 32;
export const API_KEY_DISPLAY_LENGTH = API_KEY_PREFIX.length + 8;
export const API_KEY_LAST_USED_INTERVAL = 5 * 60 * 1000;

// Routes that manage account credentials or admin state must not be
// reachable with an API key. Matched as path prefixes.
export const API_KEY_BLOCKED_PATHS = [
  '/api/me/password',
  '/api/me/api-keys',
  '/api/2fa',
  '/api/auth',
  '/api/users',
  '/api/admin',
];

export function generateApiKey() {
  return `${API_KEY_PREFIX}${getRandomChars(API_KEY_LENGTH)}`;
}

export function hashApiKey(key: string) {
  return hash(key);
}

export function getApiKeyPrefix(key: string) {
  return key.slice(0, API_KEY_DISPLAY_LENGTH);
}

export function isApiKey(token?: string | null): token is string {
  return typeof token === 'string' && token.startsWith(API_KEY_PREFIX);
}

function normalizePath(pathname: string) {
  let decoded = pathname;

  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed encoded path will not match a valid application route.
  }

  const segments: string[] = [];

  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }

    if (segment === '..') {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }

  return `/${segments.join('/')}`;
}

function normalizeConfiguredPath(value?: string) {
  if (!value || /^https?:\/\//i.test(value)) {
    return '';
  }

  return normalizePath(value);
}

function removePrefix(pathname: string, prefix: string) {
  if (!prefix || prefix === '/') {
    return pathname;
  }

  if (pathname === prefix) {
    return '/';
  }

  return pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : pathname;
}

export function getCanonicalApiPath(
  pathname: string,
  options: { basePath?: string; apiUrl?: string } = {},
) {
  const basePath = normalizeConfiguredPath(options.basePath ?? process.env.BASE_PATH);
  const apiUrl = normalizeConfiguredPath(options.apiUrl ?? process.env.API_URL);
  let canonical = removePrefix(normalizePath(pathname), basePath);

  if (apiUrl && !['/', '/api'].includes(apiUrl)) {
    const rewritten = removePrefix(canonical, apiUrl);

    if (rewritten !== canonical) {
      canonical = `/api${rewritten === '/' ? '' : rewritten}`;
    }
  }

  return normalizePath(canonical);
}

export function isApiKeyBlockedPath(
  pathname: string,
  options?: { basePath?: string; apiUrl?: string },
) {
  const canonical = getCanonicalApiPath(pathname, options);

  return API_KEY_BLOCKED_PATHS.some(path => canonical === path || canonical.startsWith(`${path}/`));
}

export function isApiKeyEnabled() {
  return !isEnvEnabled('CLOUD_MODE');
}
