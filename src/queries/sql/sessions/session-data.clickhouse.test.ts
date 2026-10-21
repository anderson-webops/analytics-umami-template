import { createClient } from '@clickhouse/client';
import { expect, test } from 'vitest';
import { getSessionData } from './getSessionData';

const integrationTest = process.env.CLICKHOUSE_TEST_URL ? test : test.skip;

integrationTest(
  'limited session-property reads stop replacement-version fan-out without restricting owner reads',
  async () => {
    const url = new URL(process.env.CLICKHOUSE_TEST_URL ?? '');
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.pathname).toBe('/umami_event_series_test');
    expect(process.env.CLICKHOUSE_URL).toBe(url.toString());

    const client = createClient({ url: url.toString() });
    const websiteId = '4a147eee-7e6d-4d73-b4a0-f50d06a50010';
    const ordinarySessionId = '4a147eee-7e6d-4d73-b4a0-f50d06a50011';
    const manyPropertiesSessionId = '4a147eee-7e6d-4d73-b4a0-f50d06a50012';
    const manyVersionsSessionId = '4a147eee-7e6d-4d73-b4a0-f50d06a50013';
    const boundarySessionId = '4a147eee-7e6d-4d73-b4a0-f50d06a50014';
    let tableCreated = false;

    try {
      await client.command({
        query: `CREATE TABLE session_data (
          website_id UUID,
          session_id UUID,
          data_key String,
          trust_tier UInt8 DEFAULT 0,
          string_value Nullable(String),
          number_value Nullable(Float64),
          date_value Nullable(DateTime('UTC')),
          data_type UInt32,
          created_at DateTime('UTC')
        ) ENGINE = ReplacingMergeTree ORDER BY (website_id, session_id, data_key)`,
      });
      tableCreated = true;
      await client.command({ query: 'SYSTEM STOP MERGES session_data' });

      await client.insert({
        table: 'session_data',
        format: 'JSONEachRow',
        values: [
          {
            website_id: websiteId,
            session_id: ordinarySessionId,
            data_key: 'first',
            string_value: 'one',
            data_type: 1,
            created_at: '2026-01-01 00:00:00',
          },
          {
            website_id: websiteId,
            session_id: ordinarySessionId,
            data_key: 'second',
            string_value: 'two',
            data_type: 1,
            created_at: '2026-01-01 00:00:00',
          },
        ],
      });

      expect(await getSessionData(websiteId, ordinarySessionId, 501)).toHaveLength(2);

      await client.command({
        query: `INSERT INTO session_data
          (website_id, session_id, data_key, string_value, data_type, created_at)
          SELECT {websiteId:UUID}, {sessionId:UUID}, concat('key-', toString(number)),
            toString(number), 1, toDateTime('2026-01-01 00:00:00')
          FROM numbers(500)`,
        query_params: { websiteId, sessionId: boundarySessionId },
      });

      expect(await getSessionData(websiteId, boundarySessionId, 501)).toHaveLength(500);

      await client.command({
        query: `INSERT INTO session_data
          (website_id, session_id, data_key, string_value, data_type, created_at)
          SELECT {websiteId:UUID}, {sessionId:UUID}, concat('key-', toString(number)),
            toString(number), 1, toDateTime('2026-01-01 00:00:00')
          FROM numbers(600)`,
        query_params: { websiteId, sessionId: manyPropertiesSessionId },
      });

      expect(await getSessionData(websiteId, manyPropertiesSessionId, 501)).toHaveLength(501);
      expect(await getSessionData(websiteId, manyPropertiesSessionId)).toHaveLength(600);

      await client.command({
        query: `INSERT INTO session_data
          (website_id, session_id, data_key, string_value, data_type, created_at)
          SELECT {websiteId:UUID}, {sessionId:UUID}, 'duplicate',
            toString(number), 1, toDateTime('2026-01-01 00:00:00')
          FROM numbers(300000) SETTINGS optimize_on_insert=0`,
        query_params: { websiteId, sessionId: manyVersionsSessionId },
      });

      const physicalRows = await client.query({
        query: `SELECT count() AS total FROM session_data
          WHERE website_id = {websiteId:UUID} AND session_id = {sessionId:UUID}`,
        query_params: { websiteId, sessionId: manyVersionsSessionId },
        format: 'JSONEachRow',
      });
      expect(Number((await physicalRows.json<{ total: string }>())[0].total)).toBe(300_000);

      await expect(getSessionData(websiteId, manyVersionsSessionId, 501)).rejects.toMatchObject({
        code: '158',
        type: 'TOO_MANY_ROWS',
      });
      expect(await getSessionData(websiteId, manyVersionsSessionId)).toHaveLength(1);
    } finally {
      if (tableCreated) {
        await client.command({ query: 'SYSTEM START MERGES session_data' });
        await client.command({ query: 'DROP TABLE session_data' });
      }
      await client.close();
    }
  },
  90_000,
);
