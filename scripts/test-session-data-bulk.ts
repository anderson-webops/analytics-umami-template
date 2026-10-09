import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Client } from 'pg';
import type { DynamicData } from '../src/lib/types';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
const originalDatabaseUrl = process.env.DATABASE_URL;
assert.ok(originalDatabaseUrl);
const databaseUrl = new URL(originalDatabaseUrl);
assert.ok(['postgres:', 'postgresql:'].includes(databaseUrl.protocol));
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname));

const schema = `session_data_bulk_${crypto.randomBytes(4).toString('hex')}`;
const admin = new Client({ connectionString: originalDatabaseUrl });
const websiteId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const initialCreatedAt = new Date('2026-07-30T10:00:00.000Z');
const updatedCreatedAt = new Date('2026-07-31T10:00:00.000Z');
let runtimeClient: { $disconnect: () => Promise<void> } | undefined;
let schemaCreated = false;

try {
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  await admin.query(`
    CREATE TABLE "${schema}".session_data (
      session_data_id uuid PRIMARY KEY,
      website_id uuid NOT NULL,
      session_id uuid NOT NULL,
      data_key varchar(500) NOT NULL,
      string_value varchar(500),
      number_value numeric(19, 4),
      date_value timestamptz,
      data_type integer NOT NULL,
      distinct_id varchar(50),
      created_at timestamptz DEFAULT now(),
      UNIQUE (session_id, data_key)
    )
  `);

  const [{ relationalQuery }, { default: prisma }] = await Promise.all([
    import('../src/queries/sql/sessions/saveSessionData'),
    import('../src/lib/prisma'),
  ]);
  runtimeClient = prisma.client;
  const write = (data: Parameters<typeof relationalQuery>[0]) =>
    prisma.transaction(async transaction => {
      await transaction.$queryRaw`SELECT set_config('search_path', ${schema}, true)`;
      await relationalQuery(data, transaction);
    });

  await write({
    websiteId,
    sessionId,
    sessionData: Object.fromEntries(
      Array.from({ length: 99 }, (_, index) => [`property_${index}`, index]),
    ),
    distinctId: 'initial-identity',
    createdAt: initialCreatedAt,
  });
  const count = await admin.query<{ count: number }>(
    `SELECT count(*)::integer AS count FROM "${schema}".session_data`,
  );
  assert.equal(count.rows[0].count, 99);

  await write({
    websiteId,
    sessionId,
    sessionData: { 'plan.tier': 'old', plan: { tier: 'new' } } as unknown as DynamicData,
    distinctId: 'initial-identity',
    createdAt: initialCreatedAt,
  });
  const original = await admin.query<{
    session_data_id: string;
    string_value: string;
    distinct_id: string;
    created_at: Date;
  }>(
    `SELECT session_data_id, string_value, distinct_id, created_at
     FROM "${schema}".session_data WHERE session_id = $1 AND data_key = 'plan.tier'`,
    [sessionId],
  );
  assert.equal(original.rows.length, 1);
  assert.equal(original.rows[0].string_value, 'new');

  await write({
    websiteId,
    sessionId,
    sessionData: { plan: { tier: 'changed' } } as unknown as DynamicData,
  });
  const preserved = await admin.query<{
    session_data_id: string;
    string_value: string;
    distinct_id: string;
    created_at: Date;
  }>(
    `SELECT session_data_id, string_value, distinct_id, created_at
     FROM "${schema}".session_data WHERE session_id = $1 AND data_key = 'plan.tier'`,
    [sessionId],
  );
  assert.equal(preserved.rows[0].session_data_id, original.rows[0].session_data_id);
  assert.equal(preserved.rows[0].string_value, 'changed');
  assert.equal(preserved.rows[0].distinct_id, 'initial-identity');
  assert.equal(preserved.rows[0].created_at.toISOString(), initialCreatedAt.toISOString());

  await write({
    websiteId,
    sessionId,
    sessionData: { 'plan.tier': 'final' },
    distinctId: 'updated-identity',
    createdAt: updatedCreatedAt,
  });
  const updated = await admin.query<{
    session_data_id: string;
    string_value: string;
    distinct_id: string;
    created_at: Date;
  }>(
    `SELECT session_data_id, string_value, distinct_id, created_at
     FROM "${schema}".session_data WHERE session_id = $1 AND data_key = 'plan.tier'`,
    [sessionId],
  );
  assert.equal(updated.rows[0].session_data_id, original.rows[0].session_data_id);
  assert.equal(updated.rows[0].string_value, 'final');
  assert.equal(updated.rows[0].distinct_id, 'updated-identity');
  assert.equal(updated.rows[0].created_at.toISOString(), updatedCreatedAt.toISOString());

  await write({
    websiteId,
    sessionId,
    sessionData: {
      amount: 12.5,
      joined: '2026-07-30T10:00:00.000Z',
      "quoted'); DROP TABLE session_data; --": 'safe',
    },
  });
  const typed = await admin.query<{
    data_key: string;
    string_value: string;
    number_value: string | null;
    date_value: Date | null;
  }>(
    `SELECT data_key, string_value, number_value, date_value
     FROM "${schema}".session_data
     WHERE session_id = $1 AND data_key IN ('amount', 'joined', $2)
     ORDER BY data_key`,
    [sessionId, "quoted'); DROP TABLE session_data; --"],
  );
  assert.equal(typed.rows.length, 3);
  assert.equal(Number(typed.rows.find(row => row.data_key === 'amount')?.number_value), 12.5);
  assert.equal(
    typed.rows.find(row => row.data_key === 'joined')?.date_value?.toISOString(),
    initialCreatedAt.toISOString(),
  );
  assert.equal(typed.rows.find(row => row.data_key.startsWith('quoted'))?.string_value, 'safe');
  console.log('Session data bulk-write PostgreSQL regression passed.');
} finally {
  await runtimeClient?.$disconnect();
  if (schemaCreated) {
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  }
  await admin.end();
}
