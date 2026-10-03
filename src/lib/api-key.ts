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

function decodePath(pathname: string) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function normalizePath(pathname: string) {
  const segments: string[] = [];

  for (const segment of decodePath(pathname).split('/')) {
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

  return `/${value.replace(/^\/+|\/+$/g, '')}`;
}

function removePrefix(pathname: string, prefix: string) {
  if (!prefix || prefix === '/') {
    return pathname;
  }

  if (pathname.toLowerCase() === prefix.toLowerCase()) {
    return '/';
  }

  return pathname.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)
    ? pathname.slice(prefix.length)
    : pathname;
}

function resolveApiPath(pathname: string, options: { basePath?: string; apiUrl?: string } = {}) {
  const basePath = normalizeConfiguredPath(options.basePath ?? process.env.BASE_PATH);
  const apiUrl = normalizeConfiguredPath(options.apiUrl ?? process.env.API_URL);
  let canonical = removePrefix(pathname.replace(/\/{2,}/g, '/'), basePath);

  for (;;) {
    if (apiUrl && !['/', '/api'].includes(apiUrl)) {
      const rewritten = removePrefix(canonical, apiUrl);

      if (rewritten !== canonical) {
        return `/api${rewritten === '/' ? '' : rewritten}`;
      }
    }

    const teamPrefix = /^\/teams\/[^/]+(?=\/|$)/i.exec(canonical);

    if (!teamPrefix) {
      break;
    }

    canonical = canonical.slice(teamPrefix[0].length) || '/';
  }

  return canonical;
}

export function getCanonicalApiPath(
  pathname: string,
  options: { basePath?: string; apiUrl?: string } = {},
) {
  return normalizePath(resolveApiPath(pathname, options));
}

export function isApiKeyBlockedPath(
  pathname: string,
  options?: { basePath?: string; apiUrl?: string },
) {
  const resolved = resolveApiPath(pathname, options);
  const candidates = [resolved, decodePath(resolved), normalizePath(resolved)];

  return candidates.some(canonical =>
    API_KEY_BLOCKED_PATHS.some(path => canonical === path || canonical.startsWith(`${path}/`)),
  );
}

export function isApiKeyBlockedRequest(
  pathname: string,
  method: string,
  options?: { basePath?: string; apiUrl?: string },
) {
  if (isApiKeyBlockedPath(pathname, options)) {
    return true;
  }

  const resolved = resolveApiPath(pathname, options);
  const candidates = [resolved, decodePath(resolved), normalizePath(resolved)].map(path =>
    path.toLowerCase(),
  );
  const isTeamRequest = candidates.some(
    path => path === '/api/teams' || path.startsWith('/api/teams/'),
  );
  const isShareRequest = candidates.some(
    path =>
      path === '/api/share' ||
      path.startsWith('/api/share/') ||
      /^\/api\/(?:websites|boards|links|pixels)\/[^/]+\/shares(?:\/|$)/.test(path),
  );
  const isTransferRequest = candidates.some(path =>
    /^\/api\/websites\/[^/]+\/transfer(?:\/|$)/.test(path),
  );

  return (
    isShareRequest ||
    isTransferRequest ||
    (isTeamRequest && !['GET', 'HEAD'].includes(method.toUpperCase()))
  );
}

export function redactWebsiteShareId<T extends object>(website: T, authType: string) {
  return authType === 'api-key' ? { ...website, shareId: null } : website;
}

export function isApiKeyEnabled() {
  return !isEnvEnabled('CLOUD_MODE');
}
