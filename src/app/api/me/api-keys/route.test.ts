import { beforeEach, expect, test, vi } from 'vitest';
import { parseRequest } from '@/lib/request';
import { GET, POST } from './route';

const mocks = vi.hoisted(() => ({
  createApiKey: vi.fn(),
  getUserApiKeys: vi.fn(),
  getUser: vi.fn(),
  checkPassword: vi.fn(),
  reservePasswordVerificationAttempt: vi.fn(),
}));

vi.mock('@/lib/request', () => ({
  parseRequest: vi.fn(),
}));

vi.mock('@/queries/prisma/apiKey', () => ({
  createApiKey: mocks.createApiKey,
  getUserApiKeys: mocks.getUserApiKeys,
}));

vi.mock('@/queries/prisma/user', () => ({
  getUser: mocks.getUser,
}));

vi.mock('@/lib/password', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/password')>()),
  checkPassword: mocks.checkPassword,
}));

vi.mock('@/lib/password-verification-rate-limit', () => ({
  reservePasswordVerificationAttempt: mocks.reservePasswordVerificationAttempt,
}));

const parseRequestMock = vi.mocked(parseRequest);

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('CLOUD_MODE', '');
  parseRequestMock.mockReset();
  mocks.createApiKey.mockReset();
  mocks.getUserApiKeys.mockReset();
  mocks.getUser.mockReset().mockResolvedValue({ id: 'user-1', password: 'password-hash' });
  mocks.checkPassword.mockReset().mockResolvedValue(true);
  mocks.reservePasswordVerificationAttempt
    .mockReset()
    .mockResolvedValue({ allowed: true, retryAfter: 0 });

  parseRequestMock.mockResolvedValue({
    auth: { authType: 'session', user: { id: 'user-1' }, sessionGeneration: 0 },
    body: { name: 'CI pipeline', currentPassword: 'current-password' },
    error: undefined,
  });
});

test('GET returns the current user api keys', async () => {
  const keys = [{ id: 'key-1', name: 'CI pipeline', keyPrefix: 'umami_abcdefgh' }];
  mocks.getUserApiKeys.mockResolvedValue(keys as any);

  const response = await GET(new Request('http://localhost/api/me/api-keys'));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual(keys);
  expect(mocks.getUserApiKeys).toHaveBeenCalledWith('user-1');
});

test('GET returns 404 in cloud mode', async () => {
  vi.stubEnv('CLOUD_MODE', '1');

  const response = await GET(new Request('http://localhost/api/me/api-keys'));

  expect(response.status).toBe(404);
  expect(mocks.getUserApiKeys).not.toHaveBeenCalled();
});

test('GET returns the auth error when unauthenticated', async () => {
  parseRequestMock.mockResolvedValue({
    auth: null,
    error: () => new Response(null, { status: 401 }),
  });

  const response = await GET(new Request('http://localhost/api/me/api-keys'));

  expect(response.status).toBe(401);
});

test('POST creates a key, stores only the hash, and returns the plaintext once', async () => {
  mocks.createApiKey.mockImplementation(async data => ({
    id: data.id,
    name: data.name,
    keyPrefix: data.keyPrefix,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  }));

  const response = await POST(new Request('http://localhost/api/me/api-keys', { method: 'POST' }));

  expect(response.status).toBe(200);

  const body = await response.json();

  expect(body.key).toMatch(/^umami_[0-9a-zA-Z]{32}$/);
  expect(body.name).toBe('CI pipeline');
  expect(body.keyPrefix).toBe(body.key.slice(0, 14));
  expect(body).not.toHaveProperty('keyHash');

  const stored = mocks.createApiKey.mock.calls[0][0];

  expect(stored.userId).toBe('user-1');
  expect(stored.keyHash).not.toBe(body.key);
  expect(stored.keyHash).toHaveLength(128);
  expect(stored).not.toHaveProperty('key');
  expect(mocks.createApiKey.mock.calls[0][1]).toBe(0);
  expect(mocks.createApiKey.mock.calls[0][2]).toBe('password-hash');
  expect(mocks.checkPassword).toHaveBeenCalledWith('current-password', 'password-hash');
  expect(parseRequestMock.mock.calls[0][2]).toEqual({ maxBodyBytes: 16 * 1024 });
});

test('POST requires the current password in a strict, bounded request', async () => {
  await POST(new Request('http://localhost/api/me/api-keys', { method: 'POST' }));

  const schema = parseRequestMock.mock.calls[0][1];
  expect(schema.safeParse({ name: 'CI pipeline' }).success).toBe(false);
  expect(
    schema.safeParse({ name: 'CI pipeline', currentPassword: 'current-password' }).success,
  ).toBe(true);
  expect(
    schema.safeParse({
      name: 'CI pipeline',
      currentPassword: 'current-password',
      unexpected: true,
    }).success,
  ).toBe(false);
  expect(parseRequestMock.mock.calls[0][2]).toEqual({ maxBodyBytes: 16 * 1024 });
});

test('POST rejects an incorrect password without creating a key', async () => {
  mocks.checkPassword.mockResolvedValue(false);

  const response = await POST(new Request('http://localhost/api/me/api-keys', { method: 'POST' }));

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({
    error: { code: 'incorrect-password' },
  });
  expect(mocks.createApiKey).not.toHaveBeenCalled();
});

test('POST shares the account password-attempt limit', async () => {
  mocks.reservePasswordVerificationAttempt.mockResolvedValue({ allowed: false, retryAfter: 45 });

  const response = await POST(new Request('http://localhost/api/me/api-keys', { method: 'POST' }));

  expect(response.status).toBe(429);
  expect(mocks.checkPassword).not.toHaveBeenCalled();
  expect(mocks.createApiKey).not.toHaveBeenCalled();
});

test('POST fails closed when password verification is unavailable', async () => {
  mocks.reservePasswordVerificationAttempt.mockRejectedValue(new Error('unavailable'));

  const response = await POST(new Request('http://localhost/api/me/api-keys', { method: 'POST' }));

  expect(response.status).toBe(503);
  expect(mocks.checkPassword).not.toHaveBeenCalled();
  expect(mocks.createApiKey).not.toHaveBeenCalled();
});

test.each(['api-key', 'share', 'partial'] as const)(
  'POST rejects %s authentication without verifying a password',
  async authType => {
    parseRequestMock.mockResolvedValue({
      auth: { authType, user: { id: 'user-1' }, sessionGeneration: 0 },
      body: { name: 'CI pipeline', currentPassword: 'current-password' },
      error: undefined,
    });

    const response = await POST(
      new Request('http://localhost/api/me/api-keys', { method: 'POST' }),
    );

    expect(response.status).toBe(401);
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  },
);

test('POST rejects enrollment-only sessions', async () => {
  parseRequestMock.mockResolvedValue({
    auth: {
      authType: 'session',
      user: { id: 'user-1' },
      sessionGeneration: 0,
      enrollmentOnly: true,
    },
    body: { name: 'CI pipeline', currentPassword: 'current-password' },
    error: undefined,
  });

  const response = await POST(new Request('http://localhost/api/me/api-keys', { method: 'POST' }));

  expect(response.status).toBe(401);
  expect(mocks.createApiKey).not.toHaveBeenCalled();
});

test('POST rejects an old session when credential creation sees a newer generation', async () => {
  mocks.createApiKey.mockResolvedValue(null);

  const response = await POST(new Request('http://localhost/api/me/api-keys', { method: 'POST' }));

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({
    error: { code: 'credentials-changed' },
  });
  expect(mocks.createApiKey.mock.calls[0][1]).toBe(0);
});

test('POST returns 404 in cloud mode', async () => {
  vi.stubEnv('CLOUD_MODE', '1');

  const response = await POST(new Request('http://localhost/api/me/api-keys', { method: 'POST' }));

  expect(response.status).toBe(404);
  expect(mocks.createApiKey).not.toHaveBeenCalled();
});
