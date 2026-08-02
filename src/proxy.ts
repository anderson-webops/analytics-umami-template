import { type NextRequest, NextResponse } from 'next/server';
import { matchesConfiguredPath } from '@/lib/match-configured-path';

export const config = {
  matcher: '/:path*',
};

const TRACKER_PATH = '/script.js';
const COLLECT_PATH = '/api/send';
const LOGIN_PATH = '/login';
const BASE_PATH = process.env.BASE_PATH || '';

const apiHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'Content-Type, X-Umami-Cache, X-Umami-Hostname, X-Umami-Website-Id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': process.env.CORS_MAX_AGE || '86400',
  'Cache-Control': 'no-store',
};

const trackerHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Cache-Control': 'public, max-age=86400, must-revalidate',
};

function isEnabled(value?: string) {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

function getSafeTrackerUrl(value?: string) {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);

    if (url.protocol !== 'https:' || url.username || url.password) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

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
      url.pathname = TRACKER_PATH;
      return NextResponse.rewrite(url, { headers: trackerHeaders });
    }
  }
}

function customScriptUrl(request: NextRequest) {
  const scriptUrl = getSafeTrackerUrl(process.env.TRACKER_SCRIPT_URL);

  if (scriptUrl && matchesConfiguredPath(request.nextUrl.pathname, TRACKER_PATH, BASE_PATH)) {
    return NextResponse.rewrite(scriptUrl, { headers: trackerHeaders });
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

  for (const handler of handlers) {
    const response = handler(request);

    if (response) {
      return response;
    }
  }

  return NextResponse.next();
}
