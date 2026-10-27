import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, test } from 'vitest';
import { DATA_TYPE, EVENT_TYPE } from '@/lib/constants';
import { MAX_DATE_SERIES_POINTS } from '@/lib/date-series-budget';

const integrationTest = process.env.POSTGRES_DATE_SERIES_TEST_URL ? test : test.skip;

integrationTest(
  'PostgreSQL date-series preserves day counts, isolation and resource bounds',
  async () => {
    const url = process.env.POSTGRES_DATE_SERIES_TEST_URL ?? '';
    expect(process.env.DATABASE_URL).toBe(url);
    expect(process.env.CLICKHOUSE_URL || '').toBe('');
    const identity = new URL(url);
    expect(['postgres:', 'postgresql:']).toContain(identity.protocol);
    expect(identity.hostname).toBe('127.0.0.1');
    expect(identity.pathname).toBe('/umami_date_series_test');

    const client = new Client({ connectionString: url });
    const websiteId = randomUUID();
    const otherWebsiteId = randomUUID();
    const createdAt = new Date('2026-03-10T12:00:00Z');
    const filters = {
      startDate: new Date('2026-03-10T00:00:00Z'),
      endDate: new Date('2026-03-11T00:00:00Z'),
    };
    const { default: prisma } = await import('@/lib/prisma');
    const { getEventDataDateSeries } = await import('./events/getEventDataDateSeries');
    const { getSessionDataDateSeries } = await import('./sessions/getSessionDataDateSeries');
    const counts = (rows: { t: string; y: number }[]) =>
      rows.map(({ t, y }) => ({ t, y: Number(y) }));

    await client.connect();
    try {
      await client.query(`CREATE TABLE website_event (
      event_id UUID PRIMARY KEY, session_id UUID NOT NULL, website_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL, event_type INTEGER NOT NULL,
      trust_tier SMALLINT NOT NULL, is_bot BOOLEAN NOT NULL DEFAULT false,
      event_name TEXT NOT NULL
    );
    CREATE TABLE event_data (
      website_event_id UUID NOT NULL, website_id UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL,
      trust_tier SMALLINT NOT NULL, data_key TEXT NOT NULL, data_type INTEGER NOT NULL,
      date_value TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE session_data (
      session_id UUID NOT NULL, website_id UUID NOT NULL, trust_tier SMALLINT NOT NULL,
      data_key TEXT NOT NULL, data_type INTEGER NOT NULL, date_value TIMESTAMPTZ NOT NULL
    )`);

      for (const [index, date] of [
        '2026-03-08T04:30:00Z',
        '2026-03-08T06:30:00Z',
        '2026-03-08T07:30:00Z',
      ].entries()) {
        const sessionId = randomUUID();
        const eventId = randomUUID();
        await client.query('INSERT INTO website_event VALUES ($1, $2, $3, $4, 2, 1, false, $5)', [
          eventId,
          sessionId,
          websiteId,
          createdAt,
          'meeting',
        ]);
        await client.query('INSERT INTO event_data VALUES ($1, $2, $3, 1, $4, $5, $6)', [
          eventId,
          websiteId,
          createdAt,
          'date',
          DATA_TYPE.date,
          date,
        ]);
        await client.query('INSERT INTO session_data VALUES ($1, $2, 1, $3, $4, $5)', [
          sessionId,
          websiteId,
          'date',
          DATA_TYPE.date,
          date,
        ]);
        if (index === 2) {
          await client.query('INSERT INTO website_event VALUES ($1, $2, $3, $4, 2, 1, false, $5)', [
            randomUUID(),
            sessionId,
            websiteId,
            createdAt,
            'meeting',
          ]);
        }
      }

      for (const [eventWebsiteId, eventType, eventTrust, dataTrust, isBot] of [
        [otherWebsiteId, 2, 1, 1, false],
        [websiteId, 2, 0, 1, false],
        [websiteId, 2, 1, 0, false],
        [websiteId, EVENT_TYPE.performance, 1, 1, false],
      ] as const) {
        const eventId = randomUUID();
        const sessionId = randomUUID();
        await client.query('INSERT INTO website_event VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
          eventId,
          sessionId,
          eventWebsiteId,
          createdAt,
          eventType,
          eventTrust,
          isBot,
          'meeting',
        ]);
        await client.query('INSERT INTO event_data VALUES ($1, $2, $3, $4, $5, $6, $7)', [
          eventId,
          eventWebsiteId,
          createdAt,
          dataTrust,
          'date',
          DATA_TYPE.date,
          '2026-03-09T12:00:00Z',
        ]);
        await client.query('INSERT INTO session_data VALUES ($1, $2, $3, $4, $5, $6)', [
          sessionId,
          eventWebsiteId,
          dataTrust,
          'date',
          DATA_TYPE.date,
          '2026-03-09T12:00:00Z',
        ]);
      }

      for (const [timezone, expected] of [
        ['UTC', [{ t: '2026-03-08T00:00:00Z', y: 3 }]],
        [
          'America/New_York',
          [
            { t: '2026-03-07T00:00:00Z', y: 1 },
            { t: '2026-03-08T00:00:00Z', y: 2 },
          ],
        ],
      ] as const) {
        const selected = { ...filters, timezone };
        expect(
          counts(await getEventDataDateSeries(websiteId, 'meeting', 'date', selected)),
        ).toEqual(expected);
        expect(counts(await getSessionDataDateSeries(websiteId, 'date', selected))).toEqual(
          expected,
        );
      }
      expect(await getEventDataDateSeries(websiteId, 'missing', 'date', filters)).toEqual([]);
      expect(await getSessionDataDateSeries(websiteId, 'missing', filters)).toEqual([]);

      await client.query(
        `INSERT INTO website_event
      SELECT md5('bounded-event-' || series)::uuid, md5('bounded-session-' || series)::uuid,
        $1::uuid, $2::timestamptz, 2, 1, false, 'bounded'
      FROM generate_series(0, $3::integer) AS series`,
        [websiteId, createdAt, MAX_DATE_SERIES_POINTS],
      );
      await client.query(
        `INSERT INTO event_data
      SELECT event_id, website_id, created_at, 1, 'bounded', $2::integer,
        '2000-01-01T12:00:00Z'::timestamptz + series * interval '1 day'
      FROM generate_series(0, $3::integer) AS series
      JOIN website_event ON event_id = md5('bounded-event-' || series)::uuid
      WHERE website_id = $1::uuid`,
        [websiteId, DATA_TYPE.date, MAX_DATE_SERIES_POINTS],
      );
      await client.query(
        `INSERT INTO session_data
      SELECT session_id, website_id, 1, 'bounded', $2::integer,
        '2000-01-01T12:00:00Z'::timestamptz + series * interval '1 day'
      FROM generate_series(0, $3::integer) AS series
      JOIN website_event ON event_id = md5('bounded-event-' || series)::uuid
      WHERE website_id = $1::uuid`,
        [websiteId, DATA_TYPE.date, MAX_DATE_SERIES_POINTS],
      );
      await expect(
        getEventDataDateSeries(websiteId, 'bounded', 'bounded', filters),
      ).rejects.toThrow('date series exceeds');
      await expect(getSessionDataDateSeries(websiteId, 'bounded', filters)).rejects.toThrow(
        'date series exceeds',
      );
      await client.query('DELETE FROM event_data WHERE website_event_id = md5($1)::uuid', [
        `bounded-event-${MAX_DATE_SERIES_POINTS}`,
      ]);
      await client.query('DELETE FROM session_data WHERE session_id = md5($1)::uuid', [
        `bounded-session-${MAX_DATE_SERIES_POINTS}`,
      ]);
      expect(await getEventDataDateSeries(websiteId, 'bounded', 'bounded', filters)).toHaveLength(
        MAX_DATE_SERIES_POINTS,
      );
      expect(await getSessionDataDateSeries(websiteId, 'bounded', filters)).toHaveLength(
        MAX_DATE_SERIES_POINTS,
      );
      await expect(
        prisma.rawQuery('SELECT pg_sleep(0.2)', {}, 'date-series-timeout-fixture', 25),
      ).rejects.toThrow();
      expect(
        await prisma.rawQuery('SELECT 1 AS recovered', {}, 'date-series-timeout-recovery', 1000),
      ).toEqual([{ recovered: 1 }]);
    } finally {
      await client.query('DROP TABLE IF EXISTS event_data, session_data, website_event');
      await client.end();
      await prisma.client.$disconnect();
    }
  },
  30_000,
);
