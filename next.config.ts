import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createNextIntlPlugin from 'next-intl/plugin';
import pkg from './package.json' with { type: 'json' };

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');
const projectRoot = fileURLToPath(new URL('.', import.meta.url));

const TRACKER_SCRIPT = '/script.js';

const isProd = process.env.NODE_ENV === 'production';
const isEnabled = (name: string) =>
  ['1', 'true', 'yes', 'on'].includes(process.env[name]?.trim().toLowerCase() ?? '');

const apiUrl = process.env.API_URL || '';
const basePath = process.env.BASE_PATH || '';
const cloudMode = isEnabled('CLOUD_MODE') ? 'true' : '';
const cloudUrl = process.env.CLOUD_URL || '';
const collectApiEndpoint = process.env.COLLECT_API_ENDPOINT || '';
const corsMaxAge = process.env.CORS_MAX_AGE || '';
const defaultCurrency = process.env.DEFAULT_CURRENCY || '';
const defaultLocale = process.env.DEFAULT_LOCALE || '';
const forceSSL = isProd || isEnabled('FORCE_SSL');
const trackerScriptName = process.env.TRACKER_SCRIPT_NAME || '';
const trackerScriptURL = process.env.TRACKER_SCRIPT_URL || '';
const selfTrack = process.env.UMAMI_SELF_TRACK || '';
const selfRecord = process.env.UMAMI_SELF_RECORD || '';

function getUrlOrigin(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function isRelativeUrl(url: string) {
  return Boolean(url && !/^https?:\/\//i.test(url));
}

function normalizePath(url: string) {
  return `/${url.replace(/^\/+|\/+$/g, '')}`;
}

function getSafeRoutePath(value: string, name: string, allowRoot = false) {
  const normalized = normalizePath(value);

  if (
    (normalized === '/' && !allowRoot) ||
    (normalized !== '/' && !/^\/[A-Za-z0-9._~!$&'()+,;=@%/-]+$/.test(normalized)) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`${name} must be a relative URL path without traversal or route patterns.`);
  }

  return normalized;
}

function getSafeHttpsUrl(value: string, name: string) {
  if (!value) {
    return '';
  }

  try {
    const url = new URL(value);

    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error();
    }

    return url.toString();
  } catch {
    throw new Error(`${name} must be an HTTPS URL without embedded credentials.`);
  }
}

function getAllowedFrameAncestors(value: string) {
  const sources = value
    .split(/[\s,]+/)
    .map(source => source.trim())
    .filter(Boolean)
    .map(source => {
      try {
        const url = new URL(source);

        if (
          !['https:', ...(isProd ? [] : ['http:'])].includes(url.protocol) ||
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

const apiUrlOrigin = getUrlOrigin(apiUrl);
const cloudUrlOrigin = getUrlOrigin(cloudUrl);
const connectSrc = ["'self'", apiUrlOrigin, cloudUrlOrigin].filter(Boolean).join(' ');
const allowedFrameAncestors = getAllowedFrameAncestors(process.env.ALLOWED_FRAME_URLS || '');
const frameAncestors = allowedFrameAncestors.length
  ? ["'self'", ...allowedFrameAncestors].join(' ')
  : "'none'";

const contentSecurityPolicy = `
  default-src 'self';
  base-uri 'self';
  object-src 'none';
  form-action 'self';
  img-src 'self' https: data: blob:;
  font-src 'self' data:;
  script-src 'self' 'unsafe-inline' ${isProd ? '' : "'unsafe-eval'"};
  style-src 'self' 'unsafe-inline';
  connect-src ${connectSrc};
  frame-src 'self' https: ${isProd ? '' : 'http:'};
  frame-ancestors ${frameAncestors};
  media-src 'self';
  worker-src 'self' blob:;
  manifest-src 'self';
  ${isProd ? 'upgrade-insecure-requests;' : ''}
`;

const defaultHeaders = [
  {
    key: 'X-DNS-Prefetch-Control',
    value: 'off',
  },
  {
    key: 'X-Robots-Tag',
    value: 'noindex, nofollow',
  },
  {
    key: 'X-Content-Type-Options',
    value: 'nosniff',
  },
  {
    key: 'Referrer-Policy',
    value: 'no-referrer',
  },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  },
  ...(allowedFrameAncestors.length
    ? []
    : [
        {
          key: 'X-Frame-Options',
          value: 'DENY',
        },
      ]),
  {
    key: 'Content-Security-Policy',
    value: contentSecurityPolicy.replace(/\s{2,}/g, ' ').trim(),
  },
];

if (forceSSL) {
  defaultHeaders.push({
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  });
}

const trackerHeaders = [
  {
    key: 'Access-Control-Allow-Origin',
    value: '*',
  },
  {
    key: 'Cross-Origin-Resource-Policy',
    value: 'cross-origin',
  },
  {
    key: 'Cache-Control',
    value: 'public, max-age=86400, must-revalidate',
  },
];

const apiHeaders = [
  {
    key: 'Access-Control-Allow-Origin',
    value: '*',
  },
  {
    key: 'Access-Control-Allow-Headers',
    value: 'Content-Type, X-Umami-Cache, X-Umami-Hostname',
  },
  {
    key: 'Access-Control-Allow-Methods',
    value: 'POST, OPTIONS',
  },
  {
    key: 'Access-Control-Max-Age',
    value: corsMaxAge || '86400',
  },
  {
    key: 'Cache-Control',
    value: 'no-store',
  },
];

const headers = [
  {
    source: '/api/send',
    headers: apiHeaders,
  },
  {
    source: '/api/record',
    headers: apiHeaders,
  },
  {
    source: '/api/batch',
    headers: apiHeaders,
  },
  {
    source: '/api/:path*',
    headers: [
      {
        key: 'Cache-Control',
        value: 'no-store',
      },
    ],
  },
  {
    source: '/:path*',
    headers: defaultHeaders,
  },
];

if (isProd) {
  headers.push({
    source: TRACKER_SCRIPT,
    headers: trackerHeaders,
  });
}

const rewrites = [];

if (trackerScriptURL) {
  rewrites.push({
    source: TRACKER_SCRIPT,
    destination: getSafeHttpsUrl(trackerScriptURL, 'TRACKER_SCRIPT_URL'),
  });
}

if (collectApiEndpoint) {
  const normalizedCollectApiEndpoint = getSafeRoutePath(collectApiEndpoint, 'COLLECT_API_ENDPOINT');

  headers.push({
    source: normalizedCollectApiEndpoint,
    headers: apiHeaders,
  });

  rewrites.push({
    source: normalizedCollectApiEndpoint,
    destination: '/api/send',
  });
}

if (isRelativeUrl(apiUrl)) {
  const normalizedApiUrl = getSafeRoutePath(apiUrl, 'API_URL', true);

  if (normalizedApiUrl !== '/' && normalizedApiUrl !== '/api') {
    headers.push({
      source: `${normalizedApiUrl}/:path*`,
      headers: [
        {
          key: 'Cache-Control',
          value: 'no-store',
        },
      ],
    });

    for (const endpoint of ['send', 'record', 'batch']) {
      headers.push({
        source: `${normalizedApiUrl}/${endpoint}`,
        headers: apiHeaders,
      });
    }

    rewrites.push({
      source: `${normalizedApiUrl}/:path*`,
      destination: '/api/:path*',
    });
  }
}

const redirects = [
  {
    source: '/teams/:id/dashboard/edit',
    destination: '/dashboard/edit',
    permanent: false,
  },
  {
    source: '/teams/:id/dashboard',
    destination: '/dashboard',
    permanent: false,
  },
  {
    source: '/settings',
    destination: '/settings/preferences',
    permanent: false,
  },
  {
    source: '/teams/:id',
    destination: '/teams/:id/websites',
    permanent: false,
  },
  {
    source: '/teams/:id/settings',
    destination: '/teams/:id/settings/preferences',
    permanent: false,
  },
  {
    source: '/admin',
    destination: '/admin/users',
    permanent: false,
  },
];

// Adding rewrites + headers for all alternative tracker script names.
if (trackerScriptName) {
  const names = trackerScriptName
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);

  names.forEach(name => {
    const normalizedSource = getSafeRoutePath(name, 'TRACKER_SCRIPT_NAME');

    rewrites.push({
      source: normalizedSource,
      destination: TRACKER_SCRIPT,
    });

    headers.push({
      source: normalizedSource,
      headers: trackerHeaders,
    });
  });
}

if (isProd && cloudMode) {
  rewrites.push({
    source: '/script.js',
    destination: 'https://cloud.umami.is/script.js',
  });
}

/** @type {import('next').NextConfig} */
export default withNextIntl({
  reactStrictMode: false,
  poweredByHeader: false,
  env: {
    apiUrl,
    basePath,
    cloudMode,
    cloudUrl,
    currentVersion: pkg.version,
    defaultCurrency,
    defaultLocale,
    selfTrack,
    selfRecord,
  },
  basePath,
  output: 'standalone',
  outputFileTracingRoot: path.resolve(projectRoot),
  devIndicators: false,
  turbopack: {
    root: path.resolve(projectRoot),
  },
  async headers() {
    return headers;
  },
  async rewrites() {
    return [
      ...rewrites,
      {
        source: '/teams/:teamId/:path*',
        destination: '/:path*',
      },
    ];
  },
  async redirects() {
    return [...redirects];
  },
});
