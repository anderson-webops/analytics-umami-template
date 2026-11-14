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

test.each(['owner', 'generation', 'deleted'] as const)(
  'error collection rejects a changed %s before any persistence callback',
  async transition => {
    const source = { id: sourceId, userId: firstOwnerId, teamId: null, collectionGeneration: 0 };
    let active = true;
    const transaction = {
      $queryRaw: vi.fn(async () => []),
      website: { findFirst: vi.fn(async () => (active ? source : null)) },
    };
    transactionMock.mockImplementation(async operation => operation(transaction));
    reserveBudgetMock.mockClear();
    reserveSourceLimitMock.mockClear();
    const payload = { id: undefined, stack: 'synthetic', tags: {} };
    const body = { type: 'error' as const, payload };
    const admission = await reserveActiveCollectionBudget('website', sourceId, body, '192.0.2.10');
    expect(reserveBudgetMock).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ accountId: firstOwnerId }),
      {
        bytes: Buffer.byteLength(JSON.stringify(body), 'utf8') + 3 * 512,
        rows: 3,
        requests: 1,
      },
      'anonymous',
    );
    if (transition === 'owner') source.userId = secondOwnerId;
    if (transition === 'generation') source.collectionGeneration++;
    if (transition === 'deleted') active = false;
    const write = vi.fn(async () => 'written');
    await expect(
      withActiveCollectionSource('website', sourceId, write, undefined, admission),
    ).rejects.toThrow(
      transition === 'deleted' ? 'COLLECTION_SOURCE_NOT_FOUND' : 'COLLECTION_SOURCE_CHANGED',
    );
    expect(write).not.toHaveBeenCalled();
  },
);
