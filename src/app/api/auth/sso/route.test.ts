import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  parseRequest: vi.fn(),
  getUser: vi.fn(),
  saveAuth: vi.fn(),
}));

vi.mock('@/lib/request', () => ({ parseRequest: mocks.parseRequest }));
vi.mock('@/queries/prisma', () => ({ getUser: mocks.getUser }));
vi.mock('@/lib/auth', () => ({ saveAuth: mocks.saveAuth }));
vi.mock('@/lib/redis', () => ({ default: { enabled: true } }));

import { POST } from './route';

const request = () => new Request('http://localhost/api/auth/sso', { method: 'POST' });

beforeEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.stubEnv('CLOUD_MODE', 'true');
  mocks.parseRequest.mockReset();
  mocks.getUser.mockReset();
  mocks.saveAuth.mockReset().mockResolvedValue('replacement-token');
  mocks.getUser.mockResolvedValue({
    role: 'user',
    password: 'password-hash',
    sessionGeneration: 3,
  });
  mocks.parseRequest.mockResolvedValue({
    auth: {
      user: { id: 'user-1', role: 'user' },
      authType: 'session',
      source: 'bearer',
      sessionGeneration: 3,
      expiresAt: Math.floor(Date.now() / 1000) + 1_800,
    },
  });
});

test('preserves the original expiry across repeated SSO exchanges', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
  const absoluteExpiry = Math.floor(Date.now() / 1000) + 1_800;
  const auth = (await mocks.parseRequest(request())).auth;
  auth.expiresAt = absoluteExpiry;
  mocks.parseRequest.mockResolvedValue({ auth });

  const first = await POST(request());
  expect(first.status).toBe(200);
  expect(first.headers.get('set-cookie')).toContain('Max-Age=1800');
  expect(mocks.saveAuth).toHaveBeenLastCalledWith(
    expect.objectContaining({ userId: 'user-1', sessionGeneration: 3 }),
    1_800,
    absoluteExpiry,
  );

  vi.setSystemTime(new Date('2026-10-11T12:10:00Z'));
  const second = await POST(request());
  expect(second.status).toBe(200);
  expect(second.headers.get('set-cookie')).toContain('Max-Age=1200');
  expect(mocks.saveAuth).toHaveBeenLastCalledWith(expect.anything(), 1_200, absoluteExpiry);
  vi.useRealTimers();
});

test('shortens an unusually long incoming session to the configured lifetime', async () => {
  const now = Math.floor(Date.now() / 1000);
  const auth = (await mocks.parseRequest(request())).auth;
  auth.expiresAt = now + 86_400;
  mocks.parseRequest.mockResolvedValue({ auth });

  const response = await POST(request());

  expect(response.status).toBe(200);
  expect(mocks.saveAuth).toHaveBeenCalledWith(expect.anything(), 28_800, now + 28_800);
});

test('rejects a session that expires while rechecking the user', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
  const auth = (await mocks.parseRequest(request())).auth;
  auth.expiresAt = Math.floor(Date.now() / 1000) + 1;
  mocks.parseRequest.mockResolvedValue({ auth });
  mocks.getUser.mockImplementationOnce(async () => {
    vi.setSystemTime(new Date('2026-10-11T12:00:02Z'));
    return { role: 'user', password: 'password-hash', sessionGeneration: 3 };
  });

  expect((await POST(request())).status).toBe(401);
  expect(mocks.saveAuth).not.toHaveBeenCalled();
  vi.useRealTimers();
});

test.each([
  ['ordinary cookie session', { source: 'cookie' }],
  ['API key', { authType: 'api-key' }],
  ['missing signed expiry', { expiresAt: undefined }],
  ['non-integer signed expiry', { expiresAt: 1.5 }],
  ['expired session', { expiresAt: 1 }],
])('rejects %s without minting a replacement', async (_, changedAuth) => {
  const auth = { ...(await mocks.parseRequest(request())).auth, ...changedAuth };
  mocks.parseRequest.mockResolvedValue({ auth });

  expect((await POST(request())).status).toBe(401);
  expect(mocks.saveAuth).not.toHaveBeenCalled();
  expect(mocks.getUser).not.toHaveBeenCalled();
});

test('rejects a session whose generation changed before exchange', async () => {
  mocks.getUser.mockResolvedValue({
    role: 'user',
    password: 'password-hash',
    sessionGeneration: 4,
  });

  expect((await POST(request())).status).toBe(401);
  expect(mocks.saveAuth).not.toHaveBeenCalled();
});

test('rejects a session whose role changed before exchange', async () => {
  mocks.getUser.mockResolvedValue({
    role: 'admin',
    password: 'password-hash',
    sessionGeneration: 3,
  });

  expect((await POST(request())).status).toBe(401);
  expect(mocks.saveAuth).not.toHaveBeenCalled();
});

test('does not expose the exchange outside Cloud mode', async () => {
  vi.stubEnv('CLOUD_MODE', '');

  expect((await POST(request())).status).toBe(404);
  expect(mocks.parseRequest).not.toHaveBeenCalled();
});
