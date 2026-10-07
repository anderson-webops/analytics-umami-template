import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { reserveHeatmapBudget } from '@/lib/heatmap-budget';
import { reserveReplayBudget } from '@/lib/replay-budget';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname));

const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const websiteId = randomUUID();
const replayVisitId = randomUUID();
const heatmapVisitId = randomUUID();
let created = false;

async function replay(visitId: string, chunkIndex: number) {
  return client.$transaction(transaction =>
    reserveReplayBudget(transaction, {
      websiteId,
      visitId,
      chunkIndex,
      idempotent: true,
      bytes: 100,
      events: 1,
    }),
  );
}

async function heatmap(visitId: string) {
  return client.$transaction(transaction =>
    reserveHeatmapBudget(transaction, { websiteId, visitId, bytes: 100, events: 1 }),
  );
}

async function budget(scopeKey: string) {
  return client.replayIngestBudget.findUniqueOrThrow({
    where: { websiteId_scope_scopeKey: { websiteId, scope: 'visit', scopeKey } },
  });
}

function assertBoundedExpiry(expiresAt: Date | null) {
  assert.ok(expiresAt);
  assert.ok(expiresAt.getTime() > Date.now() + 37 * 24 * 60 * 60 * 1000);
  assert.ok(expiresAt.getTime() < Date.now() + 39 * 24 * 60 * 60 * 1000);
}

try {
  await client.website.create({
    data: {
      id: websiteId,
      name: 'Synthetic recorder budget retention',
      userId: '41e2b680-648e-4b09-bcd7-3e2b10c06264',
      recorderEnabled: true,
      replayConfig: { replayEnabled: true, heatmapEnabled: true },
    },
  });
  created = true;

  assert.equal(await replay(replayVisitId, 1), true);
  await heatmap(heatmapVisitId);
  assertBoundedExpiry((await budget(replayVisitId)).expiresAt);
  assertBoundedExpiry((await budget(`heatmap:${heatmapVisitId}`)).expiresAt);

  for (const scopeKey of [replayVisitId, `heatmap:${heatmapVisitId}`]) {
    await client.replayIngestBudget.update({
      where: { websiteId_scope_scopeKey: { websiteId, scope: 'visit', scopeKey } },
      data: { expiresAt: null },
    });
  }
  assert.equal(await replay(replayVisitId, 2), true);
  await heatmap(heatmapVisitId);
  const replayBudget = await budget(replayVisitId);
  const heatmapBudget = await budget(`heatmap:${heatmapVisitId}`);
  assertBoundedExpiry(replayBudget.expiresAt);
  assertBoundedExpiry(heatmapBudget.expiresAt);
  assert.deepEqual(replayBudget.chunkIndices, [1, 2]);
  assert.equal(replayBudget.bytes, 200n);
  assert.equal(heatmapBudget.bytes, 200n);
  assert.equal(await replay(replayVisitId, 2), false);
  assert.equal((await budget(replayVisitId)).bytes, 200n);

  const staleReplayKey = randomUUID();
  await client.replayIngestBudget.create({
    data: {
      websiteId,
      scope: 'visit',
      scopeKey: staleReplayKey,
    },
  });
  await client.$executeRaw`
    UPDATE replay_ingest_budget SET expires_at = now() - INTERVAL '1 minute'
    WHERE website_id = ${websiteId}::uuid AND scope = 'visit' AND scope_key = ${staleReplayKey}
  `;
  const expiredBeforeReplay = await client.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*)::bigint AS count FROM replay_ingest_budget WHERE expires_at < now()
  `;
  assert.equal(expiredBeforeReplay[0].count, 1n);
  await replay(randomUUID(), 1);
  assert.equal(
    await client.replayIngestBudget.count({
      where: { websiteId, scope: 'visit', scopeKey: staleReplayKey },
    }),
    0,
  );

  const staleHeatmapKey = `heatmap:${randomUUID()}`;
  await client.replayIngestBudget.create({
    data: {
      websiteId,
      scope: 'visit',
      scopeKey: staleHeatmapKey,
    },
  });
  await client.$executeRaw`
    UPDATE replay_ingest_budget SET expires_at = now() - INTERVAL '1 minute'
    WHERE website_id = ${websiteId}::uuid AND scope = 'visit' AND scope_key = ${staleHeatmapKey}
  `;
  await heatmap(randomUUID());
  assert.equal(
    await client.replayIngestBudget.count({
      where: { websiteId, scope: 'visit', scopeKey: staleHeatmapKey },
    }),
    0,
  );

  console.log('Recorder visit budgets passed PostgreSQL expiry, legacy-null and cleanup checks.');
} finally {
  if (created) {
    await client.replayIngestBudget.deleteMany({ where: { websiteId } });
    await client.website.delete({ where: { id: websiteId } });
  }
  await client.$disconnect();
}
