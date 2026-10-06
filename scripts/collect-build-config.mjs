const COLLECTOR_URL = /^https?:\/\/[^/?#\\\s]+(?:\/[A-Za-z0-9._~!$&'()+,;=:@%/-]*)?$/i;
const APPLICATION_PATH = /^\/[A-Za-z0-9._~!$&'()+,;=:@%/-]+$/;

export function getCollectApiHost(value = process.env.COLLECT_API_HOST || '') {
  if (!value) {
    return '';
  }

  if (value.startsWith('/')) {
    if (
      (value !== '/' && !APPLICATION_PATH.test(value)) ||
      value.includes('//') ||
      value.split('/').some(segment => segment === '.' || segment === '..')
    ) {
      throw new Error('COLLECT_API_HOST must be a safe application path.');
    }

    return value === '/' ? value : value.replace(/\/$/, '');
  }

  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error('COLLECT_API_HOST must be a safe HTTPS URL or local HTTP URL.');
  }

  const pathStart = value.indexOf('/', value.indexOf('://') + 3);
  const rawPath = pathStart < 0 ? '/' : value.slice(pathStart);
  const localHttpHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

  if (
    !COLLECTOR_URL.test(value) ||
    Array.from(value).some(character => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 0x20 || codePoint === 0x7f;
    }) ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHttpHost)) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== rawPath ||
    url.pathname.includes('//') ||
    url.search ||
    url.hash
  ) {
    throw new Error('COLLECT_API_HOST must be a safe HTTPS URL or local HTTP URL.');
  }

  return value.replace(/\/$/, '');
}

export function getCollectApiEndpoint(value = process.env.COLLECT_API_ENDPOINT || '/api/send') {
  const endpoint = value || '/api/send';

  if (
    endpoint === '/' ||
    !APPLICATION_PATH.test(endpoint) ||
    endpoint.includes('//') ||
    endpoint.split('/').includes('..')
  ) {
    throw new Error('COLLECT_API_ENDPOINT must be a safe non-root application path.');
  }

  return endpoint;
}

export function getCollectBuildConfig() {
  return {
    host: getCollectApiHost(),
    endpoint: getCollectApiEndpoint(),
  };
}
