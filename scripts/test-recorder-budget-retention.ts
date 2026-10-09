import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { HeatmapBudgetExceededError, reserveHeatmapBudget } from '@/lib/heatmap-budget';
import {
  MAX_RECORDER_ACCOUNT_NEW_VISIT_KEYS_PER_DAY,
  MAX_RECORDER_NEW_VISIT_KEYS_PER_DAY,
  MAX_RECORDER_NEW_VISIT_KEYS_PER_MINUTE,
  reserveRecorderVisitKeyBudget,
} from '@/lib/recorder-budget';
import { ReplayBudgetExceededError, reserveReplayBudget } from '@/lib/replay-budget';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname));

const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const account = { accountType: 'user' as const, accountId: randomUUID() };
const websiteId = randomUUID();
const otherWebsiteId = randomUUID();
const replayVisitId = randomUUID();
const heatmapVisitId = randomUUID();
let created = false;
let otherCreated = false;

async function replay(visitId: string, chunkIndex: number, sourceId = websiteId) {
  return client.$transaction(transaction =>
    reserveReplayBudget(transaction, {
      websiteId: sourceId,
      ...account,
      visitId,
      chunkIndex,
      idempotent: true,
      bytes: 100,
      events: 1,
    }),
  );
}

async function heatmap(visitId: string, sourceId = websiteId) {
  return client.$transaction(transaction =>
    reserveHeatmapBudget(transaction, {
      websiteId: sourceId,
      ...account,
      visitId,
      bytes: 100,
      events: 1,
    }),
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
  await client.user.create({
    data: {
      id: account.accountId,
      username: `recorder-budget-${account.accountId}`,
      password: 'x'.repeat(60),
      role: 'user',
    },
  });
  await client.website.create({
    data: {
      id: websiteId,
      name: 'Synthetic recorder budget retention',
      userId: account.accountId,
      recorderEnabled: true,
      replayConfig: { replayEnabled: true, heatmapEnabled: true },
    },
  });
  created = true;

  assert.equal(await replay(replayVisitId, 1), true);
  await heatmap(heatmapVisitId);
  const accountDayBudgets = await client.collectionIngestBudget.findMany({
    where: { subjectType: 'user', subjectKey: account.accountId, scope: 'day' },
  });
  assert.equal(
    accountDayBudgets.reduce((total, row) => total + row.requests, 0n),
    2n,
  );
  assert.equal(
    accountDayBudgets.reduce((total, row) => total + row.rows, 0n),
    2n,
  );
  assert.equal(
    accountDayBudgets.reduce((total, row) => total + row.bytes, 0n),
    1_224n,
  );
  assertBoundedExpiry((await budget(replayVisitId)).expiresAt);
  assertBoundedExpiry((await budget(`heatmap:${heatmapVisitId}`)).expiresAt);
  const initialKeyBudgets = await client.replayIngestBudget.findMany({
    where: { websiteId, scopeKey: { startsWith: 'recorder-visits:' } },
  });
  assert.equal(initialKeyBudgets.length, 2);
  assert.ok(initialKeyBudgets.every(row => row.chunks === 2 && row.expiresAt));

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

  const minuteNow = Date.now();
  const minuteScopeKey = `recorder-visits:${new Date(Math.floor(minuteNow / 60_000) * 60_000).toISOString()}`;
  const minuteKeyBudget = await client.replayIngestBudget.upsert({
    where: {
      websiteId_scope_scopeKey: {
        websiteId,
        scope: 'minute',
        scopeKey: minuteScopeKey,
      },
    },
    update: { chunks: MAX_RECORDER_NEW_VISIT_KEYS_PER_MINUTE },
    create: {
      websiteId,
      scope: 'minute',
      scopeKey: minuteScopeKey,
      chunks: MAX_RECORDER_NEW_VISIT_KEYS_PER_MINUTE,
      expiresAt: new Date(minuteNow + 120_000),
    },
  });
  assert.equal(
    await client.$transaction(transaction =>
      reserveRecorderVisitKeyBudget(transaction, websiteId, minuteNow, account),
    ),
    60,
  );
  await client.replayIngestBudget.update({
    where: {
      websiteId_scope_scopeKey: {
        websiteId,
        scope: 'minute',
        scopeKey: minuteKeyBudget.scopeKey,
      },
    },
    data: { chunks: 0 },
  });

  const dayKeyBudget = await client.replayIngestBudget.findFirstOrThrow({
    where: { websiteId, scope: 'day', scopeKey: { startsWith: 'recorder-visits:' } },
    orderBy: { scopeKey: 'desc' },
  });
  await client.replayIngestBudget.update({
    where: {
      websiteId_scope_scopeKey: {
        websiteId,
        scope: 'day',
        scopeKey: dayKeyBudget.scopeKey,
      },
    },
    data: { chunks: MAX_RECORDER_NEW_VISIT_KEYS_PER_DAY - 1 },
  });
  const priorVisits = await client.replayIngestBudget.count({
    where: { websiteId, scope: 'visit' },
  });
  const concurrent = await Promise.allSettled([replay(randomUUID(), 1), replay(randomUUID(), 1)]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = concurrent.find(result => result.status === 'rejected');
  assert.ok(rejected?.status === 'rejected');
  assert.ok(rejected.reason instanceof ReplayBudgetExceededError);
  assert.equal(rejected.reason.retryAfter, 86_400);
  assert.equal(
    await client.replayIngestBudget.count({ where: { websiteId, scope: 'visit' } }),
    priorVisits + 1,
  );

  await client.website.create({
    data: {
      id: otherWebsiteId,
      name: 'Synthetic second recorder website',
      userId: account.accountId,
      recorderEnabled: true,
      replayConfig: { replayEnabled: true, heatmapEnabled: true },
    },
  });
  otherCreated = true;
  const ownerDay = await client.collectionIngestBudget.findFirstOrThrow({
    where: {
      subjectType: 'user',
      subjectKey: `recorder-visits:${account.accountId}`,
      scope: 'day',
    },
    orderBy: { windowStart: 'desc' },
  });
  await client.collectionIngestBudget.update({
    where: {
      subjectType_subjectKey_scope_windowStart: {
        subjectType: 'user',
        subjectKey: `recorder-visits:${account.accountId}`,
        scope: 'day',
        windowStart: ownerDay.windowStart,
      },
    },
    data: { requests: BigInt(MAX_RECORDER_ACCOUNT_NEW_VISIT_KEYS_PER_DAY - 1) },
  });
  const ownerConcurrent = await Promise.allSettled([
    replay(randomUUID(), 1, otherWebsiteId),
    heatmap(randomUUID(), otherWebsiteId),
  ]);
  assert.equal(ownerConcurrent.filter(result => result.status === 'fulfilled').length, 1);
  const ownerRejected = ownerConcurrent.find(result => result.status === 'rejected');
  assert.ok(ownerRejected?.status === 'rejected');
  assert.ok(
    ownerRejected.reason instanceof ReplayBudgetExceededError ||
      ownerRejected.reason instanceof HeatmapBudgetExceededError,
  );
  assert.equal(ownerRejected.reason.retryAfter, 86_400);
  assert.equal(
    await client.replayIngestBudget.count({ where: { websiteId: otherWebsiteId, scope: 'visit' } }),
    1,
  );
  assert.equal(
    (
      await client.collectionIngestBudget.findUniqueOrThrow({
        where: {
          subjectType_subjectKey_scope_windowStart: {
            subjectType: 'user',
            subjectKey: `recorder-visits:${account.accountId}`,
            scope: 'day',
            windowStart: ownerDay.windowStart,
          },
        },
      })
    ).requests,
    BigInt(MAX_RECORDER_ACCOUNT_NEW_VISIT_KEYS_PER_DAY),
  );
  await assert.rejects(
    () => heatmap(randomUUID()),
    error => error instanceof HeatmapBudgetExceededError && error.retryAfter === 86_400,
  );
  assert.equal(
    await client.replayIngestBudget.count({ where: { websiteId, scope: 'visit' } }),
    priorVisits + 1,
  );
  assert.equal(await replay(replayVisitId, 3), true);
  await heatmap(heatmapVisitId);
  assert.equal(
    await client.replayIngestBudget.count({ where: { websiteId, scope: 'visit' } }),
    priorVisits + 1,
  );

  console.log(
    'Recorder visit budgets passed PostgreSQL expiry, cleanup and atomic new-key cap checks.',
  );
} finally {
  await client.collectionIngestBudget.deleteMany({
    where: {
      OR: [
        { subjectType: 'source', subjectKey: `website:${websiteId}` },
        { subjectType: 'source', subjectKey: `website:${otherWebsiteId}` },
        { subjectType: 'user', subjectKey: account.accountId },
        { subjectType: 'user', subjectKey: `recorder-visits:${account.accountId}` },
      ],
    },
  });
  if (created) {
    await client.replayIngestBudget.deleteMany({ where: { websiteId } });
    await client.website.delete({ where: { id: websiteId } });
  }
  if (otherCreated) {
    await client.replayIngestBudget.deleteMany({ where: { websiteId: otherWebsiteId } });
    await client.website.delete({ where: { id: otherWebsiteId } });
  }
  await client.user.deleteMany({ where: { id: account.accountId } });
  await client.$disconnect();
}
