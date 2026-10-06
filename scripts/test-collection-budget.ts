import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  COLLECTION_BUDGET_LIMITS,
  CollectionBudgetExceededError,
  getCollectionCost,
} from '@/lib/collection-budget';
import prisma from '@/lib/prisma';
import { reserveActiveCollectionBudget } from '@/queries/prisma/collection';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
const address = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname));
assert.equal(address.pathname, '/postgres');

const userId = randomUUID();
const websiteId = randomUUID();
const linkId = randomUUID();
const pixelId = randomUUID();
const body = {
  type: 'event' as const,
  payload: {
    data: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`key${index}`, 'x'])),
  },
};
const cost = getCollectionCost(body);

async function reserve(sourceType: 'website' | 'link' | 'pixel', sourceId: string) {
  return reserveActiveCollectionBudget(sourceType, sourceId, body);
}

try {
  await prisma.client.user.create({
    data: {
      id: userId,
      username: `collection-budget-${userId}`,
      password: 'x'.repeat(60),
      role: 'user',
    },
  });
  await prisma.client.website.create({
    data: { id: websiteId, name: 'Collection budget website', userId },
  });
  await prisma.client.link.create({
    data: {
      id: linkId,
      name: 'Collection budget link',
      slug: `budget-${linkId}`,
      url: 'https://example.com/',
      userId,
    },
  });
  await prisma.client.pixel.create({
    data: { id: pixelId, name: 'Collection budget pixel', slug: `budget-${pixelId}`, userId },
  });

  await reserve('website', websiteId);
  await reserve('link', linkId);
  await reserve('pixel', pixelId);

  const accountWindows = await prisma.client.collectionIngestBudget.findMany({
    where: { subjectType: 'user', subjectKey: userId },
  });
  assert.equal(accountWindows.length, 2);
  assert.ok(accountWindows.every(window => window.requests === 3n));
  assert.ok(accountWindows.every(window => window.rows === BigInt(cost.rows * 3)));

  const sourceMinute = await prisma.client.collectionIngestBudget.findFirstOrThrow({
    where: { subjectType: 'source', subjectKey: `website:${websiteId}`, scope: 'minute' },
  });
  await prisma.client.collectionIngestBudget.update({
    where: {
      subjectType_subjectKey_scope_windowStart: {
        subjectType: 'source',
        subjectKey: `website:${websiteId}`,
        scope: 'minute',
        windowStart: sourceMinute.windowStart,
      },
    },
    data: { rows: BigInt(COLLECTION_BUDGET_LIMITS.source.minute.rows - cost.rows) },
  });
  await reserve('website', websiteId);
  await assert.rejects(
    () => reserve('website', websiteId),
    error => error instanceof CollectionBudgetExceededError && error.retryAfter === 60,
  );

  const accountDay = await prisma.client.collectionIngestBudget.findFirstOrThrow({
    where: { subjectType: 'user', subjectKey: userId, scope: 'day' },
  });
  await prisma.client.collectionIngestBudget.update({
    where: {
      subjectType_subjectKey_scope_windowStart: {
        subjectType: 'user',
        subjectKey: userId,
        scope: 'day',
        windowStart: accountDay.windowStart,
      },
    },
    data: { rows: BigInt(COLLECTION_BUDGET_LIMITS.account.day.rows - cost.rows) },
  });

  const concurrent = await Promise.allSettled([reserve('link', linkId), reserve('pixel', pixelId)]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = concurrent.find(result => result.status === 'rejected');
  assert.ok(rejected?.status === 'rejected');
  assert.ok(rejected.reason instanceof CollectionBudgetExceededError);
  assert.equal(rejected.reason.retryAfter, 86_400);

  const finalAccountDay = await prisma.client.collectionIngestBudget.findUniqueOrThrow({
    where: {
      subjectType_subjectKey_scope_windowStart: {
        subjectType: 'user',
        subjectKey: userId,
        scope: 'day',
        windowStart: accountDay.windowStart,
      },
    },
  });
  assert.equal(finalAccountDay.rows, BigInt(COLLECTION_BUDGET_LIMITS.account.day.rows));

  await assert.rejects(() => reserve('website', randomUUID()), /COLLECTION_SOURCE_NOT_FOUND/);

  console.log('Collection budget passed source, account, exhaustion, and concurrency checks.');
} finally {
  await prisma.client.collectionIngestBudget.deleteMany({
    where: {
      OR: [
        { subjectType: 'user', subjectKey: userId },
        { subjectType: 'source', subjectKey: `website:${websiteId}` },
        { subjectType: 'source', subjectKey: `link:${linkId}` },
        { subjectType: 'source', subjectKey: `pixel:${pixelId}` },
      ],
    },
  });
  await prisma.client.website.deleteMany({ where: { id: websiteId } });
  await prisma.client.link.deleteMany({ where: { id: linkId } });
  await prisma.client.pixel.deleteMany({ where: { id: pixelId } });
  await prisma.client.user.deleteMany({ where: { id: userId } });
  await prisma.client.$disconnect();
}
