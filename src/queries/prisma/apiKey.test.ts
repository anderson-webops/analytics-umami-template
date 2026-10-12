import { beforeEach, describe, expect, test, vi } from 'vitest';
import { API_KEY_PAGE_SIZE, MAX_API_KEYS_PER_USER } from '@/lib/api-key-limits';
import {
  ApiKeyCodeUsedError,
  ApiKeyLimitReachedError,
  createApiKey,
  getApiKeyByHash,
  getUserApiKeys,
} from './apiKey';

const {
  primaryFindFirstMock,
  replicaFindFirstMock,
  primaryMock,
  transactionMock,
  queryRawMock,
  createMock,
  countMock,
  findManyMock,
  findTwoFactorMock,
  deleteTwoFactorLimitMock,
  consumeOtpMock,
} = vi.hoisted(() => ({
  primaryFindFirstMock: vi.fn(),
  replicaFindFirstMock: vi.fn(),
  primaryMock: vi.fn(),
  transactionMock: vi.fn(),
  queryRawMock: vi.fn(),
  createMock: vi.fn(),
  countMock: vi.fn(),
  findManyMock: vi.fn(),
  findTwoFactorMock: vi.fn(),
  deleteTwoFactorLimitMock: vi.fn(),
  consumeOtpMock: vi.fn(),
}));

vi.mock('@/lib/two-factor/replay-prevention', () => ({ consumeOtp: consumeOtpMock }));

vi.mock('@/lib/prisma', () => ({
  default: {
    transaction: transactionMock,
    client: {
      $primary: primaryMock,
      apiKey: { findFirst: replicaFindFirstMock, findMany: findManyMock },
    },
  },
}));

describe('getApiKeyByHash', () => {
  beforeEach(() => {
    primaryFindFirstMock.mockReset().mockResolvedValue(null);
    replicaFindFirstMock.mockReset().mockResolvedValue(null);
    primaryMock.mockReset().mockReturnValue({ apiKey: { findFirst: primaryFindFirstMock } });
    transactionMock.mockReset().mockImplementation(async operation =>
      operation({
        $queryRaw: queryRawMock,
        apiKey: { create: createMock, count: countMock },
        twoFactorAuth: { findUnique: findTwoFactorMock },
        twoFactorRateLimit: { deleteMany: deleteTwoFactorLimitMock },
      }),
    );
    queryRawMock.mockReset().mockResolvedValue([{ sessionGeneration: 0 }]);
    createMock.mockReset().mockResolvedValue({ id: 'key-1' });
    findTwoFactorMock.mockReset().mockResolvedValue(null);
    deleteTwoFactorLimitMock.mockReset();
    consumeOtpMock.mockReset().mockResolvedValue(true);
  });

  test('rejects a revoked key while the replica still has it', async () => {
    replicaFindFirstMock.mockResolvedValue({ id: 'revoked-key' });

    expect(await getApiKeyByHash('hash')).toBeNull();
    expect(primaryFindFirstMock).toHaveBeenCalledWith({
      where: { keyHash: 'hash', expiresAt: { gt: expect.any(Date) } },
    });
    expect(replicaFindFirstMock).not.toHaveBeenCalled();
  });

  test('accepts a key that exists on the primary', async () => {
    const key = { id: 'active-key', keyHash: 'hash' };
    primaryFindFirstMock.mockResolvedValue(key);

    expect(await getApiKeyByHash('hash')).toEqual(key);
  });

  test('rejects expired and legacy keys without an expiration', async () => {
    const oldKey = { id: 'expired-key', expiresAt: new Date(Date.now() - 1) };
    primaryFindFirstMock.mockImplementation(async ({ where }) =>
      oldKey.expiresAt > where.expiresAt.gt ? oldKey : null,
    );

    expect(await getApiKeyByHash('hash')).toBeNull();
    expect(primaryFindFirstMock).toHaveBeenCalledWith({
      where: { keyHash: 'hash', expiresAt: { gt: expect.any(Date) } },
    });
  });
});

describe('createApiKey', () => {
  const data = {
    id: 'key-1',
    userId: '00000000-0000-4000-8000-000000000001',
    name: 'test key',
    keyHash: 'a'.repeat(128),
    keyPrefix: 'umami_test',
  };

  beforeEach(() => {
    transactionMock.mockReset().mockImplementation(async operation =>
      operation({
        $queryRaw: queryRawMock,
        apiKey: { create: createMock, count: countMock },
        twoFactorAuth: { findUnique: findTwoFactorMock },
        twoFactorRateLimit: { deleteMany: deleteTwoFactorLimitMock },
      }),
    );
    queryRawMock.mockReset().mockResolvedValue([{ sessionGeneration: 0 }]);
    createMock.mockReset().mockResolvedValue({ id: data.id });
    countMock.mockReset().mockResolvedValue(0);
    findTwoFactorMock.mockReset().mockResolvedValue(null);
    deleteTwoFactorLimitMock.mockReset();
    consumeOtpMock.mockReset().mockResolvedValue(true);
  });

  test('creates a key only while holding the current user generation lock', async () => {
    await expect(createApiKey(data, 0, 'password-hash')).resolves.toEqual({ id: data.id });

    expect(String(queryRawMock.mock.calls[0][0])).toContain('FOR UPDATE');
    expect(String(queryRawMock.mock.calls[0][0])).toContain('"password" =');
    expect(queryRawMock.mock.calls[0]).toContain('password-hash');
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ data }));
    expect(countMock).toHaveBeenCalledWith({ where: { userId: data.userId } });
    expect(queryRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      countMock.mock.invocationCallOrder[0],
    );
    expect(countMock.mock.invocationCallOrder[0]).toBeLessThan(
      createMock.mock.invocationCallOrder[0],
    );
    expect(findTwoFactorMock).toHaveBeenCalledWith({
      where: { userId: data.userId },
      select: { id: true, secret: true, isEnabled: true },
    });
  });

  test('does not create a key after a factor reset changed the generation', async () => {
    queryRawMock.mockResolvedValue([{ sessionGeneration: 1 }]);

    await expect(createApiKey(data, 0, 'password-hash')).resolves.toBeNull();
    expect(createMock).not.toHaveBeenCalled();
    expect(countMock).not.toHaveBeenCalled();
  });

  test('accepts the last available slot, then refuses the quota under the user lock', async () => {
    countMock
      .mockResolvedValueOnce(MAX_API_KEYS_PER_USER - 1)
      .mockResolvedValueOnce(MAX_API_KEYS_PER_USER);

    await expect(createApiKey(data, 0, 'password-hash')).resolves.toEqual({ id: data.id });
    await expect(createApiKey(data, 0, 'password-hash')).rejects.toBeInstanceOf(
      ApiKeyLimitReachedError,
    );
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(queryRawMock).toHaveBeenCalledTimes(2);
  });

  test('a full quota does not consume a valid one-use authenticator code', async () => {
    countMock.mockResolvedValue(MAX_API_KEYS_PER_USER);
    findTwoFactorMock.mockResolvedValue({
      id: 'factor-1',
      secret: 'encrypted-secret',
      isEnabled: true,
    });

    await expect(
      createApiKey(data, 0, 'password-hash', {
        id: 'factor-1',
        secret: 'encrypted-secret',
        token: '123456',
      }),
    ).rejects.toBeInstanceOf(ApiKeyLimitReachedError);
    expect(consumeOtpMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  test('requires a fresh one-use code when an authenticator is enrolled', async () => {
    findTwoFactorMock.mockResolvedValue({
      id: 'factor-1',
      secret: 'encrypted-secret',
      isEnabled: true,
    });
    const proof = { id: 'factor-1', secret: 'encrypted-secret', token: '123456' };

    await expect(createApiKey(data, 0, 'password-hash')).resolves.toBeNull();
    expect(createMock).not.toHaveBeenCalled();

    await expect(createApiKey(data, 0, 'password-hash', proof)).resolves.toEqual({ id: data.id });
    expect(consumeOtpMock).toHaveBeenCalledWith(data.userId, proof.token, expect.anything());
    expect(deleteTwoFactorLimitMock).toHaveBeenCalledWith({ where: { userId: data.userId } });
    expect(consumeOtpMock.mock.invocationCallOrder[0]).toBeLessThan(
      createMock.mock.invocationCallOrder[0],
    );
  });

  test('does not persist a key when the code was already consumed', async () => {
    findTwoFactorMock.mockResolvedValue({
      id: 'factor-1',
      secret: 'encrypted-secret',
      isEnabled: true,
    });
    consumeOtpMock.mockResolvedValue(false);

    await expect(
      createApiKey(data, 0, 'password-hash', {
        id: 'factor-1',
        secret: 'encrypted-secret',
        token: '123456',
      }),
    ).rejects.toBeInstanceOf(ApiKeyCodeUsedError);
    expect(createMock).not.toHaveBeenCalled();
    expect(deleteTwoFactorLimitMock).not.toHaveBeenCalled();
  });

  test('rejects an authenticator proof after factor state changes', async () => {
    findTwoFactorMock.mockResolvedValue({ id: 'factor-2', secret: 'new-secret', isEnabled: true });

    await expect(
      createApiKey(data, 0, 'password-hash', {
        id: 'factor-1',
        secret: 'old-secret',
        token: '123456',
      }),
    ).resolves.toBeNull();
    expect(consumeOtpMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
  });

  test('does not create a key after the verified password changes', async () => {
    queryRawMock.mockResolvedValue([]);

    await expect(createApiKey(data, 0, 'old-password-hash')).resolves.toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('getUserApiKeys', () => {
  beforeEach(() => {
    replicaFindFirstMock.mockReset();
    findManyMock.mockReset().mockResolvedValue([]);
  });

  test('returns a bounded first page ordered by creation and ID', async () => {
    await getUserApiKeys('user-1');

    expect(findManyMock).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        lastUsedAt: true,
        createdAt: true,
        expiresAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: API_KEY_PAGE_SIZE,
    });
  });

  test('continues from an owned cursor without an unbounded list', async () => {
    replicaFindFirstMock.mockResolvedValue({ id: 'key-50' });

    await getUserApiKeys('user-1', 'key-50');

    expect(replicaFindFirstMock).toHaveBeenCalledWith({
      where: { id: 'key-50', userId: 'user-1' },
      select: { id: true },
    });
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        take: API_KEY_PAGE_SIZE,
        cursor: { id: 'key-50' },
        skip: 1,
      }),
    );
  });

  test('rejects a foreign or missing cursor without listing any keys', async () => {
    replicaFindFirstMock.mockResolvedValue(null);

    await expect(getUserApiKeys('user-1', 'foreign-key')).resolves.toBeNull();
    expect(findManyMock).not.toHaveBeenCalled();
  });
});
