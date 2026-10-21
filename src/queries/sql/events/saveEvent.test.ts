import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { COLLECTION_TRUST_TIER, EVENT_TYPE } from '@/lib/constants';
import kafka from '@/lib/kafka';
import { type SaveEventArgs, saveEvent } from './saveEvent';
import { saveEventData } from './saveEventData';

const { insertMock, sendMessageMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  sendMessageMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: { client: {} } }));
vi.mock('@/lib/clickhouse', () => ({
  default: {
    insert: insertMock,
    getUTCString: (date?: Date) => date?.toISOString() ?? '2026-01-01T00:00:00.000Z',
  },
}));
vi.mock('@/lib/kafka', () => ({
  default: { enabled: false, sendMessage: sendMessageMock },
}));

const customEvent: SaveEventArgs = {
  websiteId: 'website-id',
  sessionId: 'session-id',
  visitId: 'visit-id',
  eventType: EVENT_TYPE.customEvent,
  trustTier: COLLECTION_TRUST_TIER.backendAuthorized,
  urlPath: '/signup',
  eventName: 'signup',
  eventData: { plan: 'pro' },
};

beforeEach(() => {
  insertMock.mockReset();
  sendMessageMock.mockReset();
  kafka.enabled = false;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test('writes backend provenance to both PostgreSQL event tables', async () => {
  const createEvent = vi.fn();
  const createData = vi.fn();
  const transaction = {
    websiteEvent: { create: createEvent },
    eventData: { createMany: createData },
  };

  await saveEvent(customEvent, transaction as never);

  expect(createEvent).toHaveBeenCalledWith({
    data: expect.objectContaining({
      eventType: EVENT_TYPE.customEvent,
      trustTier: COLLECTION_TRUST_TIER.backendAuthorized,
    }),
  });
  expect(createData).toHaveBeenCalledWith({
    data: [
      expect.objectContaining({
        websiteEventId: createEvent.mock.calls[0][0].data.id,
        dataKey: 'plan',
        trustTier: COLLECTION_TRUST_TIER.backendAuthorized,
      }),
    ],
  });
});

test.each([false, true])(
  'writes backend provenance to ClickHouse transport with Kafka %s',
  async enabled => {
    vi.stubEnv('CLICKHOUSE_URL', 'http://localhost:8123/umami');
    kafka.enabled = enabled;

    await saveEvent(customEvent);

    const messages = enabled ? sendMessageMock.mock.calls : insertMock.mock.calls;
    expect(messages).toHaveLength(2);
    const eventMessage = enabled ? messages[1][1] : messages[1][1][0];
    expect(eventMessage).toEqual(expect.objectContaining({ trust_tier: 1, event_type: 2 }));
    expect(messages[0][1][0]).toEqual(expect.objectContaining({ trust_tier: 1, data_key: 'plan' }));
  },
);

test.each([false, true])(
  'does not publish a trusted ClickHouse event when Kafka %s property delivery fails',
  async enabled => {
    vi.stubEnv('CLICKHOUSE_URL', 'http://localhost:8123/umami');
    kafka.enabled = enabled;
    const transport = enabled ? sendMessageMock : insertMock;
    transport.mockRejectedValueOnce(new Error('Synthetic property sink failure'));

    await expect(saveEvent(customEvent)).rejects.toThrow('Synthetic property sink failure');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(
      'event_data',
      expect.arrayContaining([expect.objectContaining({ trust_tier: 1, data_key: 'plan' })]),
    );
  },
);

test.each([false, true])(
  'leaves only orphan properties when Kafka %s parent delivery fails after properties',
  async enabled => {
    vi.stubEnv('CLICKHOUSE_URL', 'http://localhost:8123/umami');
    kafka.enabled = enabled;
    const transport = enabled ? sendMessageMock : insertMock;
    transport
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('Synthetic parent sink failure'));

    await expect(saveEvent(customEvent)).rejects.toThrow('Synthetic parent sink failure');
    expect(transport.mock.calls.map(call => call[0])).toEqual([
      'event_data',
      enabled ? 'event' : 'website_event',
    ]);
  },
);

test.each([false, true])('preserves property-free custom events with Kafka %s', async enabled => {
  vi.stubEnv('CLICKHOUSE_URL', 'http://localhost:8123/umami');
  kafka.enabled = enabled;

  await saveEvent({ ...customEvent, eventData: undefined });

  const transport = enabled ? sendMessageMock : insertMock;
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport).toHaveBeenCalledWith(
    enabled ? 'event' : 'website_event',
    enabled
      ? expect.objectContaining({ trust_tier: 1, event_type: 2 })
      : expect.arrayContaining([expect.objectContaining({ trust_tier: 1, event_type: 2 })]),
  );
});

describe('provenance guard', () => {
  test('rejects a custom event without backend provenance before writing', async () => {
    await expect(saveEvent({ ...customEvent, trustTier: 0 })).rejects.toThrow(
      'Event collection provenance is invalid.',
    );
    expect(insertMock).not.toHaveBeenCalled();
  });

  test('rejects a pageview falsely marked as backend authorized', async () => {
    await expect(
      saveEvent({
        ...customEvent,
        eventType: EVENT_TYPE.pageView,
        trustTier: 1,
        eventData: undefined,
      }),
    ).rejects.toThrow('Event collection provenance is invalid.');
    expect(insertMock).not.toHaveBeenCalled();
  });

  test.each([
    { enabled: false, revenueKey: 'TOTAL_REVENUE' },
    { enabled: true, revenueKey: 'TOTAL_REVENUE' },
    { enabled: false, revenueKey: 'grossrevenue' },
    { enabled: true, revenueKey: 'grossrevenue' },
    { enabled: false, revenueKey: 'total' },
    { enabled: true, revenueKey: 'amount' },
  ])(
    'rejects nested $revenueKey at the event sink with Kafka $enabled',
    async ({ enabled, revenueKey }) => {
      kafka.enabled = enabled;

      await expect(
        saveEvent({
          ...customEvent,
          eventData: { order: { [revenueKey]: 42 } },
        }),
      ).rejects.toThrow('Verified revenue collection is not enabled.');
      expect(insertMock).not.toHaveBeenCalled();
      expect(sendMessageMock).not.toHaveBeenCalled();
    },
  );

  test('rejects direct revenue property writes before database or Kafka access', async () => {
    await expect(
      saveEventData({
        websiteId: customEvent.websiteId,
        eventId: 'event-id',
        eventData: { order: { currency: 'USD' } } as never,
        trustTier: COLLECTION_TRUST_TIER.backendAuthorized,
      }),
    ).rejects.toThrow('Verified revenue collection is not enabled.');
    expect(insertMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test('rejects a purchase price at both event sinks before storage access', async () => {
    await expect(
      saveEvent({ ...customEvent, eventName: 'purchase', eventData: { price: 42 } }),
    ).rejects.toThrow('Verified revenue collection is not enabled.');
    await expect(
      saveEventData({
        websiteId: customEvent.websiteId,
        eventId: 'event-id',
        eventName: 'purchase',
        eventData: { price: 42 },
        trustTier: COLLECTION_TRUST_TIER.backendAuthorized,
      }),
    ).rejects.toThrow('Verified revenue collection is not enabled.');
    expect(insertMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
