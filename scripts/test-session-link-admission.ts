import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { OPERATORS } from '@/lib/constants';
import { MAX_AUTH_SESSION_ROWS } from '@/lib/share-query-budget';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['postgres:', 'postgresql:'].includes(databaseUrl.protocol));
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname));
assert.equal(databaseUrl.pathname, '/postgres');
assert.equal(process.env.CLICKHOUSE_URL ?? '', '');
assert.equal(process.env.KAFKA_URL ?? '', '');

const [
  { default: prisma },
  { saveSessionLink },
  { getLinkedSessionIds },
  { getVerifiedIdentitySearchSessions, IdentitySearchTooBroadError },
  { getVerifiedIdentityFilterSessions },
  { getValues },
  { getSessionMetrics },
  { getSessionExpandedMetrics },
] = await Promise.all([
  import('@/lib/prisma'),
  import('@/queries/sql/sessions/saveSessionLink'),
  import('@/queries/sql/sessions/getLinkedSessionIds'),
  import('@/queries/sql/sessions/getVerifiedIdentitySearchSessions'),
  import('@/queries/sql/sessions/getVerifiedIdentityFilterSessions'),
  import('@/queries/sql/getValues'),
  import('@/queries/sql/sessions/getSessionMetrics'),
  import('@/queries/sql/sessions/getSessionExpandedMetrics'),
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
      prisma.transaction(
        transaction => saveSessionLink({ websiteId, distinctId, sessionId }, transaction),
        { maxWait: 30_000, timeout: 30_000 },
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
  assert.deepEqual(
    (await getLinkedSessionIds(websiteId, distinctId, MAX_AUTH_SESSION_ROWS + 1)).map(
      link => link.sessionId,
    ),
    [admittedSessionId],
  );
  assert.equal(
    await saveSessionLink({ websiteId, distinctId, sessionId: admittedSessionId }),
    true,
  );
  const legacySessionId = (
    await admin.query<{ session_id: string }>(
      `SELECT session_id FROM session_link WHERE website_id = $1::uuid AND trust_tier = 0 LIMIT 1`,
      [websiteId],
    )
  ).rows[0].session_id;
  assert.equal(await saveSessionLink({ websiteId, distinctId, sessionId: legacySessionId }), true);
  assert.equal(
    (await getLinkedSessionIds(websiteId, distinctId, MAX_AUTH_SESSION_ROWS + 1)).length,
    2,
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

  const unverifiedOnlySessionId = randomUUID();
  await admin.query(
    `INSERT INTO session_link (website_id, session_id, distinct_id)
     VALUES ($1::uuid, $2::uuid, $3::text)`,
    [websiteId, unverifiedOnlySessionId, 'legacy-unverified-only'],
  );
  assert.deepEqual(
    new Set(await getVerifiedIdentitySearchSessions(websiteId, 'session-link-adm')),
    new Set([admittedSessionId, legacySessionId]),
  );
  assert.deepEqual(
    await getVerifiedIdentitySearchSessions(websiteId, distinctId, admittedSessionId),
    [admittedSessionId],
  );
  assert.deepEqual(
    await getVerifiedIdentitySearchSessions(websiteId, 'legacy-unverified-only'),
    [],
  );
  assert.deepEqual(await getVerifiedIdentitySearchSessions(otherWebsiteId, 'another-identity'), []);

  const anotherSessionId = (
    await getLinkedSessionIds(websiteId, 'another-identity', MAX_AUTH_SESSION_ROWS + 1)
  )[0].sessionId;
  const verifiedIdentitySessions = [admittedSessionId, legacySessionId].sort();
  assert.deepEqual(
    (await getVerifiedIdentityFilterSessions(websiteId, OPERATORS.equals, [distinctId])).sort(),
    verifiedIdentitySessions,
  );
  assert.deepEqual(
    await getVerifiedIdentityFilterSessions(websiteId, OPERATORS.notEquals, [distinctId]),
    [anotherSessionId],
  );
  assert.deepEqual(
    (await getVerifiedIdentityFilterSessions(websiteId, OPERATORS.contains, 'session-link')).sort(),
    verifiedIdentitySessions,
  );
  assert.deepEqual(
    await getVerifiedIdentityFilterSessions(websiteId, OPERATORS.doesNotContain, 'session-link'),
    [anotherSessionId],
  );
  assert.deepEqual(
    (await getVerifiedIdentityFilterSessions(websiteId, OPERATORS.regex, '^synthetic')).sort(),
    verifiedIdentitySessions,
  );
  assert.deepEqual(
    await getVerifiedIdentityFilterSessions(websiteId, OPERATORS.notRegex, '^synthetic'),
    [anotherSessionId],
  );
  assert.deepEqual(
    await getVerifiedIdentityFilterSessions(websiteId, OPERATORS.equals, [
      'legacy-unverified-only',
    ]),
    [],
  );
  assert.deepEqual(
    await getVerifiedIdentityFilterSessions(otherWebsiteId, OPERATORS.equals, ['another-identity']),
    [],
  );

  await admin.query(
    `INSERT INTO session_link (website_id, session_id, distinct_id, trust_tier)
     VALUES ($1::uuid, $2::uuid, $3::text, 1)`,
    [websiteId, admittedSessionId, 'another-identity'],
  );
  assert.deepEqual(
    await getVerifiedIdentityFilterSessions(websiteId, OPERATORS.notEquals, [distinctId]),
    [anotherSessionId],
  );
  assert.deepEqual(
    await getVerifiedIdentityFilterSessions(websiteId, OPERATORS.doesNotContain, 'session-link'),
    [anotherSessionId],
  );
  assert.deepEqual(
    await getVerifiedIdentityFilterSessions(websiteId, OPERATORS.notRegex, '^synthetic'),
    [anotherSessionId],
  );

  const filterRows = async (distinctIdFilter: string) => {
    const { filterQuery, queryParams } = prisma.parseFilters({
      websiteId,
      distinctId: distinctIdFilter,
    });
    const rows = await prisma.rawQuery(
      `select website_event.session_id as "sessionId"
       from (values
         ({{websiteId::uuid}}, {{admittedSessionId::uuid}}),
         ({{websiteId::uuid}}, {{legacySessionId::uuid}}),
         ({{websiteId::uuid}}, {{anotherSessionId::uuid}}),
         ({{websiteId::uuid}}, {{unverifiedOnlySessionId::uuid}})
       ) as website_event(website_id, session_id)
       where true ${filterQuery}`,
      {
        ...queryParams,
        admittedSessionId,
        legacySessionId,
        anotherSessionId,
        unverifiedOnlySessionId,
      },
    );
    return (rows as { sessionId: string }[]).map(row => row.sessionId).sort();
  };
  assert.deepEqual(await filterRows(`eq.${distinctId}`), verifiedIdentitySessions);
  assert.deepEqual(await filterRows(`neq.${distinctId}`), [anotherSessionId]);
  assert.deepEqual(await filterRows('eq.legacy-unverified-only'), []);

  const reportSessionIds = [
    admittedSessionId,
    legacySessionId,
    anotherSessionId,
    unverifiedOnlySessionId,
  ];
  for (const sessionId of reportSessionIds) {
    await admin.query(
      `INSERT INTO session (session_id, website_id, distinct_id, created_at)
       VALUES ($1::uuid, $2::uuid, $3::text, now())
       ON CONFLICT (session_id) DO UPDATE SET
         distinct_id = EXCLUDED.distinct_id,
         created_at = EXCLUDED.created_at`,
      [sessionId, websiteId, 'forged-raw-identity'],
    );
    await admin.query(
      `INSERT INTO website_event (event_id, website_id, session_id, visit_id, url_path)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, '/synthetic')`,
      [randomUUID(), websiteId, sessionId, randomUUID()],
    );
  }
  const reportFilters = {
    startDate: new Date(Date.now() - 86_400_000),
    endDate: new Date(Date.now() + 86_400_000),
  };
  const reportCounts = await admin.query<{
    sessions: number;
    links: number;
    joined: number;
  }>(
    `SELECT
      (SELECT count(*)::integer FROM session WHERE website_id = $1::uuid) AS sessions,
      (SELECT count(*)::integer FROM session_link WHERE website_id = $1::uuid AND trust_tier = 1) AS links,
      (SELECT count(*)::integer FROM session_link verified_link
       JOIN session ON session.session_id = verified_link.session_id
       WHERE verified_link.website_id = $1::uuid AND verified_link.trust_tier = 1) AS joined`,
    [websiteId],
  );
  assert.deepEqual(reportCounts.rows[0], { sessions: 4, links: 4, joined: 4 });
  const sourceRows = await admin.query<{ count: number }>(
    `SELECT count(*)::integer AS count
     FROM session_link verified_link
     JOIN session ON session.website_id = verified_link.website_id
       AND session.session_id = verified_link.session_id
     WHERE verified_link.website_id = $1::uuid
       AND verified_link.trust_tier = 1
       AND session.created_at BETWEEN $2::timestamptz AND $3::timestamptz`,
    [websiteId, reportFilters.startDate, reportFilters.endDate],
  );
  assert.equal(sourceRows.rows[0].count, 4);
  const expectedIdentities = new Set([distinctId, 'another-identity']);
  const identityValues = await getValues(websiteId, 'distinct_id', reportFilters);
  assert.deepEqual(new Set(identityValues.map(row => row.value)), expectedIdentities);
  assert.deepEqual(
    new Map(identityValues.map(row => [row.value, Number(row.count)])),
    new Map([...expectedIdentities].map(identity => [identity, 2])),
  );
  assert.deepEqual(
    (await getValues(websiteId, 'distinct_id', { ...reportFilters, search: 'another' })).map(
      row => row.value,
    ),
    ['another-identity'],
  );
  const identityMetrics = await getSessionMetrics(websiteId, { type: 'distinctId' }, reportFilters);
  assert.deepEqual(new Set(identityMetrics.map(row => row.x)), expectedIdentities);
  assert.deepEqual(
    new Map(identityMetrics.map(row => [row.x, Number(row.y)])),
    new Map([...expectedIdentities].map(identity => [identity, 2])),
  );
  const expandedIdentityMetrics = await getSessionExpandedMetrics(
    websiteId,
    { type: 'distinctId' },
    reportFilters,
  );
  assert.deepEqual(new Set(expandedIdentityMetrics.map(row => row.name)), expectedIdentities);
  assert.deepEqual(
    new Map(expandedIdentityMetrics.map(row => [row.name, Number(row.visitors)])),
    new Map([...expectedIdentities].map(identity => [identity, 2])),
  );

  await admin.query(
    `INSERT INTO session_link (website_id, session_id, distinct_id, trust_tier)
     SELECT $1::uuid, gen_random_uuid(), 'wide-' || source_id, 1
     FROM generate_series(1, $2::integer) AS source_id`,
    [websiteId, MAX_AUTH_SESSION_ROWS + 1],
  );
  await assert.rejects(
    getVerifiedIdentityFilterSessions(websiteId, OPERATORS.contains, 'wide-'),
    IdentitySearchTooBroadError,
  );

  console.log('Session-link admission, verified search/filter, and broad-match checks passed.');
} finally {
  if (connected) {
    await admin.query('DELETE FROM website_event WHERE website_id = ANY($1::uuid[])', [
      [websiteId, otherWebsiteId],
    ]);
    await admin.query('DELETE FROM session WHERE website_id = ANY($1::uuid[])', [
      [websiteId, otherWebsiteId],
    ]);
    await admin.query('DELETE FROM session_link WHERE website_id = ANY($1::uuid[])', [
      [websiteId, otherWebsiteId],
    ]);
    await admin.end();
  }
  await prisma.client.$disconnect();
}
