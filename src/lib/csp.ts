function getUrlOrigin(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export function getAllowedFrameAncestors(
  value: string,
  production = process.env.NODE_ENV === 'production',
) {
  const sources = value
    .split(/[\s,]+/)
    .map(source => source.trim())
    .filter(Boolean)
    .map(source => {
      try {
        const url = new URL(source);

        if (
          !['https:', ...(production ? [] : ['http:'])].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.pathname !== '/' ||
          url.search ||
          url.hash
        ) {
          throw new Error();
        }

        return url.origin;
      } catch {
        throw new Error('ALLOWED_FRAME_URLS must contain only exact HTTP(S) origins.');
      }
    });

  return [...new Set(sources)];
}

export function getContentSecurityPolicy(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === 'production';
  const apiUrlOrigins = [getUrlOrigin(env.API_URL || ''), getUrlOrigin(env.apiUrl || '')];
  const cloudUrlOrigins = [getUrlOrigin(env.CLOUD_URL || ''), getUrlOrigin(env.cloudUrl || '')];
  const captchaOrigin = env.TURNSTILE_SITE_KEY ? 'https://challenges.cloudflare.com' : '';
  const connectSrc = [...new Set(["'self'", ...apiUrlOrigins, ...cloudUrlOrigins, captchaOrigin])]
    .filter(Boolean)
    .join(' ');
  const allowedFrameAncestors = getAllowedFrameAncestors(env.ALLOWED_FRAME_URLS || '', production);
  const frameAncestors = allowedFrameAncestors.length
    ? ["'self'", ...allowedFrameAncestors].join(' ')
    : "'none'";

  const directives = [
    `default-src 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `form-action 'self'`,
    `img-src 'self' https: data: blob:`,
    `font-src 'self' data:`,
    `script-src ${["'self'", "'unsafe-inline'", production ? '' : "'unsafe-eval'", captchaOrigin].filter(Boolean).join(' ')}`,
    `style-src 'self' 'unsafe-inline'`,
    `connect-src ${connectSrc}`,
    `frame-src ${["'self'", 'https:', production ? '' : 'http:'].filter(Boolean).join(' ')}`,
    `frame-ancestors ${frameAncestors}`,
    `media-src 'self'`,
    `worker-src 'self' blob:`,
    `manifest-src 'self'`,
    ...(production ? ['upgrade-insecure-requests'] : []),
  ];

  return `${directives.join('; ')};`;
}
