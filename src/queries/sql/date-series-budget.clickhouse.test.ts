import { randomUUID } from 'node:crypto';
import { createClient } from '@clickhouse/client';
import { expect, test } from 'vitest';
import { DATA_TYPE } from '@/lib/constants';
import { MAX_DATE_SERIES_POINTS } from '@/lib/date-series-budget';

const integrationTest = process.env.CLICKHOUSE_DATE_SERIES_TEST_URL ? test : test.skip;

integrationTest(
  'ClickHouse date-series preserves day counts, isolation and resource bounds',
  async () => {
    const url = process.env.CLICKHOUSE_DATE_SERIES_TEST_URL ?? '';
    expect(process.env.CLICKHOUSE_URL).toBe(url);
    const identity = new URL(url);
    expect(identity.protocol).toBe('http:');
    expect(identity.hostname).toBe('127.0.0.1');
    expect(identity.pathname).toBe('/umami_date_series_test');
    const client = createClient({ url });
    const websiteId = randomUUID();
    const otherWebsiteId = randomUUID();
    const createdAt = '2026-03-10 12:00:00';
    const filters = {
      startDate: new Date('2026-03-10T00:00:00Z'),
      endDate: new Date('2026-03-11T00:00:00Z'),
    };
    const { default: clickhouse } = await import('@/lib/clickhouse');
    const { getEventDataDateSeries } = await import('./events/getEventDataDateSeries');
    const { getSessionDataDateSeries } = await import('./sessions/getSessionDataDateSeries');
    const counts = (rows: { t: string; y: number }[]) =>
      rows.map(({ t, y }) => ({ t, y: Number(y) }));

    try {
      await client.command({
        query: `CREATE TABLE website_event (
      event_id UUID, session_id UUID, website_id UUID, created_at DateTime64(3, 'UTC'),
      event_type UInt32, trust_tier UInt8, event_name String, url_path String DEFAULT '/', is_bot UInt8 DEFAULT 0
    ) ENGINE = MergeTree ORDER BY (website_id, event_id)`,
      });
      await client.command({
        query: `CREATE TABLE event_data (
      event_id UUID, session_id UUID, website_id UUID, created_at DateTime64(3, 'UTC'),
      event_name String, url_path String DEFAULT '/', trust_tier UInt8,
      data_key String, data_type UInt32, date_value DateTime64(3, 'UTC')
    ) ENGINE = MergeTree ORDER BY (website_id, event_id)`,
      });
      await client.command({
        query: `CREATE TABLE session_data (
      session_id UUID, website_id UUID, trust_tier UInt8,
      data_key String, data_type UInt32, date_value DateTime64(3, 'UTC')
    ) ENGINE = ReplacingMergeTree ORDER BY (website_id, session_id, data_key)`,
      });

      for (const [index, date] of [
        '2026-03-08 04:30:00',
        '2026-03-08 06:30:00',
        '2026-03-08 07:30:00',
      ].entries()) {
        const sessionId = randomUUID();
        const eventId = randomUUID();
        const event = {
          event_id: eventId,
          session_id: sessionId,
          website_id: websiteId,
          created_at: createdAt,
          event_type: 2,
          trust_tier: 1,
          event_name: 'meeting',
        };
        await client.insert({
          table: 'website_event',
          format: 'JSONEachRow',
          values: [event, ...(index === 2 ? [{ ...event, event_id: randomUUID() }] : [])],
        });
        await client.insert({
          table: 'event_data',
          format: 'JSONEachRow',
          values: [
            {
              event_id: eventId,
              session_id: sessionId,
              website_id: websiteId,
              created_at: createdAt,
              event_name: 'meeting',
              trust_tier: 1,
              data_key: 'date',
              data_type: DATA_TYPE.date,
              date_value: date,
            },
          ],
        });
        await client.insert({
          table: 'session_data',
          format: 'JSONEachRow',
          values: [
            {
              session_id: sessionId,
              website_id: websiteId,
              trust_tier: 1,
              data_key: 'date',
              data_type: DATA_TYPE.date,
              date_value: date,
            },
          ],
        });
      }
      for (const [eventWebsiteId, eventTrust, dataTrust] of [
        [otherWebsiteId, 1, 1],
        [websiteId, 0, 1],
        [websiteId, 1, 0],
      ] as const) {
        const eventId = randomUUID();
        const sessionId = randomUUID();
        await client.insert({
          table: 'website_event',
          format: 'JSONEachRow',
          values: [
            {
              event_id: eventId,
              session_id: sessionId,
              website_id: eventWebsiteId,
              created_at: createdAt,
              event_type: 2,
              trust_tier: eventTrust,
              event_name: 'meeting',
            },
          ],
        });
        await client.insert({
          table: 'event_data',
          format: 'JSONEachRow',
          values: [
            {
              event_id: eventId,
              session_id: sessionId,
              website_id: eventWebsiteId,
              created_at: createdAt,
              event_name: 'meeting',
              trust_tier: dataTrust,
              data_key: 'date',
              data_type: DATA_TYPE.date,
              date_value: '2026-03-09 12:00:00',
            },
          ],
        });
        await client.insert({
          table: 'session_data',
          format: 'JSONEachRow',
          values: [
            {
              session_id: sessionId,
              website_id: eventWebsiteId,
              trust_tier: dataTrust,
              data_key: 'date',
              data_type: DATA_TYPE.date,
              date_value: '2026-03-09 12:00:00',
            },
          ],
        });
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

      const rows = Array.from({ length: MAX_DATE_SERIES_POINTS + 1 }, (_, index) => ({
        event_id: randomUUID(),
        session_id: randomUUID(),
        website_id: websiteId,
        created_at: createdAt,
        event_name: 'bounded',
        data_key: 'bounded',
        data_type: DATA_TYPE.date,
        trust_tier: 1,
        date_value: new Date(Date.UTC(2000, 0, 1 + index, 12))
          .toISOString()
          .slice(0, 19)
          .replace('T', ' '),
      }));
      await client.insert({
        table: 'website_event',
        format: 'JSONEachRow',
        values: rows.map(row => ({
          event_id: row.event_id,
          session_id: row.session_id,
          website_id: row.website_id,
          created_at: createdAt,
          event_name: 'bounded',
          event_type: 2,
          trust_tier: 1,
        })),
      });
      await client.insert({ table: 'event_data', format: 'JSONEachRow', values: rows });
      await client.insert({
        table: 'session_data',
        format: 'JSONEachRow',
        values: rows.map(row => ({
          session_id: row.session_id,
          website_id: row.website_id,
          trust_tier: 1,
          data_key: row.data_key,
          data_type: row.data_type,
          date_value: row.date_value,
        })),
      });
      await expect(
        getEventDataDateSeries(websiteId, 'bounded', 'bounded', filters),
      ).rejects.toThrow('date series exceeds');
      await expect(getSessionDataDateSeries(websiteId, 'bounded', filters)).rejects.toThrow(
        'date series exceeds',
      );
      await client.command({
        query: 'ALTER TABLE event_data DELETE WHERE event_id = {eventId:UUID}',
        query_params: { eventId: rows[MAX_DATE_SERIES_POINTS].event_id },
        clickhouse_settings: { mutations_sync: '2' },
      });
      await client.command({
        query: 'ALTER TABLE session_data DELETE WHERE session_id = {sessionId:UUID}',
        query_params: { sessionId: rows[MAX_DATE_SERIES_POINTS].session_id },
        clickhouse_settings: { mutations_sync: '2' },
      });
      expect(await getEventDataDateSeries(websiteId, 'bounded', 'bounded', filters)).toHaveLength(
        MAX_DATE_SERIES_POINTS,
      );
      expect(await getSessionDataDateSeries(websiteId, 'bounded', filters)).toHaveLength(
        MAX_DATE_SERIES_POINTS,
      );
      await expect(
        clickhouse.rawQuery(
          'SELECT sum(number) FROM numbers(10000000000)',
          {},
          'date-series-timeout-fixture',
          {
            maxExecutionTimeSeconds: 0.05,
            maxThreads: 1,
          },
        ),
      ).rejects.toThrow();
      expect(await clickhouse.rawQuery('SELECT 1 AS recovered')).toEqual([{ recovered: 1 }]);
    } finally {
      for (const table of ['event_data', 'session_data', 'website_event']) {
        await client.command({ query: `DROP TABLE IF EXISTS ${table}` });
      }
      await client.close();
      await (await clickhouse.connect()).close();
    }
  },
  30_000,
);
