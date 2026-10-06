import type { UmamiClient } from '@umami/api-client';
import { expect, test, vi } from 'vitest';
import { silentLogger } from '../lib/logger';
import { getGoals } from './goals';

const WEBSITE_ID = '6f2a7e0e-2b0f-4b3f-9f0a-1234567890ab';

function createClient(goalCount: number) {
  const rows = Array.from({ length: goalCount }, (_, index) => ({
    id: `1a2b3c4d-0000-4000-8000-${String(index).padStart(12, '0')}`,
    name: `Goal ${index}`,
  }));
  let active = 0;
  let peak = 0;
  const getWebsiteGoals = vi.fn(async () => ({ data: rows, count: rows.length, page: 1 }));
  const getWebsiteSavedGoalStats = vi.fn(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active -= 1;
    return { num: 2, total: 10 };
  });
  const client = { getWebsiteGoals, getWebsiteSavedGoalStats } as unknown as UmamiClient;

  return {
    client,
    getWebsiteGoals,
    getWebsiteSavedGoalStats,
    get peak() {
      return peak;
    },
  };
}

test('goal statistics stay within a bounded query fanout', async () => {
  const mock = createClient(20);

  const result = await getGoals.handler(
    { websiteId: WEBSITE_ID, startAt: '2026-01-01', endAt: '2026-02-01' },
    { client: mock.client, logger: silentLogger },
  );

  expect(mock.getWebsiteSavedGoalStats).toHaveBeenCalledTimes(20);
  expect(mock.peak).toBeLessThanOrEqual(4);
  expect((result.goals as { id: string; results: { conversionRate: number } }[])[19]).toEqual({
    id: '1a2b3c4d-0000-4000-8000-000000000019',
    name: 'Goal 19',
    description: null,
    type: null,
    value: null,
    createdAt: null,
    results: { conversions: 2, visitors: 10, conversionRate: 20 },
  });
});

test('large statistics pages and multi-year ranges fail before fetching goals', async () => {
  const mock = createClient(100);
  const context = { client: mock.client, logger: silentLogger };

  await expect(
    getGoals.handler(
      { websiteId: WEBSITE_ID, startAt: '2026-01-01', endAt: '2026-02-01', pageSize: 100 },
      context,
    ),
  ).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(
    getGoals.handler(
      { websiteId: WEBSITE_ID, startAt: '2024-01-01', endAt: '2026-02-01' },
      context,
    ),
  ).rejects.toMatchObject({ code: 'invalid_date_range' });
  expect(mock.getWebsiteGoals).not.toHaveBeenCalled();
  expect(mock.getWebsiteSavedGoalStats).not.toHaveBeenCalled();
});

test('listing 100 goals without statistics keeps the existing page size', async () => {
  const mock = createClient(100);

  const result = await getGoals.handler(
    { websiteId: WEBSITE_ID, pageSize: 100 },
    { client: mock.client, logger: silentLogger },
  );

  expect(result.goals as unknown[]).toHaveLength(100);
  expect(mock.getWebsiteSavedGoalStats).not.toHaveBeenCalled();
});

test('a single selected goal remains available from a large page', async () => {
  const mock = createClient(100);

  const result = await getGoals.handler(
    {
      websiteId: WEBSITE_ID,
      goalId: '1a2b3c4d-0000-4000-8000-000000000019',
      startAt: '2026-01-01',
      endAt: '2026-02-01',
      pageSize: 100,
    },
    { client: mock.client, logger: silentLogger },
  );

  expect(result.goals as unknown[]).toHaveLength(1);
  expect(mock.getWebsiteSavedGoalStats).toHaveBeenCalledTimes(1);
});

test('an oversized API response cannot bypass the statistics page bound', async () => {
  const mock = createClient(21);

  await expect(
    getGoals.handler(
      { websiteId: WEBSITE_ID, startAt: '2026-01-01', endAt: '2026-02-01' },
      { client: mock.client, logger: silentLogger },
    ),
  ).rejects.toMatchObject({ code: 'invalid_input' });
  expect(mock.getWebsiteSavedGoalStats).not.toHaveBeenCalled();
});
