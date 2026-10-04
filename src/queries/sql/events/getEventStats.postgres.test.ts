import { Client } from 'pg';
import { expect, test } from 'vitest';

const integrationTest = process.env.POSTGRES_EVENT_SERIES_TEST_URL ? test : test.skip;

integrationTest(
  'PostgreSQL event series ranks matching names and preserves their buckets',
  async () => {
    const url = process.env.POSTGRES_EVENT_SERIES_TEST_URL;
    expect(process.env.DATABASE_URL).toBe(url);

    const client = new Client({ connectionString: url });
    const websiteId = '4a147eee-7e6d-4d73-b4a0-f50d06a50000';
    const firstDay = new Date('2026-09-01T12:00:00Z');
    const secondDay = new Date('2026-09-02T12:00:00Z');
    const filters = {
      startDate: new Date('2026-09-01T00:00:00Z'),
      endDate: new Date('2026-09-03T00:00:00Z'),
      timezone: 'UTC',
      unit: 'day',
    };

    await client.connect();

    try {
      await client.query(`CREATE TABLE website_event (
      website_id UUID NOT NULL,
      session_id UUID NOT NULL,
      event_name TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      event_type INTEGER NOT NULL,
      is_bot BOOLEAN NOT NULL
    )`);

      const names = Array.from(
        { length: 60 },
        (_, index) => `name_${String(index).padStart(2, '0')}`,
      );
      const rows = [
        ...names.map(eventName => ({ eventName, createdAt: firstDay, isBot: false })),
        { eventName: names[0], createdAt: secondDay, isBot: false },
        { eventName: 'rare-event', createdAt: firstDay, isBot: false },
        ...Array.from({ length: 100 }, () => ({
          eventName: 'bot-heavy',
          createdAt: firstDay,
          isBot: true,
        })),
      ];

      for (const { eventName, createdAt, isBot } of rows) {
        await client.query(
          'INSERT INTO website_event (website_id, session_id, event_name, created_at, event_type, is_bot) VALUES ($1, $1, $2, $3, 2, $4)',
          [websiteId, eventName, createdAt, isBot],
        );
      }

      const { getEventStats } = await import('./getEventStats');
      const defaultSeries = await getEventStats(websiteId, {}, filters);
      expect(new Set(defaultSeries.map(row => row.x)).size).toBe(50);
      expect(defaultSeries.filter(row => row.x === names[0])).toHaveLength(2);

      const rareSeries = await getEventStats(
        websiteId,
        { limit: 1 },
        {
          ...filters,
          event: 'eq.rare-event',
        },
      );
      expect(rareSeries.map(row => row.x)).toEqual(['rare-event']);

      const topSeries = await getEventStats(websiteId, { limit: 1 }, filters);
      expect(topSeries.map(row => row.x)).toEqual(['bot-heavy']);
    } finally {
      await client.query('DROP TABLE IF EXISTS website_event');
      await client.end();
    }
  },
);
