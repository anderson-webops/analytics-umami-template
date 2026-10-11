import pg from 'pg';

const BATCH_SIZE = 400;
const DEFAULT_MAX_BATCHES = 100;
const MAX_BATCHES = 1000;
const MAX_RUN_MS = 30_000;
const ADVISORY_LOCK_KEY = '60161420261010';
const SAFE_SCHEMA = /^[A-Za-z_][A-Za-z0-9_]*$/;

function getConfiguration() {
  if (process.argv.length !== 2) {
    throw new Error('Unsupported heatmap cleanup arguments.');
  }

  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error('DATABASE_URL is required for heatmap cleanup.');
  }

  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    !url.pathname.replace(/^\//, '')
  ) {
    throw new Error('Heatmap cleanup requires a PostgreSQL database URL.');
  }

  const schema = url.searchParams.has('schema') ? url.searchParams.get('schema') : 'public';
  if (!SAFE_SCHEMA.test(schema)) {
    throw new Error('Heatmap cleanup requires a simple schema name.');
  }
  url.searchParams.delete('schema');

  const limit = process.env.HEATMAP_PRUNE_MAX_BATCHES;
  const maxBatches = limit === undefined ? DEFAULT_MAX_BATCHES : Number(limit);
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > MAX_BATCHES) {
    throw new Error('HEATMAP_PRUNE_MAX_BATCHES is outside the supported range.');
  }

  return { connectionString: url.toString(), schema, maxBatches };
}

async function verifySchema(client, schema) {
  const result = await client.query(`
    SELECT current_schema() AS active_schema,
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'heatmap_event'
          AND column_name = 'retention_expires_at'
          AND data_type = 'timestamp with time zone'
          AND is_nullable = 'YES'
          AND column_default = '(CURRENT_TIMESTAMP + ''30 days''::interval)'
      ) AS retention_column,
      EXISTS (
        SELECT 1 FROM pg_index index_definition
        WHERE index_definition.indexrelid = to_regclass(
            format('%I.%I', current_schema(), 'heatmap_event_retention_expires_at_idx')
          )
          AND index_definition.indrelid = to_regclass(
            format('%I.%I', current_schema(), 'heatmap_event')
          )
          AND index_definition.indisvalid
          AND index_definition.indisready
          AND index_definition.indnkeyatts = 1
          AND index_definition.indexprs IS NULL
          AND pg_get_indexdef(index_definition.indexrelid, 1, true) = 'retention_expires_at'
          AND pg_get_expr(index_definition.indpred, index_definition.indrelid)
            = '(retention_expires_at IS NOT NULL)'
      ) AS retention_index
  `);

  const state = result.rows[0];
  if (
    state?.active_schema !== schema ||
    state?.retention_column !== true ||
    state?.retention_index !== true
  ) {
    throw new Error('Heatmap cleanup schema contract is not satisfied.');
  }
}

async function pruneBatch(client) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    const result = await client.query(
      `WITH expired AS (
        SELECT heatmap_event_id
        FROM heatmap_event
        WHERE retention_expires_at <= CURRENT_TIMESTAMP
        ORDER BY retention_expires_at, heatmap_event_id
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM heatmap_event AS event
      USING expired
      WHERE event.heatmap_event_id = expired.heatmap_event_id`,
      [BATCH_SIZE],
    );
    await client.query('COMMIT');
    return result.rowCount;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function run() {
  const { connectionString, schema, maxBatches } = getConfiguration();
  const client = new pg.Client({
    connectionString,
    options: `-c search_path=${schema}`,
    connectionTimeoutMillis: 5000,
  });
  let deleted = 0;
  let backlogRemains = false;

  try {
    await client.connect();
    await client.query("SET statement_timeout = '5s'");
    await verifySchema(client, schema);
    const lock = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [
      ADVISORY_LOCK_KEY,
    ]);
    if (lock.rows[0]?.acquired !== true) {
      console.log('Heatmap cleanup already running.');
      return;
    }
    const startedAt = Date.now();
    for (let batch = 0; batch < maxBatches; batch += 1) {
      if (Date.now() - startedAt >= MAX_RUN_MS) {
        break;
      }
      const count = await pruneBatch(client);
      deleted += count;
      if (count < BATCH_SIZE) {
        break;
      }
    }
    const backlog = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM heatmap_event
        WHERE retention_expires_at <= CURRENT_TIMESTAMP
      ) AS remaining
    `);
    backlogRemains = backlog.rows[0]?.remaining === true;
  } finally {
    await client.end();
  }

  console.log(`Expired heatmap rows removed: ${deleted}.`);
  if (backlogRemains) {
    console.error('Heatmap cleanup incomplete: expired rows remain.');
    process.exitCode = 2;
  }
}

run().catch(() => {
  console.error('Heatmap cleanup failed.');
  process.exitCode = 1;
});
