import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getUser, getUserByUsername } from './user';

const { primaryFindUniqueMock, replicaFindUniqueMock, primaryMock } = vi.hoisted(() => ({
  primaryFindUniqueMock: vi.fn(),
  replicaFindUniqueMock: vi.fn(),
  primaryMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      $primary: primaryMock,
      user: {
        findUnique: replicaFindUniqueMock,
      },
    },
  },
}));

describe('getUserByUsername', () => {
  beforeEach(() => {
    primaryFindUniqueMock.mockReset().mockResolvedValue(null);
    replicaFindUniqueMock.mockReset().mockResolvedValue(null);
    primaryMock.mockReset().mockReturnValue({ user: { findUnique: primaryFindUniqueMock } });
  });

  test('trims and normalizes usernames to lowercase before lookup', async () => {
    await getUserByUsername('  KaKi87  ', { includePassword: true });

    expect(primaryFindUniqueMock).toHaveBeenCalledWith({
      where: {
        username: 'kaki87',
        deletedAt: null,
      },
      select: {
        id: true,
        username: true,
        password: true,
        role: true,
        createdAt: true,
        twoFactorRequired: true,
      },
    });
  });

  test('can include deleted users while still lowercasing the username', async () => {
    await getUserByUsername('KaKi87', { showDeleted: true });

    expect(primaryFindUniqueMock).toHaveBeenCalledWith({
      where: {
        username: 'kaki87',
      },
      select: {
        id: true,
        username: true,
        password: false,
        role: true,
        createdAt: true,
        twoFactorRequired: true,
      },
    });
  });

  test('uses current primary credentials and role instead of stale replica values', async () => {
    primaryFindUniqueMock.mockResolvedValue({ id: 'user-1', role: 'user', password: 'new-hash' });
    replicaFindUniqueMock.mockResolvedValue({ id: 'user-1', role: 'admin', password: 'old-hash' });

    expect(await getUserByUsername('alice', { includePassword: true })).toEqual({
      id: 'user-1',
      role: 'user',
      password: 'new-hash',
    });
    expect(replicaFindUniqueMock).not.toHaveBeenCalled();
  });

  test('rejects a deleted user even when the replica still has the account', async () => {
    replicaFindUniqueMock.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111' });

    expect(await getUser('11111111-1111-4111-8111-111111111111')).toBeNull();
    expect(primaryFindUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: '11111111-1111-4111-8111-111111111111', deletedAt: null },
      }),
    );
    expect(replicaFindUniqueMock).not.toHaveBeenCalled();
  });
});
