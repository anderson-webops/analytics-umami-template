import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createApiKey, getApiKeyByHash } from './apiKey';

const {
  primaryFindUniqueMock,
  replicaFindUniqueMock,
  primaryMock,
  transactionMock,
  queryRawMock,
  createMock,
} = vi.hoisted(() => ({
  primaryFindUniqueMock: vi.fn(),
  replicaFindUniqueMock: vi.fn(),
  primaryMock: vi.fn(),
  transactionMock: vi.fn(),
  queryRawMock: vi.fn(),
  createMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    transaction: transactionMock,
    client: {
      $primary: primaryMock,
      apiKey: { findUnique: replicaFindUniqueMock },
    },
  },
}));

describe('getApiKeyByHash', () => {
  beforeEach(() => {
    primaryFindUniqueMock.mockReset().mockResolvedValue(null);
    replicaFindUniqueMock.mockReset().mockResolvedValue(null);
    primaryMock.mockReset().mockReturnValue({ apiKey: { findUnique: primaryFindUniqueMock } });
    transactionMock
      .mockReset()
      .mockImplementation(async operation =>
        operation({ $queryRaw: queryRawMock, apiKey: { create: createMock } }),
      );
    queryRawMock.mockReset().mockResolvedValue([{ sessionGeneration: 0 }]);
    createMock.mockReset().mockResolvedValue({ id: 'key-1' });
  });

  test('rejects a revoked key while the replica still has it', async () => {
    replicaFindUniqueMock.mockResolvedValue({ id: 'revoked-key' });

    expect(await getApiKeyByHash('hash')).toBeNull();
    expect(primaryFindUniqueMock).toHaveBeenCalledWith({ where: { keyHash: 'hash' } });
    expect(replicaFindUniqueMock).not.toHaveBeenCalled();
  });

  test('accepts a key that exists on the primary', async () => {
    const key = { id: 'active-key', keyHash: 'hash' };
    primaryFindUniqueMock.mockResolvedValue(key);

    expect(await getApiKeyByHash('hash')).toEqual(key);
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
    transactionMock
      .mockReset()
      .mockImplementation(async operation =>
        operation({ $queryRaw: queryRawMock, apiKey: { create: createMock } }),
      );
    queryRawMock.mockReset().mockResolvedValue([{ sessionGeneration: 0 }]);
    createMock.mockReset().mockResolvedValue({ id: data.id });
  });

  test('creates a key only while holding the current user generation lock', async () => {
    await expect(createApiKey(data, 0, 'password-hash')).resolves.toEqual({ id: data.id });

    expect(String(queryRawMock.mock.calls[0][0])).toContain('FOR UPDATE');
    expect(String(queryRawMock.mock.calls[0][0])).toContain('"password" =');
    expect(queryRawMock.mock.calls[0]).toContain('password-hash');
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ data }));
  });

  test('does not create a key after a factor reset changed the generation', async () => {
    queryRawMock.mockResolvedValue([{ sessionGeneration: 1 }]);

    await expect(createApiKey(data, 0, 'password-hash')).resolves.toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });

  test('does not create a key after the verified password changes', async () => {
    queryRawMock.mockResolvedValue([]);

    await expect(createApiKey(data, 0, 'old-password-hash')).resolves.toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });
});
