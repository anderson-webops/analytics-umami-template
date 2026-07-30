import { beforeEach, describe, expect, test, vi } from 'vitest';
import { hash } from '@/lib/crypto';
import { parseSecureToken } from '@/lib/jwt';
import redis from '@/lib/redis';
import { getUser } from '@/queries/prisma/user';
import { checkAuth } from './auth';

vi.mock('@/lib/jwt', () => ({
  parseSecureToken: vi.fn(),
  parseToken: vi.fn(() => null),
}));

vi.mock('@/queries/prisma/user', () => ({
  getUser: vi.fn(),
}));

vi.mock('@/queries/prisma', () => ({
  getShare: vi.fn(),
}));

vi.mock('@/lib/share-access', () => ({
  resolveShareAccess: vi.fn(),
}));

vi.mock('@/lib/redis', () => ({
  default: {
    enabled: false,
    client: {
      get: vi.fn(),
    },
  },
}));

const parseSecureTokenMock = vi.mocked(parseSecureToken);
const getUserMock = vi.mocked(getUser);
const redisMock = redis as unknown as {
  enabled: boolean;
  client: {
    get: ReturnType<typeof vi.fn>;
  };
};

const PASSWORD_HASH = '$2b$10$currentpasswordhashvalue';

function authedRequest() {
  return new Request('http://localhost/api/test', {
    headers: { authorization: 'Bearer secure-token' },
  });
}

function cookieRequest(options: { method?: string; origin?: string } = {}) {
  const headers = new Headers({ cookie: 'analytics-session=secure-token' });

  if (options.origin) {
    headers.set('origin', options.origin);
  }

  return new Request('http://localhost/api/test', {
    method: options.method,
    headers,
  });
}

function mockUser() {
  getUserMock.mockResolvedValue({
    id: 'user-1',
    username: 'bob',
    role: 'user',
    password: PASSWORD_HASH,
  } as any);
}

beforeEach(() => {
  parseSecureTokenMock.mockReset();
  getUserMock.mockReset();
  redisMock.enabled = false;
  redisMock.client.get.mockReset();
});

describe('checkAuth password fingerprint', () => {
  test('authorizes a stateless token whose fingerprint matches the current password', async () => {
    parseSecureTokenMock.mockReturnValue({
      userId: 'user-1',
      role: 'user',
      pwd: hash(PASSWORD_HASH),
    } as any);
    mockUser();

    const result = await checkAuth(authedRequest());

    expect(result?.user?.id).toBe('user-1');
  });

  test('rejects a legacy stateless token that does not include a password fingerprint', async () => {
    parseSecureTokenMock.mockReturnValue({ userId: 'user-1', role: 'user' } as any);
    mockUser();

    const result = await checkAuth(authedRequest());

    expect(result).toBeNull();
  });

  test('rejects a stateless token whose fingerprint predates a password change', async () => {
    // Token minted against the old password must stop working once the password changes.
    parseSecureTokenMock.mockReturnValue({
      userId: 'user-1',
      role: 'user',
      pwd: hash('old-password-hash'),
    } as any);
    mockUser();

    const result = await checkAuth(authedRequest());

    expect(result).toBeNull();
  });

  test('does not expose the password hash on the returned user', async () => {
    parseSecureTokenMock.mockReturnValue({
      userId: 'user-1',
      role: 'user',
      pwd: hash(PASSWORD_HASH),
    } as any);
    mockUser();

    const result = await checkAuth(authedRequest());

    expect(result?.user).not.toHaveProperty('password');
  });

  test('authorizes a Redis session whose fingerprint matches the current password', async () => {
    redisMock.enabled = true;
    parseSecureTokenMock.mockReturnValue({ authKey: 'auth:session-key' } as any);
    redisMock.client.get.mockResolvedValue({
      userId: 'user-1',
      role: 'user',
      pwd: hash(PASSWORD_HASH),
    });
    mockUser();

    const result = await checkAuth(authedRequest());

    expect(result?.user?.id).toBe('user-1');
  });

  test('rejects a Redis session whose fingerprint predates a password change', async () => {
    redisMock.enabled = true;
    parseSecureTokenMock.mockReturnValue({ authKey: 'auth:session-key' } as any);
    redisMock.client.get.mockResolvedValue({
      userId: 'user-1',
      role: 'user',
      pwd: hash('old-password-hash'),
    });
    mockUser();

    const result = await checkAuth(authedRequest());

    expect(result).toBeNull();
  });

  test('authorizes a cookie session for a read request', async () => {
    parseSecureTokenMock.mockReturnValue({
      userId: 'user-1',
      role: 'user',
      pwd: hash(PASSWORD_HASH),
    } as any);
    mockUser();

    const result = await checkAuth(cookieRequest());

    expect(result?.source).toBe('cookie');
    expect(result?.user?.id).toBe('user-1');
  });

  test('authorizes a same-origin cookie session for a mutation', async () => {
    parseSecureTokenMock.mockReturnValue({
      userId: 'user-1',
      role: 'user',
      pwd: hash(PASSWORD_HASH),
    } as any);
    mockUser();

    const result = await checkAuth(cookieRequest({ method: 'POST', origin: 'http://localhost' }));

    expect(result?.user?.id).toBe('user-1');
  });

  test('rejects a cross-origin cookie session for a mutation', async () => {
    parseSecureTokenMock.mockReturnValue({
      userId: 'user-1',
      role: 'user',
      pwd: hash(PASSWORD_HASH),
    } as any);
    mockUser();

    const result = await checkAuth(
      cookieRequest({ method: 'POST', origin: 'https://attacker.example' }),
    );

    expect(result).toBeNull();
  });

  test('rejects a session minted before a global role change', async () => {
    parseSecureTokenMock.mockReturnValue({
      userId: 'user-1',
      role: 'admin',
      pwd: hash(PASSWORD_HASH),
    } as any);
    mockUser();

    const result = await checkAuth(authedRequest());

    expect(result).toBeNull();
  });
});
