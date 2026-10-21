import { createClient } from '@clickhouse/client';
import { expect, test } from 'vitest';
import { DATA_TYPE, OPERATORS } from '@/lib/constants';

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
    const repeatedWebsiteId = '4a147eee-7e6d-4d73-b4a0-f50d06a52006';
    const sessionId = '4a147eee-7e6d-4d73-b4a0-f50d06a52002';
    const attackSessionId = '4a147eee-7e6d-4d73-b4a0-f50d06a52003';
    const repeatedSessionId = '4a147eee-7e6d-4d73-b4a0-f50d06a52007';
    const purchaseEventId = '4a147eee-7e6d-4d73-b4a0-f50d06a52004';
    const attackEventId = '4a147eee-7e6d-4d73-b4a0-f50d06a52005';
    const repeatedEventId = '4a147eee-7e6d-4d73-b4a0-f50d06a52008';
    const legacyEventId = '4a147eee-7e6d-4d73-b4a0-f50d06a52009';
    const createdAt = '2026-10-15 12:00:00';
    const filters = {
      startDate: new Date('2026-10-15T00:00:00Z'),
      endDate: new Date('2026-10-16T00:00:00Z'),
    };

    try {
      await client.command({
        query: `CREATE TABLE website_event (
          website_id UUID, session_id UUID, event_id UUID, event_name String,
          event_type UInt32, is_bot UInt8, created_at DateTime('UTC'),
          trust_tier UInt8 DEFAULT 0, url_path String DEFAULT '/'
        ) ENGINE = MergeTree ORDER BY (website_id, created_at, event_id)`,
      });
      await client.command({
        query: `CREATE TABLE event_data (
          website_id UUID, session_id UUID, event_id UUID, event_name String,
          data_key String, data_type UInt32, string_value Nullable(String),
          number_value Nullable(Decimal(22, 4)),
          date_value Nullable(DateTime('UTC')), created_at DateTime('UTC'),
          trust_tier UInt8 DEFAULT 0, url_path String DEFAULT '/'
        ) ENGINE = MergeTree ORDER BY (website_id, event_id, data_key)`,
      });
      await client.command({
        query: `CREATE TABLE session_data (
          website_id UUID, session_id UUID, data_key String, data_type UInt32,
          string_value Nullable(String), date_value Nullable(DateTime('UTC')),
          created_at DateTime('UTC'), trust_tier UInt8 DEFAULT 0
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
            trust_tier: 1,
            is_bot: 0,
            created_at: createdAt,
          },
          {
            website_id: attackWebsiteId,
            session_id: attackSessionId,
            event_id: attackEventId,
            event_name: 'attack',
            event_type: 2,
            trust_tier: 1,
            is_bot: 0,
            created_at: createdAt,
          },
          {
            website_id: websiteId,
            session_id: sessionId,
            event_id: legacyEventId,
            event_name: 'legacy',
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
            trust_tier: 1,
            string_value: 'USD',
            created_at: createdAt,
          },
          {
            website_id: websiteId,
            session_id: sessionId,
            event_id: purchaseEventId,
            event_name: 'forged',
            data_key: 'misattributed',
            data_type: 1,
            trust_tier: 1,
            string_value: 'must-not-appear',
            created_at: createdAt,
          },
          {
            website_id: websiteId,
            session_id: sessionId,
            event_id: legacyEventId,
            event_name: 'legacy',
            data_key: 'legacy-only',
            data_type: 1,
            string_value: 'unverified',
            created_at: createdAt,
          },
          {
            website_id: websiteId,
            session_id: sessionId,
            event_id: legacyEventId,
            event_name: 'legacy',
            data_key: 'orphaned-trusted-child',
            data_type: 1,
            trust_tier: 1,
            string_value: 'must-not-appear',
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
            trust_tier: 1,
            string_value: 'vip',
            created_at: createdAt,
          },
          {
            website_id: websiteId,
            session_id: sessionId,
            data_key: 'legacy-only',
            data_type: 1,
            string_value: 'unverified',
            created_at: createdAt,
          },
        ],
      });

      const { getEventDataFields } = await import('./getEventDataFields');
      const { getEventDataById } = await import('./getEventDataById');
      const { EventDataPageTooBroadError, getEventData } = await import('./getEventData');
      const { getEventDataEvents } = await import('./getEventDataEvents');
      const { getEventDataProperties } = await import('./getEventDataProperties');
      const { getEventDataUsage } = await import('./getEventDataUsage');
      const { getEventDataValues } = await import('./getEventDataValues');
      const { getSessionDataProperties } = await import('../sessions/getSessionDataProperties');
      const { getSessionDataValues } = await import('../sessions/getSessionDataValues');
      const { DiscoveryRangeTooBroadError } = await import('./discoveryError');

      expect(await getEventDataFields(websiteId, 'purchase', filters)).toEqual([
        { propertyName: 'currency', dataType: 1, total: 1 },
      ]);
      expect(await getEventDataFields(websiteId, 'legacy', filters)).toEqual([]);
      expect(await getEventDataFields(websiteId, 'forged', filters)).toEqual([]);
      expect(
        await getEventDataFields(websiteId, 'purchase', {
          ...filters,
          eventPropertyFilters: [
            {
              propertyName: 'currency',
              dataType: DATA_TYPE.string,
              operator: OPERATORS.equals,
              value: 'USD',
            },
          ],
        }),
      ).toEqual([{ propertyName: 'currency', dataType: 1, total: 1 }]);
      expect(
        await getEventDataFields(websiteId, 'purchase', {
          ...filters,
          eventPropertyFilters: [
            {
              propertyName: 'misattributed',
              dataType: DATA_TYPE.string,
              operator: OPERATORS.equals,
              value: 'must-not-appear',
            },
          ],
        }),
      ).toEqual([]);
      expect(
        await getEventDataEvents(websiteId, { ...filters, event: 'eq.purchase' }),
      ).toHaveLength(1);
      expect(await getEventDataProperties(websiteId, filters)).toHaveLength(1);
      expect(
        (await getEventDataById(websiteId, purchaseEventId)).map(row => ({
          dataKey: row.dataKey,
          trustTier: Number(row.trustTier),
        })),
      ).toEqual(
        expect.arrayContaining([
          { dataKey: 'currency', trustTier: 1 },
          { dataKey: 'misattributed', trustTier: 0 },
        ]),
      );
      expect(
        await getEventDataValues(websiteId, 'purchase', {
          ...filters,
          propertyName: 'currency',
          dataType: 1,
        }),
      ).toEqual([{ value: 'USD', total: 1 }]);
      expect(
        (await getEventDataUsage([websiteId], filters)).map(row => ({
          websiteId: row.websiteId,
          count: Number(row.count),
        })),
      ).toEqual([{ websiteId, count: 1 }]);
      expect(await getSessionDataProperties(websiteId, filters)).toEqual([
        { propertyName: 'category', dataType: 1, total: 1 },
      ]);
      expect(
        await getSessionDataValues(websiteId, {
          ...filters,
          propertyName: 'category',
        }),
      ).toEqual([{ value: 'vip', total: 1 }]);

      await client.insert({
        table: 'event_data',
        format: 'JSONEachRow',
        values: [
          {
            website_id: websiteId,
            session_id: sessionId,
            event_id: purchaseEventId,
            event_name: 'purchase',
            url_path: '/orphan',
            data_key: 'orphan-path',
            data_type: 1,
            trust_tier: 1,
            string_value: 'must-not-appear',
            created_at: createdAt,
          },
        ],
      });
      expect(await getEventDataFields(websiteId, 'purchase', filters)).toEqual([
        { propertyName: 'currency', dataType: 1, total: 1 },
      ]);
      expect(await getEventDataProperties(websiteId, filters)).toHaveLength(1);
      expect(await getEventDataEvents(websiteId, { ...filters, event: 'eq.purchase' })).toEqual([
        {
          eventName: 'purchase',
          propertyName: 'currency',
          dataType: 1,
          propertyValue: 'USD',
          total: 1,
        },
      ]);
      const orphanDetail = (await getEventDataById(websiteId, purchaseEventId)).find(
        row => row.dataKey === 'orphan-path',
      );
      expect(Number(orphanDetail?.trustTier)).toBe(0);
      expect(
        await getEventDataValues(websiteId, 'purchase', {
          ...filters,
          propertyName: 'orphan-path',
          dataType: 1,
        }),
      ).toEqual([]);
      expect(
        (await getEventDataUsage([websiteId], filters)).map(row => ({
          websiteId: row.websiteId,
          count: Number(row.count),
        })),
      ).toEqual([{ websiteId, count: 1 }]);

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
            trust_tier: 1,
            is_bot: 0,
            created_at: createdAt,
          },
        ],
      });
      expect(
        (await getEventDataUsage([websiteId], filters)).map(row => ({
          websiteId: row.websiteId,
          count: Number(row.count),
        })),
      ).toEqual([{ websiteId, count: 1 }]);
      expect(await getEventDataFields(websiteId, 'purchase', filters)).toEqual([
        { propertyName: 'currency', dataType: 1, total: 1 },
      ]);
      expect(
        await getEventDataValues(websiteId, 'purchase', {
          ...filters,
          propertyName: 'currency',
          dataType: 1,
        }),
      ).toEqual([{ value: 'USD', total: 1 }]);
      const eventData = await getEventData(websiteId, filters);
      expect(Number(eventData.count)).toBe(1);
      expect(eventData.data).toHaveLength(1);
      expect(eventData.data[0].dataKey).toBe('currency');
      const filteredEventData = await getEventData(websiteId, {
        ...filters,
        path: 'eq./',
        event: 'eq.purchase',
      });
      expect(Number(filteredEventData.count)).toBe(1);
      expect(filteredEventData.data).toHaveLength(1);

      await client.insert({
        table: 'website_event',
        format: 'JSONEachRow',
        values: [
          {
            website_id: websiteId,
            session_id: sessionId,
            event_id: purchaseEventId,
            event_name: 'secondary',
            event_type: 2,
            trust_tier: 1,
            is_bot: 0,
            created_at: createdAt,
          },
          {
            website_id: websiteId,
            session_id: sessionId,
            event_id: purchaseEventId,
            event_name: 'purchase',
            url_path: '/other',
            event_type: 2,
            trust_tier: 1,
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
            event_name: 'secondary',
            data_key: 'secondary-only',
            data_type: 1,
            trust_tier: 1,
            string_value: 'unrelated',
            created_at: createdAt,
          },
          {
            website_id: websiteId,
            session_id: sessionId,
            event_id: purchaseEventId,
            event_name: 'purchase',
            url_path: '/other',
            data_key: 'other-path',
            data_type: 1,
            trust_tier: 1,
            string_value: 'unrelated',
            created_at: createdAt,
          },
        ],
      });
      const purchaseData = await getEventData(websiteId, {
        ...filters,
        event: 'eq.purchase',
        path: 'eq./',
      });
      expect(Number(purchaseData.count)).toBe(1);
      expect(purchaseData.data.map(row => row.dataKey)).toEqual(['currency']);
      const allPurchaseData = await getEventData(websiteId, { ...filters, event: 'eq.purchase' });
      expect(Number(allPurchaseData.count)).toBe(2);
      expect(allPurchaseData.data.map(row => row.dataKey).sort()).toEqual([
        'currency',
        'other-path',
      ]);
      const allEventData = await getEventData(websiteId, filters);
      expect(Number(allEventData.count)).toBe(3);
      expect(allEventData.data.map(row => row.dataKey).sort()).toEqual([
        'currency',
        'other-path',
        'secondary-only',
      ]);
      const pagedKeys = [];
      for (let page = 1; page <= 3; page += 1) {
        const result = await getEventData(websiteId, { ...filters, page, pageSize: 1 });
        expect(Number(result.count)).toBe(3);
        expect(result.data).toHaveLength(1);
        pagedKeys.push(result.data[0].dataKey);
      }
      expect(pagedKeys.sort()).toEqual(['currency', 'other-path', 'secondary-only']);

      await client.command({
        query: `INSERT INTO event_data
          (website_id, session_id, event_id, event_name, data_key,
           data_type, string_value, created_at, trust_tier)
          SELECT {websiteId:UUID}, {sessionId:UUID}, {eventId:UUID}, 'attack',
            concat('key-', toString(number)), 1, toString(number),
            toDateTime('2026-10-15 12:00:00'), 1
          FROM numbers(50001)`,
        query_params: {
          websiteId: attackWebsiteId,
          sessionId: attackSessionId,
          eventId: attackEventId,
        },
      });
      const insertedRows = await client.query({
        query: `SELECT count() AS count, uniqExact(data_key) AS uniqueKeys,
          sum(trust_tier = 1) AS verifiedCount FROM event_data
          WHERE website_id = {websiteId:UUID} AND event_name = 'attack'`,
        query_params: { websiteId: attackWebsiteId },
        format: 'JSONEachRow',
      });
      const [insertedCount] = await insertedRows.json<{
        count: string;
        uniqueKeys: string;
        verifiedCount: string;
      }>();
      expect(Number(insertedCount.count)).toBe(50001);
      expect(Number(insertedCount.uniqueKeys)).toBe(50001);
      expect(Number(insertedCount.verifiedCount)).toBe(50001);
      await expect(getEventData(attackWebsiteId, filters)).rejects.toBeInstanceOf(
        EventDataPageTooBroadError,
      );
      const joinedRows = await client.query({
        query: `SELECT count() AS count FROM event_data
          LEFT ANY JOIN (SELECT *, 1 AS admitted FROM website_event
            WHERE website_id = {websiteId:UUID} AND event_name = 'attack'
              AND event_type = 2 AND trust_tier = 1) website_event
          ON website_event.event_id = event_data.event_id
            AND website_event.session_id = event_data.session_id
            AND website_event.website_id = event_data.website_id
          WHERE event_data.website_id = {websiteId:UUID}
            AND website_event.admitted = 1
            AND event_data.event_name = 'attack' AND event_data.trust_tier = 1`,
        query_params: { websiteId: attackWebsiteId },
        format: 'JSONEachRow',
      });
      const [joinedCount] = await joinedRows.json<{ count: string }>();
      expect(Number(joinedCount.count)).toBe(50001);
      await expect(getEventDataFields(attackWebsiteId, 'attack', filters)).rejects.toBeInstanceOf(
        DiscoveryRangeTooBroadError,
      );
      await expect(getEventDataProperties(attackWebsiteId, filters)).rejects.toBeInstanceOf(
        DiscoveryRangeTooBroadError,
      );

      await client.command({
        query: `INSERT INTO event_data
          (website_id, session_id, event_id, event_name, data_key,
           data_type, string_value, created_at, trust_tier)
          SELECT {websiteId:UUID}, {sessionId:UUID}, {eventId:UUID}, 'attack',
            'high-value', 1, toString(number), toDateTime('2026-10-15 12:00:00'), 1
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
          (website_id, session_id, data_key, data_type, string_value, created_at, trust_tier)
          SELECT {websiteId:UUID}, {sessionId:UUID},
            concat('key-', toString(number)), 1, toString(number),
            toDateTime('2026-10-15 12:00:00'), 1
          FROM numbers(50001)`,
        query_params: { websiteId: attackWebsiteId, sessionId: attackSessionId },
      });
      await expect(getSessionDataProperties(attackWebsiteId, filters)).rejects.toBeInstanceOf(
        DiscoveryRangeTooBroadError,
      );

      await client.insert({
        table: 'website_event',
        format: 'JSONEachRow',
        values: [
          {
            website_id: repeatedWebsiteId,
            session_id: repeatedSessionId,
            event_id: repeatedEventId,
            event_name: 'repeat',
            event_type: 2,
            trust_tier: 1,
            is_bot: 0,
            created_at: createdAt,
          },
        ],
      });
      await client.command({
        query: `INSERT INTO event_data
          (website_id, session_id, event_id, event_name, data_key,
           data_type, string_value, created_at, trust_tier)
          SELECT {websiteId:UUID}, {sessionId:UUID}, {eventId:UUID}, 'repeat',
            'duplicate', 1, 'same', toDateTime('2026-10-15 12:00:00'), 1
          FROM numbers(262145)`,
        query_params: {
          websiteId: repeatedWebsiteId,
          sessionId: repeatedSessionId,
          eventId: repeatedEventId,
        },
      });
      await expect(getEventDataFields(repeatedWebsiteId, 'repeat', filters)).rejects.toBeInstanceOf(
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
