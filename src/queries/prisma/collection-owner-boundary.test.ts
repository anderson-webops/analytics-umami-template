import { expect, test, vi } from 'vitest';
import { reserveActiveCollectionBudget, withActiveCollectionSource } from './collection';

const { transactionMock, reserveBudgetMock, reserveSourceLimitMock } = vi.hoisted(() => ({
  transactionMock: vi.fn(),
  reserveBudgetMock: vi.fn(),
  reserveSourceLimitMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: { transaction: transactionMock } }));
vi.mock('@/lib/collection-budget', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/collection-budget')>()),
  reserveCollectionBudget: reserveBudgetMock,
}));
vi.mock('@/lib/collection-rate-limit', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/collection-rate-limit')>()),
  reserveCollectionSourceLimit: reserveSourceLimitMock,
}));

const sourceId = '11111111-1111-4111-8111-111111111111';
const firstOwnerId = '22222222-2222-4222-8222-222222222222';
const secondOwnerId = '33333333-3333-4333-8333-333333333333';

test.each(['link', 'pixel'] as const)(
  '%s collection rejects a changed owner between admission and write',
  async sourceType => {
    const source = { id: sourceId, userId: firstOwnerId, teamId: null };
    const transaction = {
      $queryRaw: vi.fn(async () => []),
      link: { findFirst: vi.fn(async () => source) },
      pixel: { findFirst: vi.fn(async () => source) },
    };
    transactionMock.mockImplementation(async operation => operation(transaction));
    reserveBudgetMock.mockClear();
    reserveSourceLimitMock.mockClear();

    const admission = await reserveActiveCollectionBudget(
      sourceType,
      sourceId,
      { type: 'event', payload: {} },
      '192.0.2.10',
    );
    expect(reserveBudgetMock).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ accountType: 'user', accountId: firstOwnerId }),
      expect.any(Object),
      'anonymous',
    );

    source.userId = secondOwnerId;
    const write = vi.fn(async () => 'written');
    await expect(
      withActiveCollectionSource(sourceType, sourceId, write, undefined, admission),
    ).rejects.toThrow('COLLECTION_SOURCE_CHANGED');
    expect(write).not.toHaveBeenCalled();

    source.userId = firstOwnerId;
    await expect(
      withActiveCollectionSource(sourceType, sourceId, write, undefined, admission),
    ).resolves.toBe('written');
    expect(write).toHaveBeenCalledOnce();
  },
);
