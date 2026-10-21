import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  COLLECTION_ANONYMOUS_BUDGET_LIMITS,
  COLLECTION_BUDGET_LIMITS,
  COLLECTION_CLIENT_BUDGET_LIMITS,
  type CollectionAdmissionClass,
  CollectionBudgetExceededError,
  getCollectionCost,
} from '@/lib/collection-budget';
import { getCollectionClientKeys } from '@/lib/collection-client-key';
import {
  type BackendCollectionRequest,
  CollectionRequestReplayError,
} from '@/lib/collection-proof';
import { hash } from '@/lib/crypto';
import prisma from '@/lib/prisma';
import {
  reserveActiveCollectionBudget,
  reserveBackendCollectionRequest,
  withActiveCollectionSource,
} from '@/queries/prisma/collection';
import { createWebsite, deleteWebsite } from '@/queries/prisma/website';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
const address = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname));
assert.equal(address.pathname, '/postgres');

const userId = randomUUID();
const nextOwnerId = randomUUID();
const websiteId = randomUUID();
const recycledWebsiteId = randomUUID();
const secondWebsiteId = randomUUID();
const linkId = randomUUID();
const pixelId = randomUUID();
const body = {
  type: 'event' as const,
  payload: {
    data: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`key${index}`, 'x'])),
  },
};
const cost = getCollectionCost(body);
const firstClientIp = '192.0.2.10';
const secondClientIp = '192.0.2.11';
const backendRequest = {
  keyDigest: 'a'.repeat(64),
  ownerType: 'user' as const,
  ownerId: userId,
  generation: 0,
  requestId: randomUUID(),
};
const nonceKey = (sourceId: string, requestId: string) =>
  `nonce:${createHash('sha256')
    .update(`backend-collection-v1\0${sourceId}\0${requestId}`)
    .digest('hex')
    .slice(0, 58)}`;
const clientSourceKey = (
  sourceType: string,
  sourceId: string,
  clientIp: string,
  admissionClass: CollectionAdmissionClass = 'anonymous',
) =>
  `client:send:${getCollectionClientKeys(sourceType, sourceId, 'user', userId, clientIp, admissionClass).sourceClientHash}`;
const clientAccountKey = (
  clientIp: string,
  admissionClass: CollectionAdmissionClass = 'anonymous',
) =>
  `client:account:${getCollectionClientKeys('website', websiteId, 'user', userId, clientIp, admissionClass).accountClientHash}`;

async function reserve(
  sourceType: 'website' | 'link' | 'pixel',
  sourceId: string,
  clientIp = firstClientIp,
  admissionClass: CollectionAdmissionClass = 'anonymous',
  request: BackendCollectionRequest | undefined = admissionClass === 'backend'
    ? { ...backendRequest, requestId: randomUUID() }
    : undefined,
) {
  return reserveActiveCollectionBudget(
    sourceType,
    sourceId,
    body,
    clientIp,
    admissionClass,
    request,
  );
}

async function sourceRateCount() {
  const rows = await prisma.client.$queryRaw<Array<{ requests: bigint }>>`
    SELECT coalesce(sum(requests), 0)::bigint AS requests
    FROM collection_ingest_budget
    WHERE subject_type = 'source' AND subject_key LIKE 'rate:source:%' AND scope = 'minute'
  `;
  return rows[0].requests;
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
  await prisma.client.website.create({
    data: { id: secondWebsiteId, name: 'Second collection budget website', userId },
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

  await assert.rejects(
    () =>
      prisma.transaction(async transaction => {
        await reserveBackendCollectionRequest(transaction, websiteId, backendRequest);
        throw new Error('SYNTHETIC_WRITE_FAILED');
      }),
    /SYNTHETIC_WRITE_FAILED/,
  );
  await prisma.transaction(transaction =>
    reserveBackendCollectionRequest(transaction, websiteId, backendRequest),
  );
  await assert.rejects(
    () =>
      prisma.transaction(transaction =>
        reserveBackendCollectionRequest(transaction, websiteId, {
          ...backendRequest,
          keyDigest: 'b'.repeat(64),
        }),
      ),
    error => error instanceof CollectionRequestReplayError,
  );
  await prisma.transaction(transaction =>
    reserveBackendCollectionRequest(transaction, secondWebsiteId, backendRequest),
  );
  const nonceRows = await prisma.client.collectionIngestBudget.findMany({
    where: {
      subjectType: 'source',
      subjectKey: {
        in: [
          nonceKey(websiteId, backendRequest.requestId),
          nonceKey(secondWebsiteId, backendRequest.requestId),
        ],
      },
    },
  });
  assert.equal(nonceRows.length, 2);

  assert.deepEqual(await reserve('website', websiteId), {
    sourceType: 'website',
    sourceId: websiteId,
    accountType: 'user',
    accountId: userId,
    collectionGeneration: 0,
  });
  const linkAdmission = await reserve('link', linkId);
  assert.deepEqual(linkAdmission, {
    sourceType: 'link',
    sourceId: linkId,
    accountType: 'user',
    accountId: userId,
    collectionGeneration: null,
  });
  const pixelAdmission = await reserve('pixel', pixelId);
  assert.deepEqual(pixelAdmission, {
    sourceType: 'pixel',
    sourceId: pixelId,
    accountType: 'user',
    accountId: userId,
    collectionGeneration: null,
  });

  const accountWindows = await prisma.client.collectionIngestBudget.findMany({
    where: { subjectType: 'user', subjectKey: userId },
  });
  assert.equal(accountWindows.length, 2);
  assert.ok(accountWindows.every(window => window.requests === 3n));
  assert.ok(accountWindows.every(window => window.rows === BigInt(cost.rows * 3)));

  const firstClientMinute = await prisma.client.collectionIngestBudget.findFirstOrThrow({
    where: {
      subjectType: 'source',
      subjectKey: clientSourceKey('website', websiteId, firstClientIp),
      scope: 'minute',
    },
  });
  await prisma.client.collectionIngestBudget.update({
    where: {
      subjectType_subjectKey_scope_windowStart: {
        subjectType: 'source',
        subjectKey: firstClientMinute.subjectKey,
        scope: 'minute',
        windowStart: firstClientMinute.windowStart,
      },
    },
    data: { rows: BigInt(COLLECTION_CLIENT_BUDGET_LIMITS.send.minute.rows - cost.rows) },
  });
  await reserve('website', websiteId);
  const beforeRejectedClient = await prisma.client.collectionIngestBudget.findFirstOrThrow({
    where: { subjectType: 'user', subjectKey: userId, scope: 'minute' },
  });
  const beforeRejectedClientRate = await sourceRateCount();
  await assert.rejects(
    () => reserve('website', websiteId),
    error => error instanceof CollectionBudgetExceededError && error.retryAfter === 60,
  );
  const afterRejectedClient = await prisma.client.collectionIngestBudget.findFirstOrThrow({
    where: { subjectType: 'user', subjectKey: userId, scope: 'minute' },
  });
  assert.equal(afterRejectedClient.rows, beforeRejectedClient.rows);
  assert.equal(await sourceRateCount(), beforeRejectedClientRate);
  await reserve('website', websiteId, secondClientIp);
  assert.equal(await sourceRateCount(), beforeRejectedClientRate + 2n);

  const anonymousSourceDay = await prisma.client.collectionIngestBudget.findFirstOrThrow({
    where: {
      subjectType: 'source',
      subjectKey: `anonymous:website:${websiteId}`,
      scope: 'day',
    },
  });
  await prisma.client.collectionIngestBudget.update({
    where: {
      subjectType_subjectKey_scope_windowStart: {
        subjectType: 'source',
        subjectKey: anonymousSourceDay.subjectKey,
        scope: 'day',
        windowStart: anonymousSourceDay.windowStart,
      },
    },
    data: {
      rows: BigInt(COLLECTION_ANONYMOUS_BUDGET_LIMITS.source.day.rows - cost.rows),
    },
  });
  await reserve('website', websiteId, secondClientIp);
  const beforeAnonymousRejection = await prisma.client.collectionIngestBudget.findFirstOrThrow({
    where: { subjectType: 'source', subjectKey: `website:${websiteId}`, scope: 'day' },
  });
  await assert.rejects(
    () => reserve('website', websiteId, secondClientIp),
    error => error instanceof CollectionBudgetExceededError && error.retryAfter === 86_400,
  );
  const afterAnonymousRejection = await prisma.client.collectionIngestBudget.findFirstOrThrow({
    where: { subjectType: 'source', subjectKey: `website:${websiteId}`, scope: 'day' },
  });
  assert.equal(afterAnonymousRejection.rows, beforeAnonymousRejection.rows);
  await reserve('website', websiteId, secondClientIp, 'backend');

  const anonymousAccountDay = await prisma.client.collectionIngestBudget.findFirstOrThrow({
    where: { subjectType: 'user', subjectKey: `anonymous:${userId}`, scope: 'day' },
  });
  await prisma.client.collectionIngestBudget.update({
    where: {
      subjectType_subjectKey_scope_windowStart: {
        subjectType: 'user',
        subjectKey: anonymousAccountDay.subjectKey,
        scope: 'day',
        windowStart: anonymousAccountDay.windowStart,
      },
    },
    data: {
      rows: BigInt(COLLECTION_ANONYMOUS_BUDGET_LIMITS.account.day.rows - cost.rows),
    },
  });
  await reserve('link', linkId, secondClientIp);
  await assert.rejects(
    () => reserve('pixel', pixelId, secondClientIp),
    error => error instanceof CollectionBudgetExceededError && error.retryAfter === 86_400,
  );
  await assert.rejects(
    () => reserve('link', linkId, secondClientIp, 'backend'),
    /Backend collection requires a website source/,
  );
  await reserve('website', secondWebsiteId, firstClientIp, 'backend');

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
  await reserve('website', websiteId, secondClientIp, 'backend');
  await assert.rejects(
    () => reserve('website', websiteId, secondClientIp, 'backend'),
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

  const concurrent = await Promise.allSettled([
    reserve('website', secondWebsiteId, firstClientIp, 'backend'),
    reserve('website', secondWebsiteId, secondClientIp, 'backend'),
  ]);
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

  await prisma.client.user.create({
    data: {
      id: nextOwnerId,
      username: `collection-next-owner-${nextOwnerId}`,
      password: 'x'.repeat(60),
      role: 'user',
    },
  });
  for (const source of [
    {
      type: 'link' as const,
      id: linkId,
      admission: linkAdmission,
      setOwner: (ownerId: string) =>
        prisma.client.link.update({ where: { id: linkId }, data: { userId: ownerId } }),
    },
    {
      type: 'pixel' as const,
      id: pixelId,
      admission: pixelAdmission,
      setOwner: (ownerId: string) =>
        prisma.client.pixel.update({ where: { id: pixelId }, data: { userId: ownerId } }),
    },
  ]) {
    await source.setOwner(nextOwnerId);
    await assert.rejects(
      () =>
        withActiveCollectionSource(
          source.type,
          source.id,
          async () => 'wrong-owner-write',
          undefined,
          source.admission,
        ),
      /COLLECTION_SOURCE_CHANGED/,
    );
    await source.setOwner(userId);
    assert.equal(
      await withActiveCollectionSource(
        source.type,
        source.id,
        async () => 'same-owner-write',
        undefined,
        source.admission,
      ),
      'same-owner-write',
    );
  }
  let enterWrite: () => void = () => {};
  let releaseWrite: () => void = () => {};
  const writeEntered = new Promise<void>(resolve => {
    enterWrite = resolve;
  });
  const writeRelease = new Promise<void>(resolve => {
    releaseWrite = resolve;
  });
  const inFlightWrite = withActiveCollectionSource(
    'website',
    websiteId,
    async () => {
      enterWrite();
      await writeRelease;
      return 'accepted-before-transfer';
    },
    backendRequest,
  );
  await writeEntered;

  let enterTransfer: () => void = () => {};
  const transferEntered = new Promise<void>(resolve => {
    enterTransfer = resolve;
  });
  let transferAcquired = false;
  const transfer = prisma.transaction(async transaction => {
    enterTransfer();
    await transaction.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${websiteId}))::text`;
    transferAcquired = true;
    await transaction.website.update({
      where: { id: websiteId },
      data: { userId: nextOwnerId, collectionGeneration: { increment: 1 } },
    });
  });
  await transferEntered;
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(transferAcquired, false);
  } finally {
    releaseWrite();
  }
  assert.equal(await inFlightWrite, 'accepted-before-transfer');
  await transfer;
  assert.equal(transferAcquired, true);
  await assert.rejects(
    () => withActiveCollectionSource('website', websiteId, async () => 'stale', backendRequest),
    /COLLECTION_KEY_OWNER_CHANGED/,
  );
  await prisma.client.website.update({
    where: { id: websiteId },
    data: { userId, collectionGeneration: { increment: 1 } },
  });
  await assert.rejects(
    () => withActiveCollectionSource('website', websiteId, async () => 'revived', backendRequest),
    /COLLECTION_KEY_OWNER_CHANGED/,
  );

  const actorAuth = {
    authType: 'session' as const,
    user: {
      id: userId,
      username: `collection-budget-${userId}`,
      role: 'user' as const,
      isAdmin: false,
    },
    sessionGeneration: 0,
    passwordFingerprint: hash('x'.repeat(60)),
  };
  const recycledData = {
    id: recycledWebsiteId,
    name: 'Disposable recycled website',
    userId,
  };
  const initial = await createWebsite(recycledData, userId, { auth: actorAuth });
  assert.equal(initial.website.collectionGeneration, 0);
  const recycledProof = { ...backendRequest, requestId: randomUUID() };
  await withActiveCollectionSource(
    'website',
    recycledWebsiteId,
    async () => 'authorized',
    recycledProof,
  );
  await deleteWebsite(recycledWebsiteId, userId, actorAuth);
  const tombstone = await prisma.client.websiteCollectionTombstone.findUnique({
    where: { websiteId: recycledWebsiteId },
  });
  assert.equal(tombstone?.nextGeneration, 1);
  const recreated = await createWebsite(recycledData, userId, { auth: actorAuth });
  assert.equal(recreated.website.collectionGeneration, 1);
  await assert.rejects(
    () =>
      withActiveCollectionSource(
        'website',
        recycledWebsiteId,
        async () => 'revived',
        recycledProof,
      ),
    /COLLECTION_KEY_OWNER_CHANGED/,
  );
  await deleteWebsite(recycledWebsiteId, userId, actorAuth);
  const secondTombstone = await prisma.client.websiteCollectionTombstone.findUnique({
    where: { websiteId: recycledWebsiteId },
  });
  assert.equal(secondTombstone?.nextGeneration, 2);

  console.log(
    'Collection budget passed client isolation, source, account, concurrency, owner-transfer, and hard-delete/recreation checks.',
  );
} finally {
  const clientKeys = [firstClientIp, secondClientIp].flatMap(clientIp =>
    (['anonymous', 'backend'] as const).flatMap(admissionClass => [
      clientAccountKey(clientIp, admissionClass),
      clientSourceKey('website', websiteId, clientIp, admissionClass),
      clientSourceKey('website', secondWebsiteId, clientIp, admissionClass),
      clientSourceKey('link', linkId, clientIp, admissionClass),
      clientSourceKey('pixel', pixelId, clientIp, admissionClass),
    ]),
  );
  await prisma.client.collectionIngestBudget.deleteMany({
    where: {
      OR: [
        { subjectType: 'user', subjectKey: userId },
        { subjectType: 'user', subjectKey: `anonymous:${userId}` },
        { subjectType: 'source', subjectKey: `website:${websiteId}` },
        { subjectType: 'source', subjectKey: `website:${secondWebsiteId}` },
        { subjectType: 'source', subjectKey: `anonymous:website:${websiteId}` },
        { subjectType: 'source', subjectKey: `anonymous:website:${secondWebsiteId}` },
        { subjectType: 'source', subjectKey: `link:${linkId}` },
        { subjectType: 'source', subjectKey: `anonymous:link:${linkId}` },
        { subjectType: 'source', subjectKey: `pixel:${pixelId}` },
        { subjectType: 'source', subjectKey: `anonymous:pixel:${pixelId}` },
        { subjectType: 'source', subjectKey: { in: clientKeys } },
        {
          subjectType: 'source',
          subjectKey: {
            in: [
              nonceKey(websiteId, backendRequest.requestId),
              nonceKey(secondWebsiteId, backendRequest.requestId),
            ],
          },
        },
      ],
    },
  });
  await prisma.client.website.deleteMany({ where: { id: websiteId } });
  await prisma.client.website.deleteMany({ where: { id: recycledWebsiteId } });
  await prisma.client.websiteCollectionTombstone.deleteMany({
    where: { websiteId: recycledWebsiteId },
  });
  await prisma.client.website.deleteMany({ where: { id: secondWebsiteId } });
  await prisma.client.link.deleteMany({ where: { id: linkId } });
  await prisma.client.pixel.deleteMany({ where: { id: pixelId } });
  await prisma.client.user.deleteMany({ where: { id: userId } });
  await prisma.client.user.deleteMany({ where: { id: nextOwnerId } });
  await prisma.client.$disconnect();
}
