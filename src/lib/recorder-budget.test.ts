import { expect, test, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { reserveRecorderVisitKeyBudget } from './recorder-budget';

const account = {
  accountType: 'user' as const,
  accountId: '33333333-3333-4333-8333-333333333333',
};
const now = Date.parse('2026-10-09T15:30:00Z');

function transaction(responses: unknown[]) {
  const query = vi.fn().mockImplementation(async () => responses.shift());

  return {
    client: { $queryRaw: query } as unknown as Prisma.TransactionClient,
    query,
  };
}

test('different websites charge the same account-wide new-visit windows', async () => {
  for (const websiteId of [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ]) {
    const { client, query } = transaction([
      [{ chunks: 1 }],
      [{ chunks: 1 }],
      [{ requests: 1n }],
      [{ requests: 1n }],
    ]);

    expect(await reserveRecorderVisitKeyBudget(client, websiteId, now, account)).toBeNull();
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[0]).toContain(websiteId);
    expect(query.mock.calls[2]).toContain(account.accountType);
    expect(query.mock.calls[2]).toContain(`recorder-visits:${account.accountId}`);
    expect(query.mock.calls[3]).toContain(`recorder-visits:${account.accountId}`);
  }
});

test('an exhausted account minute or day budget rejects a new visit', async () => {
  for (const { responses, retryAfter, calls } of [
    { responses: [[{ chunks: 1 }], [{ chunks: 1 }], []], retryAfter: 60, calls: 3 },
    {
      responses: [[{ chunks: 1 }], [{ chunks: 1 }], [{ requests: 1n }], []],
      retryAfter: 86_400,
      calls: 4,
    },
  ]) {
    const { client, query } = transaction(responses);

    expect(
      await reserveRecorderVisitKeyBudget(
        client,
        '11111111-1111-4111-8111-111111111111',
        now,
        account,
      ),
    ).toBe(retryAfter);
    expect(query).toHaveBeenCalledTimes(calls);
  }
});
