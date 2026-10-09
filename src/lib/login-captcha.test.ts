import { spawnSync } from 'node:child_process';
import { afterEach, expect, test, vi } from 'vitest';
import { isLoginCaptchaEnabled, verifyLoginCaptcha } from './login-captcha';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function configure() {
  vi.stubEnv('PUBLIC_URL', 'https://analytics.example.com');
  vi.stubEnv('TURNSTILE_SITE_KEY', 'public-test-key');
  vi.stubEnv('TURNSTILE_SECRET_KEY', 'private-test-key');
}

test('accepts only a verified login challenge for the configured hostname', async () => {
  configure();
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      Response.json({ success: true, action: 'login', hostname: 'analytics.example.com' }),
    );

  expect(isLoginCaptchaEnabled()).toBe(true);
  await expect(verifyLoginCaptcha('single-use-token')).resolves.toBe('valid');

  const [url, options] = fetchMock.mock.calls[0];
  expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
  expect(options?.method).toBe('POST');
  expect(options?.redirect).toBe('error');
  expect(new URLSearchParams(options?.body as string).get('response')).toBe('single-use-token');
});

test.each([
  { success: false, action: 'login', hostname: 'analytics.example.com' },
  { success: true, action: 'other', hostname: 'analytics.example.com' },
  { success: true, action: 'login', hostname: 'other.example.com' },
])('rejects an invalid or cross-context challenge', async result => {
  configure();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(result));

  await expect(verifyLoginCaptcha('single-use-token')).resolves.toBe('invalid');
});

test('rejects absent and oversized tokens without contacting the provider', async () => {
  configure();
  const fetchMock = vi.spyOn(globalThis, 'fetch');

  await expect(verifyLoginCaptcha(undefined)).resolves.toBe('invalid');
  await expect(verifyLoginCaptcha('x'.repeat(2049))).resolves.toBe('invalid');
  expect(fetchMock).not.toHaveBeenCalled();
});

test('local test keys can validate a loopback login with an empty PUBLIC_URL', async () => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('PUBLIC_URL', '');
  vi.stubEnv('TURNSTILE_SITE_KEY', '1x00000000000000000000AA');
  vi.stubEnv('TURNSTILE_SECRET_KEY', '1x0000000000000000000000000000000AA');
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ success: true, action: 'login', hostname: '127.0.0.1' }),
  );

  await expect(
    verifyLoginCaptcha('local-test-token', 'http://127.0.0.1:3000/api/auth/login'),
  ).resolves.toBe('valid');
  await expect(
    verifyLoginCaptcha('local-test-token', 'http://attacker.example/api/auth/login'),
  ).resolves.toBe('unavailable');
});

test('production never derives the expected hostname from the request URL', async () => {
  configure();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('PUBLIC_URL', '');
  const fetchMock = vi.spyOn(globalThis, 'fetch');

  await expect(
    verifyLoginCaptcha('single-use-token', 'https://analytics.example.com/api/auth/login'),
  ).resolves.toBe('unavailable');
  expect(fetchMock).not.toHaveBeenCalled();
});

test('production startup refuses published test credentials', () => {
  const result = spawnSync(process.execPath, ['scripts/check-env.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      DOTENV_CONFIG_PATH: '/dev/null',
      NODE_ENV: 'production',
      APP_SECRET: 'synthetic-app-secret-11111111111111111',
      PUBLIC_URL: 'https://analytics.example.com',
      CLIENT_IP_HEADER: 'X-Real-IP',
      DATABASE_URL:
        'postgresql://synthetic:synthetic-password-0000000000000000@127.0.0.1:5432/synthetic',
      TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
      TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    },
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    'Production login verification must use real Turnstile credentials.',
  );
  expect(result.stderr).not.toContain('1x0000000000000000000000000000000AA');
});

test('fails closed on partial configuration and provider failure', async () => {
  vi.stubEnv('TURNSTILE_SITE_KEY', 'public-test-key');
  vi.stubEnv('TURNSTILE_SECRET_KEY', '');
  vi.stubEnv('PUBLIC_URL', 'https://analytics.example.com');
  const fetchMock = vi.spyOn(globalThis, 'fetch');

  expect(isLoginCaptchaEnabled()).toBe(true);
  await expect(verifyLoginCaptcha('single-use-token')).resolves.toBe('unavailable');
  expect(fetchMock).not.toHaveBeenCalled();

  vi.stubEnv('TURNSTILE_SECRET_KEY', 'private-test-key');
  fetchMock.mockRejectedValue(new Error('provider offline'));
  await expect(verifyLoginCaptcha('single-use-token')).resolves.toBe('unavailable');
});

test.each([
  ['1x00000000000000000000AA', 'private-test-key'],
  ['public-test-key', '1x0000000000000000000000000000000AA'],
])('production rejects Cloudflare test credentials', async (siteKey, secretKey) => {
  configure();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('TURNSTILE_SITE_KEY', siteKey);
  vi.stubEnv('TURNSTILE_SECRET_KEY', secretKey);
  const fetchMock = vi.spyOn(globalThis, 'fetch');

  await expect(verifyLoginCaptcha('single-use-token')).resolves.toBe('unavailable');
  expect(fetchMock).not.toHaveBeenCalled();
});
