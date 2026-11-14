import { beforeEach, expect, test, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { CollectionBudgetExceededError } from '@/lib/collection-budget';
import type { ErrorPayload } from '@/lib/errors/schema';
import { consumeErrorQuota, saveError } from '@/queries/sql/errors/store';
import { collectError } from './collect';

vi.mock('@/queries/sql/errors/store', () => ({ consumeErrorQuota: vi.fn(), saveError: vi.fn() }));

const transaction = {} as Prisma.TransactionClient;
const context = { sessionId: 'session', visitId: 'visit' };
const payload = { website: 'website' } as ErrorPayload;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(consumeErrorQuota).mockResolvedValue(true);
  vi.mocked(saveError).mockResolvedValue({ eventId: 'event', issueId: 'issue' });
});

test('charges the quota and persists using the guarded source transaction', async () => {
  await expect(collectError(payload, context, transaction)).resolves.toEqual({
    eventId: 'event',
    issueId: 'issue',
  });
  expect(consumeErrorQuota).toHaveBeenCalledWith(payload.website, transaction);
  expect(saveError).toHaveBeenCalledWith(payload, context, transaction);
  expect(vi.mocked(consumeErrorQuota).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(saveError).mock.invocationCallOrder[0],
  );
});

test('quota exhaustion aborts persistence with a bounded retry', async () => {
  vi.mocked(consumeErrorQuota).mockResolvedValue(false);
  await expect(collectError(payload, context, transaction)).rejects.toEqual(
    new CollectionBudgetExceededError(60),
  );
  expect(saveError).not.toHaveBeenCalled();
});

test('quota failures abort the transaction instead of accepting an uncharged event', async () => {
  vi.mocked(consumeErrorQuota).mockRejectedValue(new Error('Synthetic database failure'));
  await expect(collectError(payload, context, transaction)).rejects.toThrow(
    'Synthetic database failure',
  );
  expect(saveError).not.toHaveBeenCalled();
});
