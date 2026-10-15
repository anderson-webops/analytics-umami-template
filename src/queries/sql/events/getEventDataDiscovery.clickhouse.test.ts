import { createClient } from '@clickhouse/client';
import { expect, test } from 'vitest';

const integrationTest = process.env.CLICKHOUSE_TEST_URL ? test : test.skip;

integrationTest(
  'ClickHouse metadata discovery preserves selected events and rejects excess groups',
  async () => {
    const url = new URL(process.env.CLICKHOUSE_TEST_URL ?? '');
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toBe('/umami_event_series_test');
    expect(process.env.CLICKHOUSE_URL).toBe(url.toString());

    const client = createClient({ url: url.toString() });
    const websiteId = '4a147eee-7e6d-4d73-b4a0-f50d06a52000';
    const attackWebsiteId = '4a147eee-7e6d-4d73-b4a0-f50d06a52001';
    const sessionId = '4a147eee-7e6d-4d73-b4a0-f50d06a52002';
    const attackSessionId = '4a147eee-7e6d-4d73-b4a0-f50d06a52003';
    const purchaseEventId = '4a147eee-7e6d-4d73-b4a0-f50d06a52004';
    const attackEventId = '4a147eee-7e6d-4d73-b4a0-f50d06a52005';
    const createdAt = '2026-10-15 12:00:00';
    const filters = {
      startDate: new Date('2026-10-15T00:00:00Z'),
      endDate: new Date('2026-10-16T00:00:00Z'),
    };

    try {
      await client.command({
        query: `CREATE TABLE website_event (
          website_id UUID, session_id UUID, event_id UUID, event_name String,
          event_type UInt32, is_bot UInt8, created_at DateTime('UTC')
        ) ENGINE = MergeTree ORDER BY (website_id, created_at, event_id)`,
      });
      await client.command({
        query: `CREATE TABLE event_data (
          website_id UUID, session_id UUID, event_id UUID, event_name String,
          data_key String, data_type UInt32, string_value Nullable(String),
          date_value Nullable(DateTime('UTC')), created_at DateTime('UTC')
        ) ENGINE = MergeTree ORDER BY (website_id, event_id, data_key)`,
      });
      await client.command({
        query: `CREATE TABLE session_data (
          website_id UUID, session_id UUID, data_key String, data_type UInt32,
          string_value Nullable(String), date_value Nullable(DateTime('UTC')),
          created_at DateTime('UTC')
        ) ENGINE = ReplacingMergeTree ORDER BY (website_id, session_id, data_key)`,
      });
      await client.insert({
        table: 'website_event',
        format: 'JSONEachRow',
        values: [
          {
            website_id: websiteId,
            session_id: sessionId,
            event_id: purchaseEventId,
            event_name: 'purchase',
            event_type: 2,
            is_bot: 0,
            created_at: createdAt,
          },
          {
            website_id: attackWebsiteId,
            session_id: attackSessionId,
            event_id: attackEventId,
            event_name: 'attack',
            event_type: 2,
            is_bot: 0,
            created_at: createdAt,
          },
        ],
      });
      await client.insert({
        table: 'event_data',
        format: 'JSONEachRow',
        values: [
          {
            website_id: websiteId,
            session_id: sessionId,
            event_id: purchaseEventId,
            event_name: 'purchase',
            data_key: 'currency',
            data_type: 1,
            string_value: 'USD',
            created_at: createdAt,
          },
        ],
      });
      await client.insert({
        table: 'session_data',
        format: 'JSONEachRow',
        values: [
          {
            website_id: websiteId,
            session_id: sessionId,
            data_key: 'category',
            data_type: 1,
            string_value: 'vip',
            created_at: createdAt,
          },
        ],
      });

      const { getEventDataFields } = await import('./getEventDataFields');
      const { getEventDataEvents } = await import('./getEventDataEvents');
      const { getEventDataProperties } = await import('./getEventDataProperties');
      const { getEventDataValues } = await import('./getEventDataValues');
      const { getSessionDataProperties } = await import('../sessions/getSessionDataProperties');
      const { getSessionDataValues } = await import('../sessions/getSessionDataValues');
      const { DiscoveryRangeTooBroadError } = await import('./discoveryError');

      expect(await getEventDataFields(websiteId, 'purchase', filters)).toEqual([
        { propertyName: 'currency', dataType: 1, total: 1 },
      ]);
      expect(
        await getEventDataEvents(websiteId, { ...filters, event: 'eq.purchase' }),
      ).toHaveLength(1);
      expect(await getEventDataProperties(websiteId, filters)).toHaveLength(1);
      expect(
        await getEventDataValues(websiteId, 'purchase', {
          ...filters,
          propertyName: 'currency',
          dataType: 1,
        }),
      ).toEqual([{ value: 'USD', total: 1 }]);
      expect(await getSessionDataProperties(websiteId, filters)).toEqual([
        { propertyName: 'category', dataType: 1, total: 1 },
      ]);
      expect(
        await getSessionDataValues(websiteId, {
          ...filters,
          propertyName: 'category',
        }),
      ).toEqual([{ value: 'vip', total: 1 }]);

      await client.command({
        query: `INSERT INTO event_data
          (website_id, session_id, event_id, event_name, data_key,
           data_type, string_value, created_at)
          SELECT {websiteId:UUID}, {sessionId:UUID}, {eventId:UUID}, 'attack',
            concat('key-', toString(number)), 1, toString(number),
            toDateTime('2026-10-15 12:00:00')
          FROM numbers(50001)`,
        query_params: {
          websiteId: attackWebsiteId,
          sessionId: attackSessionId,
          eventId: attackEventId,
        },
      });
      await expect(getEventDataFields(attackWebsiteId, 'attack', filters)).rejects.toBeInstanceOf(
        DiscoveryRangeTooBroadError,
      );
      await expect(getEventDataProperties(attackWebsiteId, filters)).rejects.toBeInstanceOf(
        DiscoveryRangeTooBroadError,
      );

      await client.command({
        query: `INSERT INTO event_data
          (website_id, session_id, event_id, event_name, data_key,
           data_type, string_value, created_at)
          SELECT {websiteId:UUID}, {sessionId:UUID}, {eventId:UUID}, 'attack',
            'high-value', 1, toString(number), toDateTime('2026-10-15 12:00:00')
          FROM numbers(50001)`,
        query_params: {
          websiteId: attackWebsiteId,
          sessionId: attackSessionId,
          eventId: attackEventId,
        },
      });
      await expect(
        getEventDataValues(attackWebsiteId, 'attack', {
          ...filters,
          propertyName: 'high-value',
          dataType: 1,
        }),
      ).rejects.toBeInstanceOf(DiscoveryRangeTooBroadError);

      await client.command({
        query: `INSERT INTO session_data
          (website_id, session_id, data_key, data_type, string_value, created_at)
          SELECT {websiteId:UUID}, {sessionId:UUID},
            concat('key-', toString(number)), 1, toString(number),
            toDateTime('2026-10-15 12:00:00')
          FROM numbers(50001)`,
        query_params: { websiteId: attackWebsiteId, sessionId: attackSessionId },
      });
      await expect(getSessionDataProperties(attackWebsiteId, filters)).rejects.toBeInstanceOf(
        DiscoveryRangeTooBroadError,
      );
    } finally {
      await client.command({ query: 'DROP TABLE IF EXISTS session_data' });
      await client.command({ query: 'DROP TABLE IF EXISTS event_data' });
      await client.command({ query: 'DROP TABLE IF EXISTS website_event' });
      await client.close();
    }
  },
  90_000,
);
