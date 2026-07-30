const DEFAULT_AUTH_SESSION_TTL_SECONDS = 8 * 60 * 60;
const DEFAULT_CACHE_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_SHARE_TOKEN_TTL_SECONDS = 60 * 60;

function getBoundedInteger(
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const value = process.env[name];

  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }

  return parsed;
}

export function getAuthSessionTtlSeconds(): number {
  return getBoundedInteger(
    'AUTH_SESSION_TTL_SECONDS',
    DEFAULT_AUTH_SESSION_TTL_SECONDS,
    15 * 60,
    24 * 60 * 60,
  );
}

export function getCacheTokenTtlSeconds(): number {
  return getBoundedInteger(
    'CACHE_TOKEN_TTL_SECONDS',
    DEFAULT_CACHE_TOKEN_TTL_SECONDS,
    30 * 60,
    7 * 24 * 60 * 60,
  );
}

export function getShareTokenTtlSeconds(): number {
  return getBoundedInteger(
    'SHARE_TOKEN_TTL_SECONDS',
    DEFAULT_SHARE_TOKEN_TTL_SECONDS,
    5 * 60,
    24 * 60 * 60,
  );
}

export function publicSharesDisabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    process.env.DISABLE_PUBLIC_SHARES?.trim().toLowerCase() ?? '',
  );
}

export function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      !!url.hostname &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function isSafeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

function hasUnsafeNavigationCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);

    if (character === '\\' || codePoint === undefined || codePoint < 32 || codePoint === 127) {
      return true;
    }
  }

  return false;
}

export function getSafeNavigationTarget(value: string): { url: string; external: boolean } | null {
  if (!value || value.length > 2_000 || hasUnsafeNavigationCharacter(value)) {
    return null;
  }

  if (value.startsWith('/') && !value.startsWith('//')) {
    try {
      const base = new URL('https://app.invalid');
      const parsed = new URL(value, base);

      if (parsed.origin === base.origin) {
        return { url: value, external: false };
      }
    } catch {
      return null;
    }
  }

  if (isSafeHttpUrl(value)) {
    return { url: new URL(value).toString(), external: true };
  }

  return null;
}

function normalizeTrackingHostname(value: string): string | null {
  try {
    const hostname = new URL(`https://${value.trim().toLowerCase()}`).hostname.replace(/\.$/, '');

    return hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function isAllowedTrackingHostname(
  configuredDomain: string | null | undefined,
  reportedHostname: string | null | undefined,
  pageUrl?: string | null,
): boolean {
  if (!configuredDomain || !reportedHostname) {
    return false;
  }

  const configured = normalizeTrackingHostname(configuredDomain);
  const reported = normalizeTrackingHostname(reportedHostname);

  if (!configured || !reported || configured !== reported) {
    return false;
  }

  if (!pageUrl) {
    return true;
  }

  try {
    const parsedUrl = new URL(pageUrl, `https://${reportedHostname}`);

    return (
      ['http:', 'https:'].includes(parsedUrl.protocol) &&
      normalizeTrackingHostname(parsedUrl.hostname) === reported
    );
  } catch {
    return false;
  }
}
