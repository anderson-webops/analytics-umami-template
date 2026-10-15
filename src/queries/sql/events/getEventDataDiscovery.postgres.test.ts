import { Client } from 'pg';
import { expect, test } from 'vitest';

const integrationTest = process.env.POSTGRES_DISCOVERY_TEST_URL ? test : test.skip;

integrationTest(
  'PostgreSQL metadata discovery preserves filtered results and rejects oversized input',
  async () => {
    const url = new URL(process.env.POSTGRES_DISCOVERY_TEST_URL ?? '');
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toBe('/umami_event_series_test');
    expect(process.env.DATABASE_URL).toBe(url.toString());

    const client = new Client({ connectionString: url.toString() });
    const websiteId = '4a147eee-7e6d-4d73-b4a0-f50d06a51000';
    const attackWebsiteId = '4a147eee-7e6d-4d73-b4a0-f50d06a51001';
    const sessionId = '4a147eee-7e6d-4d73-b4a0-f50d06a51002';
    const attackSessionId = '4a147eee-7e6d-4d73-b4a0-f50d06a51003';
    const purchaseEventId = '4a147eee-7e6d-4d73-b4a0-f50d06a51004';
    const viewEventId = '4a147eee-7e6d-4d73-b4a0-f50d06a51005';
    const attackEventId = '4a147eee-7e6d-4d73-b4a0-f50d06a51006';
    const attackPurchaseEventId = '4a147eee-7e6d-4d73-b4a0-f50d06a51007';
    const now = new Date('2026-10-15T12:00:00Z');
    const filters = {
      startDate: new Date('2026-10-15T00:00:00Z'),
      endDate: new Date('2026-10-16T00:00:00Z'),
    };

    await client.connect();

    try {
      await client.query(`CREATE TABLE website_event (
        event_id UUID PRIMARY KEY,
        website_id UUID NOT NULL,
        session_id UUID NOT NULL,
        event_name TEXT NOT NULL,
        event_type INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      )`);
      await client.query(`CREATE TABLE event_data (
        website_event_id UUID NOT NULL,
        website_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        data_key TEXT NOT NULL,
        data_type INTEGER NOT NULL,
        string_value TEXT,
        date_value TIMESTAMPTZ
      )`);
      await client.query(`CREATE TABLE session_data (
        session_id UUID NOT NULL,
        website_id UUID NOT NULL,
        data_key TEXT NOT NULL,
        data_type INTEGER NOT NULL,
        string_value TEXT,
        date_value TIMESTAMPTZ
      )`);

      await client.query(
        `INSERT INTO website_event VALUES
          ($1, $4, $5, 'purchase', 2, $6),
          ($2, $4, $5, 'view', 2, $6),
          ($3, $7, $8, 'attack', 2, $6),
          ($9, $7, $8, 'purchase', 2, $6)`,
        [
          purchaseEventId,
          viewEventId,
          attackEventId,
          websiteId,
          sessionId,
          now,
          attackWebsiteId,
          attackSessionId,
          attackPurchaseEventId,
        ],
      );
      await client.query(
        `INSERT INTO event_data
          (website_event_id, website_id, created_at, data_key, data_type, string_value)
         VALUES ($1, $3, $4, 'currency', 1, 'USD'),
           ($1, $3, $4, 'tags', 5, '["red","blue"]'),
           ($2, $3, $4, 'currency', 1, 'EUR')`,
        [purchaseEventId, viewEventId, websiteId, now],
      );
      await client.query(
        `INSERT INTO event_data
          (website_event_id, website_id, created_at, data_key, data_type, string_value)
         VALUES ($1, $2, $3, 'currency', 1, 'USD')`,
        [attackPurchaseEventId, attackWebsiteId, now],
      );
      await client.query(
        `INSERT INTO session_data (session_id, website_id, data_key, data_type, string_value)
         VALUES ($1, $2, 'category', 1, 'vip'),
           ($1, $2, 'tags', 5, '["alpha","beta"]'),
           ($3, $4, 'category', 1, 'attack')`,
        [sessionId, websiteId, attackSessionId, attackWebsiteId],
      );

      const { getEventDataEvents } = await import('./getEventDataEvents');
      const { getEventDataFields } = await import('./getEventDataFields');
      const { getEventDataProperties } = await import('./getEventDataProperties');
      const { getEventDataValues } = await import('./getEventDataValues');
      const { getSessionDataProperties } = await import('../sessions/getSessionDataProperties');
      const { getSessionDataValues } = await import('../sessions/getSessionDataValues');
      const { DiscoveryRangeTooBroadError } = await import('./discoveryError');

      expect(await getEventDataFields(websiteId, 'purchase', filters)).toEqual([
        { propertyName: 'currency', dataType: 1, total: 1 },
        { propertyName: 'tags', dataType: 5, total: 1 },
      ]);
      const eventRows = await getEventDataEvents(websiteId, { ...filters, event: 'eq.purchase' });
      expect(eventRows).toEqual(
        expect.arrayContaining([
          {
            eventName: 'purchase',
            propertyName: 'currency',
            dataType: 1,
            propertyValue: 'USD',
            total: 1,
          },
        ]),
      );
      const propertyRows = await getEventDataProperties(websiteId, {
        ...filters,
        propertyName: 'eq.currency',
      });
      expect(propertyRows).toHaveLength(2);
      const currencyRows = await getEventDataValues(websiteId, 'purchase', {
        ...filters,
        propertyName: 'currency',
        dataType: 1,
      });
      expect(currencyRows).toEqual([{ value: 'USD', total: 1 }]);
      const tagRows = await getEventDataValues(websiteId, 'purchase', {
        ...filters,
        propertyName: 'tags',
        dataType: 5,
      });
      expect(tagRows).toEqual([
        { value: 'blue', total: 1 },
        { value: 'red', total: 1 },
      ]);
      const sessionPropertyRows = await getSessionDataProperties(
        websiteId,
        filters,
        [],
        'category',
      );
      expect(sessionPropertyRows).toEqual(
        expect.arrayContaining([
          { propertyName: 'category', dataType: 1, total: 1 },
          { propertyName: 'tags', dataType: 5, total: 1 },
        ]),
      );
      const sessionValues = await getSessionDataValues(websiteId, {
        ...filters,
        propertyName: 'category',
      });
      expect(sessionValues).toEqual([{ value: 'vip', total: 2 }]);

      await client.query(
        `INSERT INTO event_data
          (website_event_id, website_id, created_at, data_key, data_type, string_value)
         SELECT $1, $2, $3, 'key-' || n, 1, n::text
         FROM generate_series(1, 50001) n`,
        [attackEventId, attackWebsiteId, now],
      );
      expect(await getEventDataFields(attackWebsiteId, 'purchase', filters)).toEqual([
        { propertyName: 'currency', dataType: 1, total: 1 },
      ]);
      expect(
        await getEventDataValues(attackWebsiteId, 'purchase', {
          ...filters,
          propertyName: 'currency',
          dataType: 1,
        }),
      ).toEqual([{ value: 'USD', total: 1 }]);
      await expect(getEventDataFields(attackWebsiteId, 'attack', filters)).rejects.toBeInstanceOf(
        DiscoveryRangeTooBroadError,
      );
      await expect(
        getEventDataEvents(attackWebsiteId, { ...filters, event: 'eq.attack' }),
      ).rejects.toBeInstanceOf(DiscoveryRangeTooBroadError);
      await expect(getEventDataProperties(attackWebsiteId, filters)).rejects.toBeInstanceOf(
        DiscoveryRangeTooBroadError,
      );
      await client.query(
        `DELETE FROM event_data WHERE website_id = $1 AND data_key = 'key-50001'`,
        [attackWebsiteId],
      );
      expect(await getEventDataFields(attackWebsiteId, 'attack', filters)).toHaveLength(500);

      await client.query(
        `INSERT INTO event_data
          (website_event_id, website_id, created_at, data_key, data_type, string_value)
         SELECT $1, $2, $3, 'high-value', 1, n::text
         FROM generate_series(1, 50001) n`,
        [attackEventId, attackWebsiteId, now],
      );
      await expect(
        getEventDataValues(attackWebsiteId, 'attack', {
          ...filters,
          propertyName: 'high-value',
          dataType: 1,
        }),
      ).rejects.toBeInstanceOf(DiscoveryRangeTooBroadError);

      await client.query(
        `INSERT INTO website_event (event_id, website_id, session_id, event_name,
          event_type, created_at)
         SELECT md5(n::text)::uuid, $1, $2, 'attack', 2, $3
         FROM generate_series(1, 50001) n`,
        [attackWebsiteId, attackSessionId, now],
      );
      await expect(getSessionDataProperties(attackWebsiteId, filters)).rejects.toBeInstanceOf(
        DiscoveryRangeTooBroadError,
      );
      await expect(
        getSessionDataValues(attackWebsiteId, {
          ...filters,
          propertyName: 'category',
        }),
      ).rejects.toBeInstanceOf(DiscoveryRangeTooBroadError);
    } finally {
      await client.query('DROP TABLE IF EXISTS event_data, session_data, website_event');
      await client.end();
    }
  },
  90_000,
);
