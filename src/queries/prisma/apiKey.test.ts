import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getApiKeyByHash } from './apiKey';

const { primaryFindUniqueMock, replicaFindUniqueMock, primaryMock } = vi.hoisted(() => ({
  primaryFindUniqueMock: vi.fn(),
  replicaFindUniqueMock: vi.fn(),
  primaryMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
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
