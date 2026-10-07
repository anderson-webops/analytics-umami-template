import { expect, test, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import {
  HeatmapBudgetExceededError,
  MAX_HEATMAP_VISIT_BYTES,
  MAX_HEATMAP_VISIT_EVENTS,
  reserveHeatmapBudget,
} from './heatmap-budget';

const args = {
  websiteId: '11111111-1111-4111-8111-111111111111',
  visitId: '22222222-2222-4222-8222-222222222222',
  bytes: 100,
  events: 2,
};

function transaction(responses: unknown[]) {
  const query = vi.fn().mockImplementation(async () => responses.shift());
  const execute = vi.fn().mockResolvedValue(0);

  return {
    client: { $queryRaw: query, $executeRaw: execute } as unknown as Prisma.TransactionClient,
    query,
    execute,
  };
}

test('rejects invalid or oversized heatmap chunks before database access', async () => {
  const { client, query } = transaction([]);

  for (const input of [
    { bytes: 0 },
    { events: 0 },
    { bytes: MAX_HEATMAP_VISIT_BYTES + 1 },
    { events: MAX_HEATMAP_VISIT_EVENTS + 1 },
    { bytes: Number.NaN },
  ]) {
    await expect(reserveHeatmapBudget(client, { ...args, ...input })).rejects.toBeInstanceOf(
      HeatmapBudgetExceededError,
    );
  }

  expect(query).not.toHaveBeenCalled();
});

test('rejects an exhausted visit without reserving source windows', async () => {
  const { client, query, execute } = transaction([[]]);

  await expect(reserveHeatmapBudget(client, args)).rejects.toMatchObject({
    retryAfter: undefined,
  });
  expect(query).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
});

test('rejects exhausted source windows with bounded retry intervals', async () => {
  const minute = transaction([[{ bytes: 100n }], []]);
  await expect(reserveHeatmapBudget(minute.client, args)).rejects.toMatchObject({
    retryAfter: 60,
  });
  expect(minute.query).toHaveBeenCalledTimes(2);
  expect(minute.execute).not.toHaveBeenCalled();

  const day = transaction([[{ bytes: 100n }], [{ bytes: 100n }], []]);
  await expect(reserveHeatmapBudget(day.client, args)).rejects.toMatchObject({
    retryAfter: 86_400,
  });
  expect(day.query).toHaveBeenCalledTimes(3);
  expect(day.execute).not.toHaveBeenCalled();
});

test('reserves visit and source windows under separate heatmap keys', async () => {
  const { client, query, execute } = transaction([
    [{ bytes: 100n }],
    [{ bytes: 100n }],
    [{ bytes: 100n }],
  ]);

  await reserveHeatmapBudget(client, args);

  expect(query).toHaveBeenCalledTimes(3);
  expect(execute).toHaveBeenCalledOnce();
  const keys = query.mock.calls.map(([, , , key]) => key);
  expect(keys[0]).toBe(`heatmap:${args.visitId}`);
  expect(keys[1]).toMatch(/^heatmap:\d{4}-\d\d-\d\dT\d\d:\d\d:00\.000Z$/);
  expect(keys[2]).toMatch(/^heatmap:\d{4}-\d\d-\d\dT00:00:00\.000Z$/);
  const visitExpiry = query.mock.calls[0].find(value => value instanceof Date);
  expect(visitExpiry).toBeInstanceOf(Date);
  expect(visitExpiry.getTime()).toBeGreaterThan(Date.now() + 37 * 24 * 60 * 60 * 1000);
  expect(visitExpiry.getTime()).toBeLessThan(Date.now() + 39 * 24 * 60 * 60 * 1000);
});
