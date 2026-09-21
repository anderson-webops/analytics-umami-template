import { beforeEach, describe, expect, test, vi } from 'vitest';
import { hash } from '@/lib/crypto';
import { parseSecureToken } from '@/lib/jwt';
import redis from '@/lib/redis';
import { getApiKeyByHash, updateApiKeyLastUsed } from '@/queries/prisma/apiKey';
import { getUser } from '@/queries/prisma/user';
import { hashApiKey } from './api-key';
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

vi.mock('@/queries/prisma/apiKey', () => ({
  getApiKeyByHash: vi.fn(),
  updateApiKeyLastUsed: vi.fn(() => Promise.resolve()),
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
const getApiKeyByHashMock = vi.mocked(getApiKeyByHash);
const updateApiKeyLastUsedMock = vi.mocked(updateApiKeyLastUsed);
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
  vi.unstubAllEnvs();
  vi.stubEnv('CLOUD_MODE', '');
  parseSecureTokenMock.mockReset();
  getUserMock.mockReset();
  getApiKeyByHashMock.mockReset();
  updateApiKeyLastUsedMock.mockClear();
  redisMock.enabled = false;
  redisMock.client.get.mockReset();
});

describe('checkAuth api keys', () => {
  const API_KEY = 'umami_abcdefghijklmnopqrstuvwxyz012345';

  function apiKeyRequest(path = '/api/websites') {
    return new Request(`http://localhost${path}`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
  }

  function mockApiKey(lastUsedAt: Date | null = null) {
    getApiKeyByHashMock.mockResolvedValue({
      id: 'key-1',
      userId: 'user-1',
      name: 'CI',
      keyHash: hashApiKey(API_KEY),
      keyPrefix: 'umami_abcdefgh',
      lastUsedAt,
      createdAt: new Date(),
    } as any);
  }

  test('authorizes a valid API key without exposing the password', async () => {
    mockApiKey();
    mockUser();

    const result: any = await checkAuth(apiKeyRequest());

    expect(getApiKeyByHashMock).toHaveBeenCalledWith(hashApiKey(API_KEY));
    expect(result?.user?.id).toBe('user-1');
    expect(result?.user).not.toHaveProperty('password');
    expect(result?.apiKey).toEqual({ id: 'key-1', name: 'CI' });
    expect(result?.authType).toBe('api-key');
    expect(parseSecureTokenMock).not.toHaveBeenCalled();
  });

  test('rejects unknown or orphaned API keys', async () => {
    getApiKeyByHashMock.mockResolvedValue(null);
    expect(await checkAuth(apiKeyRequest())).toBeNull();

    mockApiKey();
    getUserMock.mockResolvedValue(null as any);
    expect(await checkAuth(apiKeyRequest())).toBeNull();
  });

  test('rejects API keys on credential and administration routes', async () => {
    mockApiKey();
    mockUser();

    for (const path of [
      '/api/me/password',
      '/api/me/api-keys',
      '/api/me/api-keys/key-1',
      '/api/2fa/status',
      '/api/auth/logout',
      '/api/users',
      '/api/admin/users',
    ]) {
      expect(await checkAuth(apiKeyRequest(path))).toBeNull();
    }

    expect(getApiKeyByHashMock).not.toHaveBeenCalled();
  });

  test('rejects API keys when a base path or API rewrite aliases a sensitive route', async () => {
    vi.stubEnv('BASE_PATH', '/analytics');
    vi.stubEnv('API_URL', '/data');
    mockApiKey();
    mockUser();

    for (const path of [
      '/analytics/api/2fa/status',
      '/analytics/data/2fa/setup/initiate',
      '/analytics/data/admin/users',
      '/api/%32fa/setup/initiate',
    ]) {
      expect(await checkAuth(apiKeyRequest(path))).toBeNull();
    }

    expect(getApiKeyByHashMock).not.toHaveBeenCalled();
  });

  test('ignores API keys in cloud mode', async () => {
    vi.stubEnv('CLOUD_MODE', '1');
    parseSecureTokenMock.mockReturnValue(null);

    expect(await checkAuth(apiKeyRequest())).toBeNull();
    expect(getApiKeyByHashMock).not.toHaveBeenCalled();
  });

  test('updates only stale API-key usage timestamps', async () => {
    mockApiKey(new Date(Date.now() - 60 * 60 * 1000));
    mockUser();
    await checkAuth(apiKeyRequest());
    expect(updateApiKeyLastUsedMock).toHaveBeenCalledWith('key-1');

    updateApiKeyLastUsedMock.mockClear();
    mockApiKey(new Date());
    await checkAuth(apiKeyRequest());
    expect(updateApiKeyLastUsedMock).not.toHaveBeenCalled();
  });
});

describe('checkAuth 2FA partial token', () => {
  test('rejects partial authentication tokens even with a valid fingerprint', async () => {
    parseSecureTokenMock.mockReturnValue({
      userId: 'user-1',
      role: 'user',
      type: 'partial-auth',
      pwd: hash(PASSWORD_HASH),
    } as any);
    mockUser();

    expect(await checkAuth(authedRequest())).toBeNull();
    expect(getUserMock).not.toHaveBeenCalled();
  });
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

  test('uses the configured public origin instead of a local request host', async () => {
    vi.stubEnv('PUBLIC_URL', 'https://analytics.example.com');
    parseSecureTokenMock.mockReturnValue({
      userId: 'user-1',
      role: 'user',
      pwd: hash(PASSWORD_HASH),
    } as any);
    mockUser();

    expect(
      await checkAuth(cookieRequest({ method: 'POST', origin: 'https://analytics.example.com' })),
    ).not.toBeNull();
    expect(
      await checkAuth(cookieRequest({ method: 'POST', origin: 'http://localhost' })),
    ).toBeNull();
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
