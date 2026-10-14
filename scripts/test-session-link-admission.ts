import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { MAX_AUTH_SESSION_ROWS } from '@/lib/share-query-budget';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['postgres:', 'postgresql:'].includes(databaseUrl.protocol));
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname));
assert.equal(databaseUrl.pathname, '/postgres');
assert.equal(process.env.CLICKHOUSE_URL ?? '', '');
assert.equal(process.env.KAFKA_URL ?? '', '');

const [{ default: prisma }, { saveSessionLink }] = await Promise.all([
  import('@/lib/prisma'),
  import('@/queries/sql/sessions/saveSessionLink'),
]);
const websiteId = randomUUID();
const otherWebsiteId = randomUUID();
const distinctId = 'synthetic-session-link-admission';
const admin = new Client({ connectionString: databaseUrl.toString() });
let connected = false;

try {
  await admin.connect();
  connected = true;
  await admin.query(
    `INSERT INTO session_link (website_id, session_id, distinct_id)
     SELECT $1::uuid, gen_random_uuid(), $2::text
     FROM generate_series(1, $3::integer)`,
    [websiteId, distinctId, MAX_AUTH_SESSION_ROWS - 1],
  );

  const candidates = Array.from({ length: 8 }, () => randomUUID());
  const outcomes = await Promise.all(
    candidates.map(sessionId =>
      prisma.transaction(transaction =>
        saveSessionLink({ websiteId, distinctId, sessionId }, transaction),
      ),
    ),
  );
  assert.equal(outcomes.filter(Boolean).length, 1);

  const countLinks = async (siteId: string, identity: string) => {
    const result = await admin.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM session_link
       WHERE website_id = $1::uuid AND distinct_id = $2::text`,
      [siteId, identity],
    );
    return result.rows[0].count;
  };

  assert.equal(await countLinks(websiteId, distinctId), MAX_AUTH_SESSION_ROWS);
  const admittedSessionId = candidates[outcomes.findIndex(Boolean)];
  assert.equal(
    await saveSessionLink({ websiteId, distinctId, sessionId: admittedSessionId }),
    true,
  );
  assert.equal(await saveSessionLink({ websiteId, distinctId, sessionId: randomUUID() }), false);
  assert.equal(await countLinks(websiteId, distinctId), MAX_AUTH_SESSION_ROWS);

  assert.equal(
    await saveSessionLink({ websiteId: otherWebsiteId, distinctId, sessionId: randomUUID() }),
    true,
  );
  assert.equal(await countLinks(otherWebsiteId, distinctId), 1);
  assert.equal(
    await saveSessionLink({ websiteId, distinctId: 'another-identity', sessionId: randomUUID() }),
    true,
  );
  assert.equal(await countLinks(websiteId, 'another-identity'), 1);

  console.log('Session-link admission, concurrent cap, duplicate, and scope checks passed.');
} finally {
  if (connected) {
    await admin.query('DELETE FROM session_link WHERE website_id = ANY($1::uuid[])', [
      [websiteId, otherWebsiteId],
    ]);
    await admin.end();
  }
  await prisma.client.$disconnect();
}
