import { createClient } from '@clickhouse/client';
import { expect, test } from 'vitest';

const integrationTest = process.env.CLICKHOUSE_TEST_URL ? test : test.skip;

integrationTest(
  'event series limits matching names without truncating their time buckets',
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
        website_id UUID,
        session_id UUID,
        event_name String,
        created_at DateTime64(3, 'UTC'),
        event_type UInt32,
        is_bot UInt8
      ) ENGINE = MergeTree ORDER BY (website_id, created_at)`,
      });
      await client.command({
        query: `CREATE TABLE website_event_stats_hourly (
        website_id UUID,
        event_name Array(String),
        created_at DateTime64(3, 'UTC'),
        event_type UInt32
      ) ENGINE = MergeTree ORDER BY (website_id, created_at)`,
      });

      const names = Array.from(
        { length: 60 },
        (_, index) => `name_${String(index).padStart(2, '0')}`,
      );
      await client.insert({
        table: 'website_event',
        format: 'JSONEachRow',
        values: [
          ...names.map(eventName => ({
            website_id: websiteId,
            session_id: websiteId,
            event_name: eventName,
            created_at: firstDay,
            event_type: 2,
            is_bot: 0,
          })),
          {
            website_id: websiteId,
            session_id: websiteId,
            event_name: names[0],
            created_at: secondDay,
            event_type: 2,
            is_bot: 0,
          },
          {
            website_id: websiteId,
            session_id: websiteId,
            event_name: 'rare-event',
            created_at: firstDay,
            event_type: 2,
            is_bot: 0,
          },
          ...Array.from({ length: 100 }, () => ({
            website_id: websiteId,
            session_id: websiteId,
            event_name: 'bot-heavy',
            created_at: firstDay,
            event_type: 2,
            is_bot: 1,
          })),
        ],
      });
      await client.insert({
        table: 'website_event_stats_hourly',
        format: 'JSONEachRow',
        values: [
          ...names.map(eventName => ({
            website_id: websiteId,
            event_name: [eventName],
            created_at: firstDay,
            event_type: 2,
          })),
          {
            website_id: websiteId,
            event_name: [names[0]],
            created_at: secondDay,
            event_type: 2,
          },
        ],
      });

      const { getEventStats } = await import('./getEventStats');
      const humanSeries = await getEventStats(websiteId, {}, filters);
      const humanNames = new Set(humanSeries.map(row => row.x));
      expect(humanNames.size).toBe(50);
      expect(humanSeries.filter(row => row.x === names[0])).toHaveLength(2);
      expect(humanNames.has('bot-heavy')).toBe(false);

      const rareSeries = await getEventStats(
        websiteId,
        { limit: 1 },
        {
          ...filters,
          event: 'eq.rare-event',
        },
      );
      expect(rareSeries.map(row => row.x)).toEqual(['rare-event']);

      const botSeries = await getEventStats(
        websiteId,
        { limit: 1 },
        {
          ...filters,
          trafficType: 'bot',
        },
      );
      expect(new Set(botSeries.map(row => row.x))).toEqual(new Set(['bot-heavy']));

      const hourlySeries = await getEventStats(websiteId, {}, { ...filters, trafficType: 'all' });
      expect(new Set(hourlySeries.map(row => row.x)).size).toBe(50);
      expect(hourlySeries.filter(row => row.x === names[0])).toHaveLength(2);
    } finally {
      await client.command({ query: 'DROP TABLE IF EXISTS website_event_stats_hourly' });
      await client.command({ query: 'DROP TABLE IF EXISTS website_event' });
      await client.close();
    }
  },
);
