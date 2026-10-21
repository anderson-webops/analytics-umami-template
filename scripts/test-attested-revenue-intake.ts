import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  type BackendCollectionRequest,
  CollectionRequestReplayError,
} from '@/lib/collection-proof';
import prisma from '@/lib/prisma';
import {
  AttestedRevenueConflictError,
  type AttestedRevenueMovementInput,
  recordAttestedRevenueMovement,
} from '@/queries/prisma/attestedRevenue';
import { withActiveCollectionSource } from '@/queries/prisma/collection';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
assert.equal(process.env.CLOUD_MODE ?? '', '');
assert.equal(process.env.REDIS_URL ?? '', '');
const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname));
assert.equal(databaseUrl.pathname, '/postgres');

const ownerId = randomUUID();
const websiteId = randomUUID();
const otherWebsiteId = randomUUID();
const stableMovementId = randomUUID();
const movement: AttestedRevenueMovementInput = {
  source: 'synthetic-orders',
  sourceMovementId: stableMovementId,
  orderId: randomUUID(),
  customerId: randomUUID(),
  kind: 'capture',
  amount: '12.3400',
  currency: 'USD',
  occurredAt: new Date('2026-10-19T00:00:00Z'),
};
const backendRequest = (requestId = randomUUID(), generation = 0): BackendCollectionRequest => ({
  keyDigest: 'a'.repeat(64),
  ownerType: 'user',
  ownerId,
  generation,
  requestId,
});
const submit = (
  targetWebsiteId: string,
  requestProof: BackendCollectionRequest,
  candidate = movement,
) =>
  withActiveCollectionSource(
    'website',
    targetWebsiteId,
    transaction =>
      recordAttestedRevenueMovement(transaction, targetWebsiteId, requestProof, candidate),
    requestProof,
  );

try {
  await prisma.client.user.create({
    data: {
      id: ownerId,
      username: `attested-revenue-${ownerId}`,
      password: 'x'.repeat(60),
      role: 'admin',
    },
  });
  for (const siteId of [websiteId, otherWebsiteId]) {
    await prisma.client.website.create({
      data: {
        id: siteId,
        name: 'Synthetic revenue intake',
        domain: `${siteId}.invalid`,
        userId: ownerId,
      },
    });
  }

  const firstNonce = randomUUID();
  const first = await submit(websiteId, backendRequest(firstNonce));
  assert.equal(first.duplicate, false);
  assert.equal(await prisma.client.attestedRevenueMovement.count({ where: { websiteId } }), 1);

  const repeated = await submit(websiteId, backendRequest(), movement);
  assert.deepEqual(repeated, { movementId: first.movementId, duplicate: true });
  assert.equal(await prisma.client.attestedRevenueMovement.count({ where: { websiteId } }), 1);

  for (const changed of [
    { ...movement, amount: '99.0000' },
    { ...movement, orderId: randomUUID() },
    { ...movement, source: 'alternate-source' },
  ]) {
    await assert.rejects(
      () => submit(websiteId, backendRequest(), changed),
      AttestedRevenueConflictError,
    );
  }

  await assert.rejects(
    () =>
      submit(websiteId, backendRequest(), {
        ...movement,
        sourceMovementId: randomUUID(),
        kind: 'refund',
      } as unknown as AttestedRevenueMovementInput),
    AttestedRevenueConflictError,
  );
  assert.equal(await prisma.client.attestedRevenueMovement.count({ where: { websiteId } }), 1);

  const newMovement = { ...movement, sourceMovementId: randomUUID() };
  await assert.rejects(
    () => submit(websiteId, backendRequest(firstNonce), newMovement),
    CollectionRequestReplayError,
  );
  assert.equal(await prisma.client.attestedRevenueMovement.count({ where: { websiteId } }), 1);
  assert.equal((await submit(websiteId, backendRequest(), newMovement)).duplicate, false);

  await assert.rejects(
    () =>
      submit(websiteId, backendRequest(randomUUID(), 1), {
        ...movement,
        sourceMovementId: randomUUID(),
      }),
    /COLLECTION_KEY_OWNER_CHANGED/,
  );
  assert.equal((await submit(otherWebsiteId, backendRequest(), movement)).duplicate, false);
  assert.equal(
    await prisma.client.attestedRevenueMovement.count({ where: { websiteId: otherWebsiteId } }),
    1,
  );

  const concurrentMovement = { ...movement, sourceMovementId: randomUUID() };
  const concurrent = await Promise.all(
    Array.from({ length: 6 }, () => submit(websiteId, backendRequest(), concurrentMovement)),
  );
  assert.equal(concurrent.filter(result => !result.duplicate).length, 1);
  assert.equal(new Set(concurrent.map(result => result.movementId)).size, 1);
  assert.equal(await prisma.client.attestedRevenueMovement.count({ where: { websiteId } }), 3);

  const initialGenerationMovement = { ...movement, sourceMovementId: randomUUID() };
  await submit(websiteId, backendRequest(), initialGenerationMovement);
  await prisma.client.website.update({
    where: { id: websiteId },
    data: { collectionGeneration: 1 },
  });
  await assert.rejects(
    () => submit(websiteId, backendRequest(), initialGenerationMovement),
    /COLLECTION_KEY_OWNER_CHANGED/,
  );
  await assert.rejects(
    () => submit(websiteId, backendRequest(randomUUID(), 1), initialGenerationMovement),
    AttestedRevenueConflictError,
  );
} finally {
  await prisma.client.website.deleteMany({ where: { id: { in: [websiteId, otherWebsiteId] } } });
  await prisma.client.user.deleteMany({ where: { id: ownerId } });
  await prisma.client.$disconnect();
}
