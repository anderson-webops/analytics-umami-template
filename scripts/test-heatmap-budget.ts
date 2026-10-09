import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
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
