import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { COLLECTION_TRUST_TIER, DATA_TYPE } from '@/lib/constants';
import kafka from '@/lib/kafka';
import type { DynamicData } from '@/lib/types';
import { relationalQuery, saveSessionData } from './saveSessionData';

const { executeRawMock, insertMock, sendMessageMock } = vi.hoisted(() => ({
  executeRawMock: vi.fn(),
  insertMock: vi.fn(),
  sendMessageMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    client: {
      $executeRaw: executeRawMock,
    },
  },
}));
vi.mock('@/lib/clickhouse', () => ({
  default: {
    insert: insertMock,
    getUTCString: (date?: Date) => date?.toISOString() ?? '2026-01-01T00:00:00.000Z',
  },
}));
vi.mock('@/lib/kafka', () => ({
  default: { enabled: false, sendMessage: sendMessageMock },
}));

afterEach(() => {
  kafka.enabled = false;
  vi.unstubAllEnvs();
});

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
      trustTier: COLLECTION_TRUST_TIER.backendAuthorized,
      distinctId: 'distinct-1',
      createdAt,
    });

    expect(executeRawMock).toHaveBeenCalledTimes(1);
    const { query, rows, hasDistinctId, hasCreatedAt } = getBulkWrite();
    expect(query).toContain('ON CONFLICT ("session_id", "data_key") DO UPDATE');
    expect(query).toContain('"trust_tier" = EXCLUDED."trust_tier"');
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
      trust_tier: COLLECTION_TRUST_TIER.backendAuthorized,
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
      trustTier: COLLECTION_TRUST_TIER.backendAuthorized,
    });

    expect(executeRawMock).toHaveBeenCalledTimes(1);
    expect(getBulkWrite().rows).toHaveLength(99);
  });

  test('keeps the last value for flattened duplicate keys', async () => {
    await relationalQuery({
      websiteId: 'website-1',
      sessionId: 'session-1',
      sessionData: { 'plan.tier': 'old', plan: { tier: 'new' } } as unknown as DynamicData,
      trustTier: COLLECTION_TRUST_TIER.backendAuthorized,
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
      trustTier: COLLECTION_TRUST_TIER.backendAuthorized,
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
      trustTier: COLLECTION_TRUST_TIER.backendAuthorized,
    });

    expect(executeRawMock).not.toHaveBeenCalled();
  });

  test('rejects a missing or unverified provenance before writing', async () => {
    await expect(
      relationalQuery({
        websiteId: 'website-1',
        sessionId: 'session-1',
        sessionData: { plan: 'pro' },
        trustTier:
          COLLECTION_TRUST_TIER.unverified as typeof COLLECTION_TRUST_TIER.backendAuthorized,
      }),
    ).rejects.toThrow('Session property provenance is required.');

    expect(executeRawMock).not.toHaveBeenCalled();
  });

  test('rejects nested revenue properties at the direct PostgreSQL sink', async () => {
    await expect(
      relationalQuery({
        websiteId: 'website-1',
        sessionId: 'session-1',
        sessionData: { order: { TOTAL_REVENUE: 42 } } as unknown as DynamicData,
        trustTier: COLLECTION_TRUST_TIER.backendAuthorized,
      }),
    ).rejects.toThrow('Verified revenue collection is not enabled.');

    expect(executeRawMock).not.toHaveBeenCalled();
  });

  test('preserves unrelated concurrency properties in PostgreSQL', async () => {
    await relationalQuery({
      websiteId: 'website-1',
      sessionId: 'session-1',
      sessionData: { concurrencyLimit: 8 },
      trustTier: COLLECTION_TRUST_TIER.backendAuthorized,
    });

    expect(getBulkWrite().rows).toEqual([
      expect.objectContaining({ data_key: 'concurrencyLimit', number_value: 8 }),
    ]);
  });
});

test.each([false, true])(
  'ClickHouse mode includes provenance with Kafka enabled=%s',
  async enabled => {
    vi.stubEnv('CLICKHOUSE_URL', 'http://synthetic.invalid:8123/analytics');
    kafka.enabled = enabled;
    insertMock.mockReset();
    sendMessageMock.mockReset();

    const payload = {
      websiteId: 'website-1',
      sessionId: 'session-1',
      sessionData: { plan: 'pro', concurrencyLimit: 8 },
      trustTier: COLLECTION_TRUST_TIER.backendAuthorized,
      createdAt: new Date('2026-10-17T00:00:00.000Z'),
    };

    await saveSessionData(payload);

    const sink = enabled ? sendMessageMock : insertMock;
    const unusedSink = enabled ? insertMock : sendMessageMock;
    expect(sink).toHaveBeenCalledWith('session_data', [
      expect.objectContaining({
        data_key: 'plan',
        string_value: 'pro',
        trust_tier: COLLECTION_TRUST_TIER.backendAuthorized,
      }),
      expect.objectContaining({
        data_key: 'concurrencyLimit',
        number_value: 8,
        trust_tier: COLLECTION_TRUST_TIER.backendAuthorized,
      }),
    ]);
    expect(unusedSink).not.toHaveBeenCalled();

    await expect(
      saveSessionData({
        ...payload,
        trustTier:
          COLLECTION_TRUST_TIER.unverified as typeof COLLECTION_TRUST_TIER.backendAuthorized,
      }),
    ).rejects.toThrow('Session property provenance is required.');
    expect(sink).toHaveBeenCalledTimes(1);
  },
);

test.each([false, true])(
  'rejects session revenue before ClickHouse or Kafka delivery with Kafka enabled=%s',
  async enabled => {
    vi.stubEnv('CLICKHOUSE_URL', 'http://synthetic.invalid:8123/analytics');
    kafka.enabled = enabled;
    insertMock.mockReset();
    sendMessageMock.mockReset();

    await expect(
      saveSessionData({
        websiteId: 'website-1',
        sessionId: 'session-1',
        sessionData: { order: { currency: 'USD', amount: 42 } } as unknown as DynamicData,
        trustTier: COLLECTION_TRUST_TIER.backendAuthorized,
      }),
    ).rejects.toThrow('Verified revenue collection is not enabled.');

    expect(insertMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  },
);
