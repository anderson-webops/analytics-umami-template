import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, test } from 'vitest';

const integrationTest = process.env.POSTGRES_EVENT_SERIES_TEST_URL ? test : test.skip;

integrationTest(
  'PostgreSQL value discovery separates public pageviews from trusted custom events',
  async () => {
    const url = process.env.POSTGRES_EVENT_SERIES_TEST_URL;
    expect(process.env.DATABASE_URL).toBe(url);

    const client = new Client({ connectionString: url });
    const websiteId = randomUUID();
    const otherWebsiteId = randomUUID();
    const createdAt = new Date('2026-10-01T12:00:00Z');
    const filters = {
      startDate: new Date('2026-10-01T00:00:00Z'),
      endDate: new Date('2026-10-02T00:00:00Z'),
    };

    await client.connect();

    try {
      await client.query(`CREATE TABLE website_event (
      website_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      event_type INTEGER NOT NULL,
      trust_tier SMALLINT NOT NULL DEFAULT 0,
      is_bot BOOLEAN NOT NULL DEFAULT false,
      event_name TEXT,
      url_path TEXT
    )`);

      for (const [eventWebsiteId, eventType, trustTier, isBot, eventName, urlPath] of [
        [websiteId, 1, 0, false, null, '/public'],
        [websiteId, 2, 0, false, 'forged', '/forged'],
        [websiteId, 2, 1, false, 'verified', '/verified'],
        [websiteId, 1, 0, true, null, '/bot'],
        [otherWebsiteId, 2, 1, false, 'other-site', '/other-site'],
      ] as const) {
        await client.query('INSERT INTO website_event VALUES ($1, $2, $3, $4, $5, $6, $7)', [
          eventWebsiteId,
          createdAt,
          eventType,
          trustTier,
          isBot,
          eventName,
          urlPath,
        ]);
      }

      const { getValues } = await import('./getValues');
      const eventNames = await getValues(websiteId, 'event_name', filters);
      expect(eventNames.map(({ value }) => value)).toEqual(['verified']);

      const publicPaths = await getValues(websiteId, 'url_path', filters);
      expect(new Set(publicPaths.map(({ value }) => value))).toEqual(
        new Set(['/public', '/verified']),
      );

      const botPaths = await getValues(websiteId, 'url_path', { ...filters, trafficType: 'bot' });
      expect(botPaths.map(({ value }) => value)).toEqual(['/bot']);
    } finally {
      await client.query('DROP TABLE IF EXISTS website_event');
      await client.end();
    }
  },
);
