import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '@/generated/prisma/client';
import { HeatmapBudgetExceededError, reserveHeatmapBudget } from '@/lib/heatmap-budget';
import { saveHeatmapEvents } from '@/queries/sql/heatmap/saveHeatmapEvents';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname));

const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const account = { accountType: 'user' as const, accountId: randomUUID() };
const websiteId = randomUUID();
const visitId = randomUUID();
const sessionId = randomUUID();
let created = false;

async function reserve(visit: string, events: number) {
  return client.$transaction(transaction =>
    reserveHeatmapBudget(transaction, {
      websiteId,
      ...account,
      visitId: visit,
      bytes: events * 5,
      events,
    }),
  );
}

async function rejectedReservation(visit: string, retryAfter?: number) {
  await assert.rejects(
    () => reserve(visit, 1),
    error => {
      assert.ok(error instanceof HeatmapBudgetExceededError);
      assert.equal(error.retryAfter, retryAfter);
      return true;
    },
  );
  assert.equal(
    await client.replayIngestBudget.count({
      where: { websiteId, scope: 'visit', scopeKey: `heatmap:${visit}` },
    }),
    0,
  );
}

try {
  const [{ column_default: retentionDefault }] = await client.$queryRaw<
    Array<{ column_default: string }>
  >`
    SELECT column_default
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'heatmap_event'
      AND column_name = 'retention_expires_at'
  `;
  assert.equal(retentionDefault, "(CURRENT_TIMESTAMP + '30 days'::interval)");
  await client.$executeRawUnsafe(
    "ALTER TABLE heatmap_event ALTER COLUMN retention_expires_at SET DEFAULT CURRENT_TIMESTAMP + INTERVAL '365 days'",
  );
  try {
    const guard = spawnSync(process.execPath, ['scripts/check-db.js', '--migrate-only'], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
    });
    assert.notEqual(guard.status, 0);
    assert.match(`${guard.stdout}${guard.stderr}`, /Database schema is incomplete after migration/);
    const cleanup = spawnSync(process.execPath, ['scripts/prune-expired-heatmap-events.mjs'], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
    });
    assert.notEqual(cleanup.status, 0);
    assert.match(cleanup.stderr, /Heatmap cleanup failed/);
  } finally {
    await client.$executeRawUnsafe(
      "ALTER TABLE heatmap_event ALTER COLUMN retention_expires_at SET DEFAULT CURRENT_TIMESTAMP + INTERVAL '30 days'",
    );
  }

  await client.user.create({
    data: {
      id: account.accountId,
      username: `heatmap-budget-${account.accountId}`,
      password: 'x'.repeat(60),
      role: 'user',
    },
  });
  await client.website.create({
    data: {
      id: websiteId,
      name: 'Synthetic heatmap budget',
      userId: account.accountId,
      recorderEnabled: true,
      replayConfig: { heatmapEnabled: true },
    },
  });
  created = true;

  await client.$transaction(async transaction => {
    await reserveHeatmapBudget(transaction, {
      websiteId,
      ...account,
      visitId,
      bytes: 120,
      events: 1,
    });
    await saveHeatmapEvents(
      [
        {
          websiteId,
          sessionId,
          visitId,
          urlPath: '/',
          eventType: 1,
          x: 1,
          y: 2,
          pageX: null,
          pageY: null,
          pageW: null,
          viewportW: null,
          viewportH: null,
          pageH: null,
          scrollPct: null,
          createdAt: new Date(),
        },
      ],
      transaction,
    );
  });
  assert.equal(await client.heatmapEvent.count({ where: { websiteId } }), 1);

  const historical = await client.heatmapEvent.findFirstOrThrow({ where: { websiteId } });
  assert.ok(historical.retentionExpiresAt);
  assert.ok(historical.retentionExpiresAt.getTime() > Date.now() + 29 * 86_400_000);
  assert.ok(historical.retentionExpiresAt.getTime() < Date.now() + 31 * 86_400_000);
  await client.heatmapEvent.update({
    where: { id: historical.id },
    data: { retentionExpiresAt: null },
  });
  const expired = await client.heatmapEvent.create({
    data: {
      id: randomUUID(),
      websiteId,
      sessionId,
      visitId,
      urlPath: '/',
      eventType: 1,
      createdAt: new Date(),
    },
  });
  await client.$executeRaw`
    UPDATE heatmap_event
    SET retention_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
    WHERE heatmap_event_id = ${expired.id}::uuid
  `;
  const [{ eligible }] = await client.$queryRaw<Array<{ eligible: bigint }>>`
    SELECT count(*) AS eligible
    FROM heatmap_event
    WHERE retention_expires_at <= CURRENT_TIMESTAMP
  `;
  assert.equal(eligible, 1n);
  assert.equal(await client.heatmapEvent.count({ where: { id: expired.id } }), 1);
  const firstCleanup = spawnSync(process.execPath, ['scripts/prune-expired-heatmap-events.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, HEATMAP_PRUNE_MAX_BATCHES: '1' },
    encoding: 'utf8',
  });
  assert.equal(firstCleanup.status, 0, firstCleanup.stderr);
  assert.match(firstCleanup.stdout, /Expired heatmap rows removed: 1/);
  assert.equal(await client.heatmapEvent.count({ where: { id: expired.id } }), 0);
  assert.equal(await client.heatmapEvent.count({ where: { id: historical.id } }), 1);

  const inactiveExpired = await client.heatmapEvent.create({
    data: {
      id: randomUUID(),
      websiteId,
      sessionId,
      visitId,
      urlPath: '/',
      eventType: 1,
      createdAt: new Date(),
    },
  });
  await client.$executeRaw`
    UPDATE heatmap_event
    SET retention_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
    WHERE heatmap_event_id = ${inactiveExpired.id}::uuid
  `;
  const lockClient = new pg.Client({ connectionString: databaseUrl });
  await lockClient.connect();
  try {
    await lockClient.query('SELECT pg_advisory_lock($1::bigint)', ['60161420261010']);
    const blockedCleanup = spawnSync(
      process.execPath,
      ['scripts/prune-expired-heatmap-events.mjs'],
      {
        cwd: process.cwd(),
        env: { ...process.env, HEATMAP_PRUNE_MAX_BATCHES: '1' },
        encoding: 'utf8',
      },
    );
    assert.equal(blockedCleanup.status, 0, blockedCleanup.stderr);
    assert.match(blockedCleanup.stdout, /Heatmap cleanup already running/);
    assert.equal(await client.heatmapEvent.count({ where: { id: inactiveExpired.id } }), 1);
  } finally {
    await lockClient.end();
  }
  const cleanup = spawnSync(process.execPath, ['scripts/prune-expired-heatmap-events.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, HEATMAP_PRUNE_MAX_BATCHES: '1' },
    encoding: 'utf8',
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.match(cleanup.stdout, /Expired heatmap rows removed: 1/);
  assert.equal(await client.heatmapEvent.count({ where: { id: inactiveExpired.id } }), 0);
  assert.equal(await client.heatmapEvent.count({ where: { id: historical.id } }), 1);

  await client.heatmapEvent.createMany({
    data: Array.from({ length: 401 }, () => ({
      id: randomUUID(),
      websiteId,
      sessionId,
      visitId,
      urlPath: '/expired-batch',
      eventType: 1,
      createdAt: new Date(),
    })),
  });
  await client.$executeRaw`
    UPDATE heatmap_event
    SET retention_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
    WHERE website_id = ${websiteId}::uuid AND url_path = '/expired-batch'
  `;
  const firstBatch = spawnSync(process.execPath, ['scripts/prune-expired-heatmap-events.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, HEATMAP_PRUNE_MAX_BATCHES: '1' },
    encoding: 'utf8',
  });
  assert.equal(firstBatch.status, 2, firstBatch.stderr);
  assert.match(firstBatch.stdout, /Expired heatmap rows removed: 400/);
  assert.match(firstBatch.stderr, /Heatmap cleanup incomplete: expired rows remain/);
  assert.equal(
    await client.heatmapEvent.count({ where: { websiteId, urlPath: '/expired-batch' } }),
    1,
  );
  const secondBatch = spawnSync(process.execPath, ['scripts/prune-expired-heatmap-events.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, HEATMAP_PRUNE_MAX_BATCHES: '1' },
    encoding: 'utf8',
  });
  assert.equal(secondBatch.status, 0, secondBatch.stderr);
  assert.match(secondBatch.stdout, /Expired heatmap rows removed: 1/);
  assert.equal(
    await client.heatmapEvent.count({ where: { websiteId, urlPath: '/expired-batch' } }),
    0,
  );
  assert.equal(await client.heatmapEvent.count({ where: { id: historical.id } }), 1);

  const exhaustedVisit = randomUUID();
  for (let index = 0; index < 25; index++) {
    await reserve(exhaustedVisit, 200);
  }
  await assert.rejects(() => reserve(exhaustedVisit, 1), HeatmapBudgetExceededError);
  const visitBudget = await client.replayIngestBudget.findUniqueOrThrow({
    where: {
      websiteId_scope_scopeKey: {
        websiteId,
        scope: 'visit',
        scopeKey: `heatmap:${exhaustedVisit}`,
      },
    },
  });
  assert.equal(visitBudget.events, 5_000);

  const concurrentVisit = randomUUID();
  await reserve(concurrentVisit, 4_999);
  const concurrentResults = await Promise.allSettled([
    reserve(concurrentVisit, 1),
    reserve(concurrentVisit, 1),
  ]);
  assert.equal(concurrentResults.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(concurrentResults.filter(result => result.status === 'rejected').length, 1);
  assert.equal(
    (
      await client.replayIngestBudget.findUniqueOrThrow({
        where: {
          websiteId_scope_scopeKey: {
            websiteId,
            scope: 'visit',
            scopeKey: `heatmap:${concurrentVisit}`,
          },
        },
      })
    ).events,
    5_000,
  );

  const sourceWindows = await client.replayIngestBudget.findMany({
    where: {
      websiteId,
      scope: { in: ['minute', 'day'] },
      scopeKey: { startsWith: 'heatmap:' },
    },
  });
  assert.ok(sourceWindows.length >= 2);
  const minute = sourceWindows
    .filter(row => row.scope === 'minute')
    .sort((left, right) => left.scopeKey.localeCompare(right.scopeKey))
    .at(-1);
  const day = sourceWindows
    .filter(row => row.scope === 'day')
    .sort((left, right) => left.scopeKey.localeCompare(right.scopeKey))
    .at(-1);
  assert.ok(minute);
  assert.ok(day);

  await client.replayIngestBudget.update({
    where: { websiteId_scope_scopeKey: { websiteId, scope: 'minute', scopeKey: minute.scopeKey } },
    data: { events: 20_000 },
  });
  await rejectedReservation(randomUUID(), 60);

  await client.replayIngestBudget.update({
    where: { websiteId_scope_scopeKey: { websiteId, scope: 'minute', scopeKey: minute.scopeKey } },
    data: { events: 0, chunks: 5_000 },
  });
  await rejectedReservation(randomUUID(), 60);

  await client.replayIngestBudget.update({
    where: { websiteId_scope_scopeKey: { websiteId, scope: 'minute', scopeKey: minute.scopeKey } },
    data: { events: 0, chunks: 0 },
  });
  await client.replayIngestBudget.update({
    where: { websiteId_scope_scopeKey: { websiteId, scope: 'day', scopeKey: day.scopeKey } },
    data: { events: 500_000 },
  });
  await rejectedReservation(randomUUID(), 86_400);

  console.log('Heatmap budget passed PostgreSQL visit, window, rollback and sink checks.');
} finally {
  await client.collectionIngestBudget.deleteMany({
    where: {
      OR: [
        { subjectType: 'source', subjectKey: `website:${websiteId}` },
        { subjectType: 'user', subjectKey: account.accountId },
        { subjectType: 'user', subjectKey: `recorder-visits:${account.accountId}` },
      ],
    },
  });
  if (created) {
    await client.heatmapEvent.deleteMany({ where: { websiteId } });
    await client.replayIngestBudget.deleteMany({ where: { websiteId } });
    await client.website.delete({ where: { id: websiteId } });
  }
  await client.user.deleteMany({ where: { id: account.accountId } });
  await client.$disconnect();
}
