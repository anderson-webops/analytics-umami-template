const PRODUCTION_SESSION_COOKIE = '__Host-analytics-session';
const DEVELOPMENT_SESSION_COOKIE = 'analytics-session';

function getSessionCookieName(): string {
  return process.env.NODE_ENV === 'production'
    ? PRODUCTION_SESSION_COOKIE
    : DEVELOPMENT_SESSION_COOKIE;
}

function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();

  for (const part of header?.split(';') ?? []) {
    const separator = part.indexOf('=');

    if (separator < 1) {
      continue;
    }

    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();

    try {
      cookies.set(name, decodeURIComponent(rawValue));
    } catch {
      // Ignore malformed cookie values.
    }
  }

  return cookies;
}

export function getSessionCookie(request: Request): string | null {
  const cookies = parseCookies(request.headers.get('cookie'));

  if (process.env.NODE_ENV === 'production') {
    return cookies.get(PRODUCTION_SESSION_COOKIE) ?? null;
  }

  return cookies.get(DEVELOPMENT_SESSION_COOKIE) ?? null;
}

export function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);

  return match?.[1] || null;
}

function serializeCookie(name: string, value: string, maxAge: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';

  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Priority=High; Max-Age=${maxAge}${secure}`;
}

export function setSessionCookie(response: Response, token: string, maxAge: number): Response {
  response.headers.append('Set-Cookie', serializeCookie(getSessionCookieName(), token, maxAge));
  response.headers.set('Cache-Control', 'no-store');

  return response;
}

export function clearSessionCookies(response: Response): Response {
  response.headers.append('Set-Cookie', serializeCookie(PRODUCTION_SESSION_COOKIE, '', 0));
  response.headers.append('Set-Cookie', serializeCookie(DEVELOPMENT_SESSION_COOKIE, '', 0));
  response.headers.set('Cache-Control', 'no-store');

  return response;
}

export function isSameOriginMutation(request: Request): boolean {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method.toUpperCase())) {
    return true;
  }

  const origin = request.headers.get('origin');

  if (!origin) {
    return false;
  }

  try {
    const originUrl = new URL(origin);
    const publicUrl = process.env.PUBLIC_URL?.trim();

    if (publicUrl) {
      return originUrl.origin === new URL(publicUrl).origin;
    }

    const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
    const requestHost = forwardedHost || request.headers.get('host') || new URL(request.url).host;
    const forwardedProtocol = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();

    if (originUrl.host !== requestHost) {
      return false;
    }

    if (forwardedProtocol && originUrl.protocol !== `${forwardedProtocol}:`) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
