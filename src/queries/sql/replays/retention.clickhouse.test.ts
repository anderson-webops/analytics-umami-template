import { readFile } from 'node:fs/promises';
import { createClient } from '@clickhouse/client';
import { expect, test } from 'vitest';

const integrationTest = process.env.CLICKHOUSE_TEST_URL ? test : test.skip;
const table = 'replay_retention_test';

function statements(sql: string) {
  return sql
    .replaceAll('umami.session_replay', table)
    .split(';')
    .map(statement => statement.trim())
    .filter(Boolean);
}

integrationTest('expires marked replay payloads by acceptance time', async () => {
  const url = process.env.CLICKHOUSE_TEST_URL;
  expect(process.env.CLICKHOUSE_URL).toBe(url);

  const client = createClient({ url });
  const websiteId = '11111111-1111-4111-8111-111111111111';
  const legacyId = '22222222-2222-4222-8222-222222222222';
  const expiredId = '33333333-3333-4333-8333-333333333333';
  const currentId = '44444444-4444-4444-8444-444444444444';
  const oldAcceptedAt = new Date(Date.now() - 40 * 86_400_000);
  const clickhouseDate = (date: Date) => date.toISOString().slice(0, 19).replace('T', ' ');
  const legacyMigration = await readFile(
    'db/clickhouse/migrations/10_add_session_replay.sql',
    'utf8',
  );
  const retentionMigration = await readFile(
    'db/clickhouse/migrations/16_expire_new_session_replays.sql',
    'utf8',
  );

  const row = (replayId: string) => ({
    replay_id: replayId,
    website_id: websiteId,
    session_id: websiteId,
    visit_id: websiteId,
    chunk_index: 0,
    events: '[]',
    event_count: 0,
    started_at: clickhouseDate(oldAcceptedAt),
    ended_at: clickhouseDate(oldAcceptedAt),
    created_at: clickhouseDate(oldAcceptedAt),
  });

  try {
    for (const query of statements(legacyMigration)) {
      await client.command({ query });
    }
    await client.insert({
      table,
      format: 'JSONEachRow',
      values: [row(legacyId)],
    });
    for (const query of statements(retentionMigration)) {
      await client.command({ query });
    }
    await client.insert({
      table,
      format: 'JSONEachRow',
      values: [
        {
          ...row(expiredId),
          retention_policy: 1,
          ingested_at: clickhouseDate(oldAcceptedAt),
        },
        {
          ...row(currentId),
          retention_policy: 1,
          ingested_at: clickhouseDate(new Date()),
        },
      ],
    });
    await client.command({ query: `OPTIMIZE TABLE ${table} FINAL` });

    const result = await client.query({
      query: `SELECT replay_id, retention_policy FROM ${table} ORDER BY replay_id`,
      format: 'JSONEachRow',
    });
    expect(await result.json()).toEqual([
      { replay_id: legacyId, retention_policy: 0 },
      { replay_id: currentId, retention_policy: 1 },
    ]);
  } finally {
    await client.command({ query: `DROP TABLE IF EXISTS ${table}` });
    await client.close();
  }
});
