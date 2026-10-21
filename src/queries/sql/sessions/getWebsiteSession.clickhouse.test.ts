import { randomUUID } from 'node:crypto';
import { createClient } from '@clickhouse/client';
import { expect, test } from 'vitest';
import { getWebsiteSession } from './getWebsiteSession';

const integrationTest = process.env.CLICKHOUSE_TEST_URL ? test : test.skip;

integrationTest('session summary does not project caller-supplied identity labels', async () => {
  const url = process.env.CLICKHOUSE_TEST_URL;
  expect(process.env.CLICKHOUSE_URL).toBe(url);

  const client = createClient({ url });
  const websiteId = randomUUID();
  const sessionId = randomUUID();
  const visitId = randomUUID();

  try {
    await client.command({
      query: `CREATE TABLE website_event (
        website_id UUID,
        session_id UUID,
        visit_id UUID,
        distinct_id String,
        browser String,
        os String,
        device String,
        screen String,
        language String,
        country String,
        region String,
        city String,
        is_bot UInt8,
        bot_name String,
        bot_category String,
        event_type UInt32,
        trust_tier UInt8,
        created_at DateTime('UTC')
      ) ENGINE = MergeTree ORDER BY (website_id, session_id, visit_id, created_at)`,
    });
    const row = {
      website_id: websiteId,
      session_id: sessionId,
      visit_id: visitId,
      browser: 'Synthetic',
      os: 'Synthetic',
      device: 'desktop',
      screen: '1000x1000',
      language: 'en',
      country: 'US',
      region: 'US-NY',
      city: 'Synthetic',
      is_bot: 0,
      bot_name: '',
      bot_category: '',
      trust_tier: 0,
      created_at: '2026-10-17 00:00:00',
    };
    await client.insert({
      table: 'website_event',
      format: 'JSONEachRow',
      values: [
        { ...row, distinct_id: 'forged-one', event_type: 1 },
        { ...row, distinct_id: 'forged-two', event_type: 1 },
        { ...row, distinct_id: 'forged-three', event_type: 2 },
      ],
    });

    const result = await getWebsiteSession(websiteId, sessionId);

    expect(result).toMatchObject({ id: sessionId, visits: 1, views: 2, events: 0 });
    expect(result).not.toHaveProperty('distinctId');
  } finally {
    await client.command({ query: 'DROP TABLE IF EXISTS website_event' });
    await client.close();
  }
});
