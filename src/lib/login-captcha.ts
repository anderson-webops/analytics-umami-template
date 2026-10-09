type CaptchaResult = 'valid' | 'invalid' | 'unavailable';

const TEST_SITE_KEYS = new Set([
  '1x00000000000000000000AA',
  '2x00000000000000000000AB',
  '1x00000000000000000000BB',
  '2x00000000000000000000BB',
  '3x00000000000000000000FF',
]);
const TEST_SECRET_KEYS = new Set([
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
]);

function isTestLoginCaptchaKey(siteKey: string | undefined, secretKey: string | undefined) {
  return Boolean(
    (siteKey && TEST_SITE_KEYS.has(siteKey)) || (secretKey && TEST_SECRET_KEYS.has(secretKey)),
  );
}

export function isLoginCaptchaEnabled() {
  return Boolean(process.env.TURNSTILE_SITE_KEY || process.env.TURNSTILE_SECRET_KEY);
}

export async function verifyLoginCaptcha(
  token: string | undefined,
  requestUrl?: string,
): Promise<CaptchaResult> {
  const siteKey = process.env.TURNSTILE_SITE_KEY;
  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  const publicUrl =
    process.env.PUBLIC_URL || (process.env.NODE_ENV === 'production' ? undefined : requestUrl);

  if (
    !siteKey ||
    !secretKey ||
    !publicUrl ||
    (process.env.NODE_ENV === 'production' && isTestLoginCaptchaKey(siteKey, secretKey))
  ) {
    return 'unavailable';
  }

  if (!token || token.length > 2048) {
    return 'invalid';
  }

  let hostname: string;

  try {
    const url = new URL(publicUrl);
    hostname = url.hostname.toLowerCase();

    if (
      !process.env.PUBLIC_URL &&
      (!['http:', 'https:'].includes(url.protocol) ||
        !['localhost', '127.0.0.1'].includes(hostname))
    ) {
      return 'unavailable';
    }
  } catch {
    return 'unavailable';
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: secretKey, response: token }),
      signal: controller.signal,
      cache: 'no-store',
      redirect: 'error',
    });

    if (!response.ok) {
      return 'unavailable';
    }

    const result = await response.json();

    return result?.success === true &&
      result?.action === 'login' &&
      typeof result?.hostname === 'string' &&
      result.hostname.toLowerCase() === hostname
      ? 'valid'
      : 'invalid';
  } catch {
    return 'unavailable';
  } finally {
    clearTimeout(timeout);
  }
}
