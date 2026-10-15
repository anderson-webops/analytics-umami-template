import { type NextRequest, NextResponse } from 'next/server';
import { getAllowedFrameAncestors, getContentSecurityPolicy } from '@/lib/csp';
import { matchesConfiguredPath } from '@/lib/match-configured-path';
import { getExternalTrackerUrl, VERIFIED_TRACKER_PATH } from '@/lib/tracker-script';

export const config = {
  matcher: '/:path*',
};

const TRACKER_PATH = '/script.js';
const RECORDER_PATH = '/recorder.js';
const COLLECT_PATH = '/api/send';
const LOGIN_PATH = '/login';
const BASE_PATH = process.env.BASE_PATH || '';

const apiHeaders = {
  'Access-Control-Allow-Headers':
    'Content-Type, X-Umami-Cache, X-Umami-Hostname, X-Umami-Website-Id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': process.env.CORS_MAX_AGE || '86400',
  'Cache-Control': 'no-store',
};

const trackerCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

const trackerHeaders = {
  ...trackerCorsHeaders,
  'Cache-Control': 'public, max-age=86400, must-revalidate',
};

function isEnabled(value?: string) {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

// Resolved once at startup — env vars don't change after the process starts.
const contentSecurityPolicy = getContentSecurityPolicy({
  ...process.env,
  apiUrl: process.env.apiUrl,
  cloudUrl: process.env.cloudUrl,
});
const allowsFraming = getAllowedFrameAncestors(process.env.ALLOWED_FRAME_URLS || '').length > 0;

function customCollectEndpoint(request: NextRequest) {
  const collectEndpoint = process.env.COLLECT_API_ENDPOINT;

  if (collectEndpoint) {
    const url = request.nextUrl.clone();

    if (matchesConfiguredPath(url.pathname, collectEndpoint, BASE_PATH)) {
      url.pathname = COLLECT_PATH;
      return NextResponse.rewrite(url, { headers: apiHeaders });
    }
  }
}

function customScriptName(request: NextRequest) {
  const scriptName = process.env.TRACKER_SCRIPT_NAME;

  if (scriptName) {
    const url = request.nextUrl.clone();
    const names = scriptName.split(',').map(name => name.trim().replace(/^\/+/, ''));

    if (names.find(name => matchesConfiguredPath(url.pathname, name, BASE_PATH))) {
      if (getExternalTrackerUrl()) {
        return rewriteVerifiedTracker(url);
      }

      url.pathname = TRACKER_PATH;
      return NextResponse.rewrite(url, { headers: trackerHeaders });
    }
  }
}

function rewriteVerifiedTracker(url: URL) {
  url.pathname = VERIFIED_TRACKER_PATH;
  url.search = '';
  return NextResponse.rewrite(url, {
    headers: trackerCorsHeaders,
    request: { headers: new Headers({ Accept: 'text/javascript' }) },
  });
}

function customScriptUrl(request: NextRequest) {
  if (
    getExternalTrackerUrl() &&
    matchesConfiguredPath(request.nextUrl.pathname, TRACKER_PATH, BASE_PATH)
  ) {
    return rewriteVerifiedTracker(request.nextUrl.clone());
  }
}

function applyStaticScriptHeaders(request: NextRequest, response: NextResponse) {
  if (
    response.headers.get('x-middleware-rewrite') ===
    new URL(VERIFIED_TRACKER_PATH, request.url).href
  ) {
    return;
  }

  if (
    matchesConfiguredPath(request.nextUrl.pathname, TRACKER_PATH, BASE_PATH) ||
    matchesConfiguredPath(request.nextUrl.pathname, RECORDER_PATH, BASE_PATH)
  ) {
    Object.entries(trackerHeaders).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
  }
}

function disableLogin(request: NextRequest) {
  if (
    isEnabled(process.env.DISABLE_LOGIN) &&
    matchesConfiguredPath(request.nextUrl.pathname, LOGIN_PATH, BASE_PATH)
  ) {
    return new NextResponse('Access denied', { status: 403 });
  }
}

export default function middleware(request: NextRequest) {
  const handlers = [customCollectEndpoint, customScriptName, customScriptUrl, disableLogin];

  let response: NextResponse | undefined;

  for (const handler of handlers) {
    response = handler(request);
    if (response) {
      break;
    }
  }

  response ??= NextResponse.next();
  applyStaticScriptHeaders(request, response);

  // Set the CSP here, not only at build time in next.config.ts, so
  // ALLOWED_FRAME_URLS is resolved from the runtime environment.
  response.headers.set('Content-Security-Policy', contentSecurityPolicy);
  if (allowsFraming) {
    response.headers.delete('X-Frame-Options');
  } else {
    response.headers.set('X-Frame-Options', 'DENY');
  }

  return response;
}
