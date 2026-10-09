import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, test } from 'vitest';

const integrationTest = process.env.POSTGRES_EVENT_SERIES_TEST_URL ? test : test.skip;

integrationTest(
  'PostgreSQL bounds filtered property and array values without losing selected buckets',
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
      event_id UUID PRIMARY KEY,
      website_id UUID NOT NULL,
      session_id UUID NOT NULL,
      event_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      event_type INTEGER NOT NULL
    )`);
      await client.query(`CREATE TABLE event_data (
      website_event_id UUID NOT NULL,
      website_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      data_key TEXT NOT NULL,
      data_type INTEGER NOT NULL,
      string_value VARCHAR(500)
    )`);
      await client.query(`CREATE TABLE session_data (
      session_id UUID NOT NULL,
      website_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      data_key TEXT NOT NULL,
      data_type INTEGER NOT NULL,
      string_value VARCHAR(500)
    )`);

      const names = Array.from(
        { length: 60 },
        (_, index) => `name_${String(index).padStart(2, '0')}`,
      );
      const rows = [
        ...names.map(value => ({ value, createdAt: firstDay })),
        { value: names[0], createdAt: secondDay },
        { value: null, createdAt: firstDay },
        { value: null, createdAt: secondDay },
      ];
      let firstSessionId = '';

      for (const { value, createdAt } of rows) {
        const eventId = randomUUID();
        const sessionId = randomUUID();
        firstSessionId ||= sessionId;

        await client.query('INSERT INTO website_event VALUES ($1, $2, $3, $4, $5, 2)', [
          eventId,
          websiteId,
          sessionId,
          'signup',
          createdAt,
        ]);
        for (const [key, type, storedValue] of [
          ['plan', 1, value],
          ['tags', 5, JSON.stringify([value])],
        ] as const) {
          await client.query('INSERT INTO event_data VALUES ($1, $2, $3, $4, $5, $6)', [
            eventId,
            websiteId,
            createdAt,
            key,
            type,
            storedValue,
          ]);
          await client.query('INSERT INTO session_data VALUES ($1, $2, $3, $4, $5, $6)', [
            sessionId,
            websiteId,
            createdAt,
            key,
            type,
            storedValue,
          ]);
        }
      }

      await client.query('INSERT INTO session_data VALUES ($1, $2, $3, $4, 1, $5)', [
        firstSessionId,
        websiteId,
        new Date('2026-08-01T12:00:00Z'),
        'plan',
        'out-of-range',
      ]);

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
      for (const series of results) {
        expect(series.filter(row => row.x === null)).toHaveLength(2);
      }
    } finally {
      await client.query('DROP TABLE IF EXISTS session_data');
      await client.query('DROP TABLE IF EXISTS event_data');
      await client.query('DROP TABLE IF EXISTS website_event');
      await client.end();
    }
  },
);
