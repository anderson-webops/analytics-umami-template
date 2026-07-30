function getFirstDomain(domain?: string | null): string | null {
  return domain?.split(',')[0]?.trim() || null;
}

function getWebsiteOrigin(domain?: string | null): URL | null {
  const host = getFirstDomain(domain);

  if (!host) {
    return null;
  }

  try {
    const value =
      host.startsWith('http://') || host.startsWith('https://')
        ? host
        : `${
            host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('[::1]')
              ? 'http'
              : 'https'
          }://${host}`;
    const url = new URL(value);

    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      (url.pathname !== '/' && url.pathname !== '') ||
      url.search ||
      url.hash
    ) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

export function getHeatmapUrlPath(value: string): string {
  try {
    const url = new URL(value, 'https://heatmap.invalid');

    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return '/';
    }

    return url.pathname || '/';
  } catch {
    return '/';
  }
}

export function buildHeatmapPageUrl(
  domain: string | null | undefined,
  urlPath: string,
): string | null {
  const origin = getWebsiteOrigin(domain);

  if (!origin || !urlPath.startsWith('/') || urlPath.startsWith('//')) {
    return null;
  }

  try {
    const url = new URL(urlPath, origin);

    return url.origin === origin.origin ? url.toString() : null;
  } catch {
    return null;
  }
}
