import { beforeEach, describe, expect, test, vi } from 'vitest';
import { DATA_TYPE } from '@/lib/constants';
import type { DynamicData } from '@/lib/types';
import { relationalQuery } from './saveSessionData';

const { executeRawMock } = vi.hoisted(() => ({
  executeRawMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      $executeRaw: executeRawMock,
    },
  },
}));

function getBulkWrite() {
  const [segments, payload, hasDistinctId, hasCreatedAt] = executeRawMock.mock.calls[0];

  return {
    query: segments.join('?'),
    rows: JSON.parse(payload) as Record<string, unknown>[],
    hasDistinctId,
    hasCreatedAt,
  };
}

describe('relationalQuery', () => {
  beforeEach(() => {
    executeRawMock.mockReset();
    executeRawMock.mockResolvedValue(1);
  });

  test('writes typed properties in one parameterized upsert', async () => {
    const createdAt = new Date('2026-07-30T10:00:00.000Z');

    await relationalQuery({
      websiteId: 'website-1',
      sessionId: 'session-1',
      sessionData: {
        plan: 'pro',
        amount: 12.5,
        joined: '2026-07-30T10:00:00.000Z',
      },
      distinctId: 'distinct-1',
      createdAt,
    });

    expect(executeRawMock).toHaveBeenCalledTimes(1);
    const { query, rows, hasDistinctId, hasCreatedAt } = getBulkWrite();
    expect(query).toContain('ON CONFLICT ("session_id", "data_key") DO UPDATE');
    expect(query).toContain('jsonb_to_recordset(?::jsonb)');
    expect(hasDistinctId).toBe(true);
    expect(hasCreatedAt).toBe(true);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      session_data_id: expect.any(String),
      website_id: 'website-1',
      session_id: 'session-1',
      data_key: 'plan',
      string_value: 'pro',
      number_value: null,
      date_value: null,
      data_type: DATA_TYPE.string,
      distinct_id: 'distinct-1',
      created_at: createdAt.toISOString(),
    });
    expect(rows[1]).toMatchObject({
      data_key: 'amount',
      string_value: '12.5000',
      number_value: 12.5,
      data_type: DATA_TYPE.number,
    });
    expect(rows[2]).toMatchObject({
      data_key: 'joined',
      date_value: createdAt.toISOString(),
      data_type: DATA_TYPE.date,
    });
  });

  test('one request with many properties still makes one database call', async () => {
    await relationalQuery({
      websiteId: 'website-1',
      sessionId: 'session-1',
      sessionData: Object.fromEntries(
        Array.from({ length: 99 }, (_, index) => [`property-${index}`, index]),
      ),
    });

    expect(executeRawMock).toHaveBeenCalledTimes(1);
    expect(getBulkWrite().rows).toHaveLength(99);
  });

  test('keeps the last value for flattened duplicate keys', async () => {
    await relationalQuery({
      websiteId: 'website-1',
      sessionId: 'session-1',
      sessionData: { 'plan.tier': 'old', plan: { tier: 'new' } } as unknown as DynamicData,
    });

    expect(getBulkWrite().rows).toHaveLength(1);
    expect(getBulkWrite().rows[0]).toMatchObject({
      data_key: 'plan.tier',
      string_value: 'new',
    });
  });

  test('preserves optional update fields when they are omitted', async () => {
    await relationalQuery({
      websiteId: 'website-1',
      sessionId: 'session-1',
      sessionData: { plan: 'pro' },
    });

    const { rows, hasDistinctId, hasCreatedAt } = getBulkWrite();
    expect(rows[0]).not.toHaveProperty('distinct_id');
    expect(rows[0]).not.toHaveProperty('created_at');
    expect(hasDistinctId).toBe(false);
    expect(hasCreatedAt).toBe(false);
  });

  test('does not call PostgreSQL for empty data', async () => {
    await relationalQuery({
      websiteId: 'website-1',
      sessionId: 'session-1',
      sessionData: {},
    });

    expect(executeRawMock).not.toHaveBeenCalled();
  });
});
