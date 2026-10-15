import 'dotenv/config';
import path from 'node:path';
import createNextIntlPlugin from 'next-intl/plugin';
import pkg from './package.json' with { type: 'json' };
import { getContentSecurityPolicy } from './src/lib/csp.ts';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');
const projectRoot = process.cwd();

const TRACKER_SCRIPT = '/script.js';
const RECORDER_SCRIPT = '/recorder.js';

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
const selfTrack = process.env.UMAMI_SELF_TRACK || '';
const selfRecord = process.env.UMAMI_SELF_RECORD || '';

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

const contentSecurityPolicy = getContentSecurityPolicy();

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
  {
    key: 'Content-Security-Policy',
    value: contentSecurityPolicy,
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
];

const apiHeaders = [
  {
    key: 'Access-Control-Allow-Headers',
    value: 'Content-Type, X-Umami-Cache, X-Umami-Hostname, X-Umami-Website-Id',
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
  headers.push({
    source: RECORDER_SCRIPT,
    headers: trackerHeaders,
  });
}

const rewrites = [];

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
  serverExternalPackages: ['lightningcss'],
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
      // Keep pre-3.4 report callers working without exposing the compatibility
      // handlers as part of the current generated API contract.
      {
        source: '/api/reports/:path*',
        destination: '/compat/api/reports/:path*',
      },
      {
        source: '/api/websites/:websiteId/reports',
        destination: '/compat/api/websites/:websiteId/reports',
      },
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
