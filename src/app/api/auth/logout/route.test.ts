import { beforeEach, expect, test, vi } from 'vitest';
import redis from '@/lib/redis';
import { parseRequest } from '@/lib/request';
import { revokeStatelessSessions } from '@/queries/prisma/user';
import { POST } from './route';

vi.mock('@/lib/redis', () => ({
  default: {
    enabled: true,
    client: {
      del: vi.fn(),
    },
  },
}));

vi.mock('@/lib/request', () => ({
  parseRequest: vi.fn(),
}));

vi.mock('@/queries/prisma/user', () => ({
  revokeStatelessSessions: vi.fn(),
}));

vi.mock('@/lib/response', () => ({
  ok: () => new Response(null, { status: 200 }),
  unauthorized: () => new Response(null, { status: 401 }),
}));

const redisMock = redis as unknown as {
  enabled: boolean;
  client: {
    del: ReturnType<typeof vi.fn>;
  };
};
const parseRequestMock = vi.mocked(parseRequest);
const revokeStatelessSessionsMock = vi.mocked(revokeStatelessSessions);

beforeEach(() => {
  redisMock.enabled = true;
  redisMock.client.del.mockReset();
  parseRequestMock.mockReset();
  revokeStatelessSessionsMock.mockReset();
});

test('POST deletes the authenticated Redis auth key', async () => {
  parseRequestMock.mockResolvedValue({
    auth: { authKey: 'auth:session-key', authType: 'session', user: { id: 'user-1' } },
    error: undefined,
  });

  const response = await POST(
    new Request('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secure-token',
      },
    }),
  );

  expect(redisMock.client.del).toHaveBeenCalledTimes(1);
  expect(redisMock.client.del).toHaveBeenCalledWith('auth:session-key');
  expect(redisMock.client.del).not.toHaveBeenCalledWith('secure-token');
  expect(revokeStatelessSessionsMock).not.toHaveBeenCalled();
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
});

test.each([false, true])(
  'POST revokes stateless sessions without an active Redis key (Redis %s)',
  async enabled => {
    redisMock.enabled = enabled;
    parseRequestMock.mockResolvedValue({
      auth: {
        authType: 'session',
        user: { id: 'user-1' },
        sessionGeneration: 3,
      },
      error: undefined,
    });

    const response = await POST(
      new Request('http://localhost/api/auth/logout', { method: 'POST' }),
    );

    expect(revokeStatelessSessionsMock).toHaveBeenCalledExactlyOnceWith('user-1', 3);
    expect(redisMock.client.del).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  },
);

test('POST fails closed when stateless revocation cannot complete', async () => {
  redisMock.enabled = false;
  revokeStatelessSessionsMock.mockRejectedValueOnce(new Error('Database unavailable'));
  parseRequestMock.mockResolvedValue({
    auth: { authType: 'session', user: { id: 'user-1' }, sessionGeneration: 3 },
    error: undefined,
  });

  await expect(
    POST(new Request('http://localhost/api/auth/logout', { method: 'POST' })),
  ).rejects.toThrow('Database unavailable');
});

test('POST revokes legacy stateless tokens without a generation field', async () => {
  redisMock.enabled = false;
  parseRequestMock.mockResolvedValue({
    auth: { authType: 'session', user: { id: 'user-1' } },
    error: undefined,
  });

  const response = await POST(new Request('http://localhost/api/auth/logout', { method: 'POST' }));

  expect(revokeStatelessSessionsMock).toHaveBeenCalledExactlyOnceWith('user-1', 0);
  expect(response.status).toBe(200);
});

test('POST rejects share tokens without revoking another account', async () => {
  redisMock.enabled = false;
  parseRequestMock.mockResolvedValue({
    auth: { authType: 'share', user: null },
    error: undefined,
  });

  const response = await POST(new Request('http://localhost/api/auth/logout', { method: 'POST' }));

  expect(response.status).toBe(401);
  expect(revokeStatelessSessionsMock).not.toHaveBeenCalled();
});

test('POST neither revokes auth nor clears cookies for a rejected cross-origin request', async () => {
  parseRequestMock.mockResolvedValue({
    auth: null,
    error: () => new Response(null, { status: 401 }),
  });

  const response = await POST(
    new Request('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: {
        origin: 'https://attacker.example',
        cookie: 'analytics-session=opaque-session',
      },
    }),
  );

  expect(redisMock.client.del).not.toHaveBeenCalled();
  expect(response.status).toBe(401);
  expect(response.headers.get('set-cookie')).toBeNull();
});

test('POST clears stale cookies for a same-origin failed logout', async () => {
  parseRequestMock.mockResolvedValue({
    auth: null,
    error: () => new Response(null, { status: 401 }),
  });

  const response = await POST(
    new Request('http://localhost/api/auth/logout', {
      method: 'POST',
      headers: { origin: 'http://localhost' },
    }),
  );

  expect(redisMock.client.del).not.toHaveBeenCalled();
  expect(response.status).toBe(401);
  expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
});
