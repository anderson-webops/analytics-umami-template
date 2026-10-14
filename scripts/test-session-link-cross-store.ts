import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@clickhouse/client';
import { Client } from 'pg';
import { MAX_AUTH_SESSION_ROWS } from '@/lib/share-query-budget';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
const clickhouseUrl = new URL(process.env.CLICKHOUSE_TEST_URL ?? '');
assert.ok(['postgres:', 'postgresql:'].includes(databaseUrl.protocol));
assert.equal(databaseUrl.hostname, '127.0.0.1');
assert.ok(['/postgres', '/umami_event_series_test'].includes(databaseUrl.pathname));
assert.equal(clickhouseUrl.protocol, 'http:');
assert.equal(clickhouseUrl.hostname, '127.0.0.1');
assert.equal(clickhouseUrl.pathname, '/umami_event_series_test');
assert.equal(process.env.CLICKHOUSE_URL, clickhouseUrl.toString());
assert.equal(process.env.KAFKA_URL ?? '', '');

const [
  { default: prisma },
  { default: clickhouseStore },
  { saveSessionLink, publishSessionLink },
  { getLinkedSessionIds },
  { getLinkedDistinctIds },
] = await Promise.all([
  import('@/lib/prisma'),
  import('@/lib/clickhouse'),
  import('@/queries/sql/sessions/saveSessionLink'),
  import('@/queries/sql/sessions/getLinkedSessionIds'),
  import('@/queries/sql/sessions/getLinkedDistinctIds'),
]);
const postgres = new Client({ connectionString: databaseUrl.toString() });
const clickhouse = createClient({ url: clickhouseUrl.toString() });
const websiteId = randomUUID();
const distinctId = 'synthetic-cross-store-identity';
const legacySessionIds = Array.from({ length: MAX_AUTH_SESSION_ROWS - 1 }, () => randomUUID());
let postgresConnected = false;
let testTableCreated = false;

try {
  await postgres.connect();
  postgresConnected = true;
  await clickhouse.command({
    query: `CREATE TABLE session_link (
      website_id UUID,
      session_id UUID,
      distinct_id String,
      created_at DateTime('UTC')
    ) ENGINE = ReplacingMergeTree ORDER BY (website_id, distinct_id, session_id)`,
  });
  testTableCreated = true;
  await clickhouse.insert({
    table: 'session_link',
    format: 'JSONEachRow',
    values: legacySessionIds.map(sessionId => ({
      website_id: websiteId,
      session_id: sessionId,
      distinct_id: distinctId,
      created_at: '2025-01-01 00:00:00',
    })),
  });

  const candidates = Array.from({ length: 8 }, () => randomUUID());
  const outcomes = await Promise.all(
    candidates.map(sessionId =>
      prisma.transaction(transaction =>
        saveSessionLink({ websiteId, distinctId, sessionId }, transaction),
      ),
    ),
  );
  assert.equal(outcomes.filter(Boolean).length, 1);
  const admittedSessionId = candidates[outcomes.findIndex(Boolean)];
  assert.equal(
    (await getLinkedSessionIds(websiteId, distinctId, MAX_AUTH_SESSION_ROWS + 1)).length,
    MAX_AUTH_SESSION_ROWS - 1,
  );
  await publishSessionLink({ websiteId, distinctId, sessionId: admittedSessionId });

  const postgresCount = await postgres.query<{ total: number }>(
    `SELECT count(*)::integer AS total FROM session_link
     WHERE website_id = $1::uuid AND distinct_id = $2::text`,
    [websiteId, distinctId],
  );
  assert.equal(postgresCount.rows[0].total, 1);

  const clickhouseCount = await clickhouse.query({
    query: `SELECT count() AS total FROM session_link
      WHERE website_id = {websiteId:UUID} AND distinct_id = {distinctId:String}`,
    query_params: { websiteId, distinctId },
    format: 'JSONEachRow',
  });
  const legacyCount = (await clickhouseCount.json()) as { total: string }[];
  assert.equal(Number(legacyCount[0].total), MAX_AUTH_SESSION_ROWS);

  const linked = await getLinkedSessionIds(websiteId, distinctId, MAX_AUTH_SESSION_ROWS + 1);
  assert.equal(linked.length, MAX_AUTH_SESSION_ROWS);
  assert.ok(linked.some(({ sessionId }) => sessionId === admittedSessionId));
  assert.ok(linked.some(({ sessionId }) => sessionId === legacySessionIds[0]));
  assert.deepEqual(await getLinkedDistinctIds(websiteId, admittedSessionId, 2), [distinctId]);
  assert.equal(
    await saveSessionLink({ websiteId, distinctId, sessionId: legacySessionIds[0] }),
    true,
  );
  const persistedAfterLegacy = await postgres.query<{ total: number }>(
    `SELECT count(*)::integer AS total FROM session_link
     WHERE website_id = $1::uuid AND distinct_id = $2::text`,
    [websiteId, distinctId],
  );
  assert.equal(persistedAfterLegacy.rows[0].total, 1);
  assert.equal(await saveSessionLink({ websiteId, distinctId, sessionId: randomUUID() }), false);

  const delayedIdentity = 'synthetic-delayed-delivery';
  const delayedSessionId = randomUUID();
  assert.equal(
    await prisma.transaction(transaction =>
      saveSessionLink(
        { websiteId, distinctId: delayedIdentity, sessionId: delayedSessionId },
        transaction,
      ),
    ),
    true,
  );
  const originalInsert = clickhouseStore.insert;
  clickhouseStore.insert = async () => {
    throw new Error('synthetic delivery unavailable');
  };
  try {
    await assert.rejects(
      publishSessionLink({ websiteId, distinctId: delayedIdentity, sessionId: delayedSessionId }),
      /synthetic delivery unavailable/,
    );
  } finally {
    clickhouseStore.insert = originalInsert;
  }
  assert.deepEqual(await getLinkedSessionIds(websiteId, delayedIdentity, 2), []);
  assert.equal(
    await saveSessionLink({ websiteId, distinctId: delayedIdentity, sessionId: delayedSessionId }),
    true,
  );
  assert.deepEqual(
    (await getLinkedSessionIds(websiteId, delayedIdentity, 2)).map(link => link.sessionId),
    [delayedSessionId],
  );

  const rollbackIdentity = 'synthetic-rolled-back-identity';
  await assert.rejects(
    prisma.transaction(async transaction => {
      assert.equal(
        await saveSessionLink(
          { websiteId, distinctId: rollbackIdentity, sessionId: randomUUID() },
          transaction,
        ),
        true,
      );
      throw new Error('synthetic transaction rollback');
    }),
    /synthetic transaction rollback/,
  );
  const rollbackCount = await postgres.query<{ total: number }>(
    `SELECT count(*)::integer AS total FROM session_link
     WHERE website_id = $1::uuid AND distinct_id = $2::text`,
    [websiteId, rollbackIdentity],
  );
  assert.equal(rollbackCount.rows[0].total, 0);

  console.log(
    'Cross-store legacy cap, concurrent admission, confirmed delivery, and rollback passed.',
  );
} finally {
  if (postgresConnected) {
    await postgres.query('DELETE FROM session_link WHERE website_id = $1::uuid', [websiteId]);
    await postgres.end();
  }
  if (testTableCreated) {
    await clickhouse.command({ query: 'DROP TABLE session_link' });
  }
  await clickhouse.close();
  await prisma.client.$disconnect();
}
