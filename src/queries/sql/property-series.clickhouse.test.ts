import { randomUUID } from 'node:crypto';
import { createClient } from '@clickhouse/client';
import { expect, test } from 'vitest';

const integrationTest = process.env.CLICKHOUSE_TEST_URL ? test : test.skip;

integrationTest(
  'ClickHouse bounds property and array values without losing selected buckets',
  async () => {
    const url = process.env.CLICKHOUSE_TEST_URL;
    expect(process.env.CLICKHOUSE_URL).toBe(url);

    const client = createClient({ url });
    const websiteId = '4a147eee-7e6d-4d73-b4a0-f50d06a50000';
    const firstDay = '2026-09-01 12:00:00';
    const secondDay = '2026-09-02 12:00:00';
    const filters = {
      startDate: new Date('2026-09-01T00:00:00Z'),
      endDate: new Date('2026-09-03T00:00:00Z'),
      timezone: 'UTC',
      unit: 'day',
    };

    try {
      await client.command({
        query: `CREATE TABLE website_event (
        event_id UUID,
        website_id UUID,
        session_id UUID,
        event_name String,
        created_at DateTime64(3, 'UTC'),
        event_type UInt32,
        is_bot UInt8
      ) ENGINE = MergeTree ORDER BY (website_id, created_at)`,
      });
      await client.command({
        query: `CREATE TABLE event_data (
        event_id UUID,
        website_id UUID,
        session_id UUID,
        event_name String,
        created_at DateTime64(3, 'UTC'),
        data_key String,
        data_type UInt32,
        string_value Nullable(String)
      ) ENGINE = MergeTree ORDER BY (website_id, event_id, data_key)`,
      });
      await client.command({
        query: `CREATE TABLE session_data (
        session_id UUID,
        website_id UUID,
        created_at DateTime64(3, 'UTC'),
        data_key String,
        data_type UInt32,
        string_value Nullable(String)
      ) ENGINE = ReplacingMergeTree ORDER BY (website_id, session_id, data_key, created_at)`,
      });

      const names = Array.from(
        { length: 60 },
        (_, index) => `name_${String(index).padStart(2, '0')}`,
      );
      const rows = [
        ...names.map(value => ({ value, createdAt: firstDay })),
        { value: names[0], createdAt: secondDay },
        { value: null, createdAt: firstDay },
        { value: null, createdAt: secondDay },
      ].map(({ value, createdAt }) => ({
        eventId: randomUUID(),
        sessionId: randomUUID(),
        value,
        createdAt,
      }));

      await client.insert({
        table: 'website_event',
        format: 'JSONEachRow',
        values: rows.map(({ eventId, sessionId, createdAt }) => ({
          event_id: eventId,
          website_id: websiteId,
          session_id: sessionId,
          event_name: 'signup',
          created_at: createdAt,
          event_type: 2,
          is_bot: 0,
        })),
      });
      await client.insert({
        table: 'event_data',
        format: 'JSONEachRow',
        values: rows.flatMap(({ eventId, sessionId, value, createdAt }) => [
          {
            event_id: eventId,
            session_id: sessionId,
            website_id: websiteId,
            event_name: 'signup',
            created_at: createdAt,
            data_key: 'plan',
            data_type: 1,
            string_value: value,
          },
          {
            event_id: eventId,
            session_id: sessionId,
            website_id: websiteId,
            event_name: 'signup',
            created_at: createdAt,
            data_key: 'tags',
            data_type: 5,
            string_value: JSON.stringify([value]),
          },
        ]),
      });
      await client.insert({
        table: 'session_data',
        format: 'JSONEachRow',
        values: [
          ...rows.flatMap(({ sessionId, value, createdAt }) => [
            {
              session_id: sessionId,
              website_id: websiteId,
              created_at: createdAt,
              data_key: 'plan',
              data_type: 1,
              string_value: value,
            },
            {
              session_id: sessionId,
              website_id: websiteId,
              created_at: createdAt,
              data_key: 'tags',
              data_type: 5,
              string_value: JSON.stringify([value]),
            },
          ]),
          {
            session_id: rows[0].sessionId,
            website_id: websiteId,
            created_at: '2026-08-01 12:00:00',
            data_key: 'plan',
            data_type: 1,
            string_value: 'out-of-range',
          },
        ],
      });

      const { getEventDataPropertySeries } = await import('./events/getEventDataPropertySeries');
      const { getEventDataArraySeries } = await import('./events/getEventDataArraySeries');
      const { getSessionDataPropertySeries } = await import(
        './sessions/getSessionDataPropertySeries'
      );
      const { getSessionDataArraySeries } = await import('./sessions/getSessionDataArraySeries');
      const results = await Promise.all([
        getEventDataPropertySeries(websiteId, 'signup', 'plan', filters),
        getEventDataArraySeries(websiteId, 'signup', 'tags', filters),
        getSessionDataPropertySeries(websiteId, 'plan', filters),
        getSessionDataArraySeries(websiteId, 'tags', filters),
      ]);

      for (const series of results) {
        expect(new Set(series.map(row => row.x)).size).toBe(50);
        expect(series.filter(row => row.x === names[0])).toHaveLength(2);
        expect(series.some(row => row.x === names[59])).toBe(false);
        expect(series.some(row => row.x === 'out-of-range')).toBe(false);
      }
      for (const series of [results[0], results[2]]) {
        expect(series.filter(row => row.x === null)).toHaveLength(2);
      }
    } finally {
      await client.command({ query: 'DROP TABLE IF EXISTS session_data' });
      await client.command({ query: 'DROP TABLE IF EXISTS event_data' });
      await client.command({ query: 'DROP TABLE IF EXISTS website_event' });
      await client.close();
    }
  },
);
