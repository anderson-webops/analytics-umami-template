import { HOMEPAGE_URL } from './constants';

type HeaderStore = Pick<Headers, 'get'>;

function getFirstHeaderValue(value?: string | null) {
  return value?.split(',')[0]?.trim();
}

function getDefaultProtocol(host?: string) {
  if (!host) {
    return 'https';
  }

  if (host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('[::1]')) {
    return 'http';
  }

  return 'https';
}

export function getBaseUrl(headers?: HeaderStore) {
  const publicUrl = process.env.PUBLIC_URL?.trim();

  if (publicUrl) {
    try {
      const url = new URL(publicUrl);

      if (url.protocol === 'https:' && !url.username && !url.password) {
        return new URL(url.origin);
      }
    } catch {
      // The production environment validator reports malformed values.
    }
  }

  if (process.env.NODE_ENV === 'production') {
    return new URL(HOMEPAGE_URL);
  }

  const host =
    getFirstHeaderValue(headers?.get('x-forwarded-host')) ||
    getFirstHeaderValue(headers?.get('host'));

  if (!host) {
    return new URL(HOMEPAGE_URL);
  }

  const protocol =
    getFirstHeaderValue(headers?.get('x-forwarded-proto')) ||
    getFirstHeaderValue(headers?.get('x-forwarded-protocol')) ||
    getDefaultProtocol(host);

  try {
    return new URL(`${protocol}://${host}`);
  } catch {
    return new URL(HOMEPAGE_URL);
  }
}
