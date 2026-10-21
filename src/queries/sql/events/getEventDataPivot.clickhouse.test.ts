import { readFileSync } from 'node:fs';
import { createClient } from '@clickhouse/client';
import { expect, test } from 'vitest';
import { DATA_TYPE, OPERATORS } from '@/lib/constants';

const integrationTest = process.env.CLICKHOUSE_TEST_URL ? test : test.skip;

integrationTest(
  'verified ClickHouse pivot admits only properties with a trusted parent',
  async () => {
    const url = new URL(process.env.CLICKHOUSE_TEST_URL ?? '');
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toBe('/umami_event_series_test');
    expect(process.env.CLICKHOUSE_URL).toBe(url.toString());

    const client = createClient({ url: url.toString() });
    const websiteId = '4a147eee-7e6d-4d73-b4a0-f50d06a57000';
    const sessionId = '4a147eee-7e6d-4d73-b4a0-f50d06a57001';
    const verifiedEventId = '4a147eee-7e6d-4d73-b4a0-f50d06a57002';
    const unverifiedEventId = '4a147eee-7e6d-4d73-b4a0-f50d06a57003';
    const missingEventId = '4a147eee-7e6d-4d73-b4a0-f50d06a57004';
    const createdAt = '2026-10-15 12:00:00';
    let databaseCreated = false;
    let websiteEventCreated = false;
    let eventDataViewCreated = false;

    try {
      const existingDatabase = await client.query({
        query: "SELECT count() AS count FROM system.databases WHERE name = 'umami'",
        format: 'JSONEachRow',
      });
      const [database] = await existingDatabase.json<{ count: string }>();
      expect(Number(database?.count)).toBe(0);
      const existingWebsiteEvent = await client.query({
        query:
          "SELECT count() AS count FROM system.tables WHERE database = currentDatabase() AND name = 'website_event'",
        format: 'JSONEachRow',
      });
      const [websiteEvent] = await existingWebsiteEvent.json<{ count: string }>();
      expect(Number(websiteEvent?.count)).toBe(0);

      await client.command({ query: 'CREATE DATABASE umami' });
      databaseCreated = true;
      await client.command({
        query: `CREATE TABLE website_event (
        website_id UUID, session_id UUID, event_id UUID, event_name String,
        event_type UInt32, trust_tier UInt8 DEFAULT 0, is_bot UInt8,
        created_at DateTime('UTC'), hostname String DEFAULT 'example.test',
        url_path String DEFAULT '/', url_query String DEFAULT '',
        referrer_path String DEFAULT '', referrer_query String DEFAULT '',
        referrer_domain String DEFAULT '', country String DEFAULT '',
        city String DEFAULT '', device String DEFAULT '', os String DEFAULT '',
        browser String DEFAULT '', page_title String DEFAULT ''
      ) ENGINE = MergeTree ORDER BY (website_id, created_at, event_id)`,
      });
      websiteEventCreated = true;
      await client.command({
        query: `CREATE TABLE umami.event_data (
        website_id UUID, session_id UUID, event_id UUID, trust_tier UInt8 DEFAULT 0,
        url_path String, event_name String, data_key String,
        string_value Nullable(String), number_value Nullable(Decimal(22, 4)),
        date_value Nullable(DateTime('UTC')), data_type UInt32,
        created_at DateTime('UTC')
      ) ENGINE = MergeTree ORDER BY (website_id, event_id, data_key)`,
      });
      await client.command({ query: 'CREATE VIEW event_data AS SELECT * FROM umami.event_data' });
      eventDataViewCreated = true;

      const migration = readFileSync(
        'db/clickhouse/migrations/20_add_verified_event_data_pivot.sql',
        'utf8',
      );
      const verifiedSchema = readFileSync('db/clickhouse/schema.sql', 'utf8')
        .split('CREATE TABLE IF NOT EXISTS umami.event_data_pivot_verified')[1]
        ?.split(';')[0];
      expect(verifiedSchema).toContain(
        'ORDER BY (website_id, event_name, created_at, event_id, session_id, url_path)',
      );
      for (const statement of migration
        .split(';')
        .map(part => part.trim())
        .filter(Boolean)) {
        await client.command({ query: statement });
      }

      await client.insert({
        table: 'website_event',
        format: 'JSONEachRow',
        values: [
          {
            website_id: websiteId,
            session_id: sessionId,
            event_id: verifiedEventId,
            event_name: 'purchase',
            url_path: '/purchase',
            event_type: 2,
            trust_tier: 1,
            is_bot: 0,
            created_at: createdAt,
          },
          {
            website_id: websiteId,
            session_id: sessionId,
            event_id: verifiedEventId,
            event_name: 'purchase',
            url_path: '/purchase',
            event_type: 2,
            trust_tier: 1,
            is_bot: 0,
            created_at: createdAt,
          },
          {
            website_id: websiteId,
            session_id: sessionId,
            event_id: unverifiedEventId,
            event_name: 'purchase',
            url_path: '/purchase',
            event_type: 2,
            trust_tier: 0,
            is_bot: 0,
            created_at: createdAt,
          },
          {
            website_id: websiteId,
            session_id: sessionId,
            event_id: verifiedEventId,
            event_name: 'forged',
            url_path: '/purchase',
            event_type: 2,
            trust_tier: 1,
            is_bot: 0,
            created_at: createdAt,
          },
        ],
      });
      await client.insert({
        table: 'umami.event_data',
        format: 'JSONEachRow',
        values: [
          ...[
            { event_id: verifiedEventId, data_key: 'currency', string_value: 'USD', trust_tier: 1 },
            {
              event_id: verifiedEventId,
              data_key: 'order-id',
              string_value: 'synthetic',
              trust_tier: 1,
            },
            {
              event_id: verifiedEventId,
              event_name: 'other',
              data_key: 'foreign',
              string_value: 'must-not-appear',
              trust_tier: 1,
            },
            {
              event_id: verifiedEventId,
              url_path: '/orphan',
              data_key: 'wrong-path',
              string_value: 'must-not-appear',
              trust_tier: 1,
            },
            {
              event_id: verifiedEventId,
              data_key: 'unverified',
              string_value: 'ignore',
              trust_tier: 0,
            },
            {
              event_id: unverifiedEventId,
              data_key: 'untrusted-parent',
              string_value: 'ignore',
              trust_tier: 1,
            },
            {
              event_id: missingEventId,
              data_key: 'missing-parent',
              string_value: 'ignore',
              trust_tier: 1,
            },
          ].map(value => ({
            website_id: websiteId,
            session_id: sessionId,
            url_path: '/purchase',
            event_name: 'purchase',
            data_type: 1,
            created_at: createdAt,
            ...value,
          })),
        ],
      });

      const wrongPathRows = await client.query({
        query:
          "SELECT url_path AS urlPath, trust_tier AS trustTier FROM umami.event_data WHERE data_key = 'wrong-path'",
        format: 'JSONEachRow',
      });
      expect(await wrongPathRows.json()).toEqual([{ urlPath: '/orphan', trustTier: 1 }]);
      const pivotGroups = await client.query({
        query:
          'SELECT event_name AS eventName, url_path AS urlPath FROM umami.event_data_pivot_verified',
        format: 'JSONEachRow',
      });
      expect(await pivotGroups.json()).toContainEqual({
        eventName: 'purchase',
        urlPath: '/orphan',
      });
      const pivotCount = await client.query({
        query: 'SELECT count() AS count FROM umami.event_data_pivot_verified',
        format: 'JSONEachRow',
      });
      const [materialized] = await pivotCount.json<{ count: string }>();
      expect(Number(materialized.count)).toBe(5);

      const { getEventDataPivot } = await import('./getEventDataPivot');
      const result = await getEventDataPivot(websiteId, 'purchase', {
        startDate: new Date('2026-10-15T00:00:00Z'),
        endDate: new Date('2026-10-16T00:00:00Z'),
        timezone: 'UTC',
      });
      expect(Number(result.count)).toBe(1);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].eventId).toBe(verifiedEventId);
      expect(result.data[0].propertyKeys).toHaveLength(2);
      expect(new Set(result.data[0].propertyKeys)).toEqual(new Set(['currency', 'order-id']));
      const foreignFiltered = await getEventDataPivot(
        websiteId,
        'purchase',
        {
          startDate: new Date('2026-10-15T00:00:00Z'),
          endDate: new Date('2026-10-16T00:00:00Z'),
          timezone: 'UTC',
        },
        [
          {
            propertyName: 'foreign',
            dataType: DATA_TYPE.string,
            operator: OPERATORS.equals,
            value: 'must-not-appear',
          },
        ],
      );
      expect(Number(foreignFiltered.count)).toBe(0);

      const { getWebsiteEvents } = await import('./getWebsiteEvents');
      const history = await getWebsiteEvents(websiteId, {
        startDate: new Date('2026-10-15T00:00:00Z'),
        endDate: new Date('2026-10-16T00:00:00Z'),
      });
      expect(Number(history.count)).toBe(4);
      expect(
        history.data.filter(row => row.eventName === 'purchase' && Number(row.trustTier) === 1),
      ).toHaveLength(2);
      expect(
        history.data
          .filter(row => row.eventName === 'purchase' && Number(row.trustTier) === 1)
          .every(row => Number(row.hasData) === 1),
      ).toBe(true);
      expect(Number(history.data.find(row => row.eventName === 'forged')?.hasData)).toBe(0);
      expect(Number(history.data.find(row => Number(row.trustTier) === 0)?.hasData)).toBe(0);

      const pathOrphanEventId = '4a147eee-7e6d-4d73-b4a0-f50d06a57006';
      await client.insert({
        table: 'website_event',
        format: 'JSONEachRow',
        values: [
          {
            website_id: websiteId,
            session_id: sessionId,
            event_id: pathOrphanEventId,
            event_name: 'orphan',
            url_path: '/purchase',
            event_type: 2,
            trust_tier: 1,
            is_bot: 0,
            created_at: createdAt,
          },
        ],
      });
      await client.insert({
        table: 'umami.event_data',
        format: 'JSONEachRow',
        values: [
          {
            website_id: websiteId,
            session_id: sessionId,
            event_id: pathOrphanEventId,
            trust_tier: 1,
            url_path: '/orphan',
            event_name: 'orphan',
            data_key: 'wrong-path',
            string_value: 'must-not-appear',
            data_type: 1,
            created_at: createdAt,
          },
        ],
      });
      const orphanHistory = await getWebsiteEvents(websiteId, {
        startDate: new Date('2026-10-15T00:00:00Z'),
        endDate: new Date('2026-10-16T00:00:00Z'),
        search: 'orphan',
      });
      expect(Number(orphanHistory.count)).toBe(1);
      expect(Number(orphanHistory.data[0].hasData)).toBe(0);

      const propertiesFirstEventId = '4a147eee-7e6d-4d73-b4a0-f50d06a57005';
      await client.insert({
        table: 'umami.event_data',
        format: 'JSONEachRow',
        values: [
          {
            website_id: websiteId,
            session_id: sessionId,
            event_id: propertiesFirstEventId,
            trust_tier: 1,
            url_path: '/signup',
            event_name: 'signup',
            data_key: 'plan',
            string_value: 'pro',
            data_type: 1,
            created_at: createdAt,
          },
        ],
      });

      const signupFilters = {
        startDate: new Date('2026-10-15T00:00:00Z'),
        endDate: new Date('2026-10-16T00:00:00Z'),
        timezone: 'UTC',
      };
      expect(Number((await getEventDataPivot(websiteId, 'signup', signupFilters)).count)).toBe(0);

      await client.insert({
        table: 'website_event',
        format: 'JSONEachRow',
        values: [
          {
            website_id: websiteId,
            session_id: sessionId,
            event_id: propertiesFirstEventId,
            event_name: 'signup',
            url_path: '/signup',
            event_type: 2,
            trust_tier: 1,
            is_bot: 0,
            created_at: createdAt,
          },
        ],
      });

      const signup = await getEventDataPivot(websiteId, 'signup', signupFilters);
      expect(Number(signup.count)).toBe(1);
      expect(signup.data[0].eventId).toBe(propertiesFirstEventId);
      expect(signup.data[0].propertyKeys).toEqual(['plan']);
    } finally {
      if (eventDataViewCreated) {
        await client.command({ query: 'DROP VIEW event_data' });
      }
      if (databaseCreated) {
        await client.command({ query: 'DROP DATABASE umami' });
      }
      if (websiteEventCreated) {
        await client.command({ query: 'DROP TABLE website_event' });
      }
      await client.close();
    }
  },
);
