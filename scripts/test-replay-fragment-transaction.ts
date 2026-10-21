import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import {
  getReplayChargedBytes,
  MAX_REPLAY_BYTES,
  markAcknowledgedReplayChunk,
  markUnstoredReplayChunkRetryable,
  ReplayBudgetExceededError,
  ReplayWritePendingError,
  reserveReplayBudget,
} from '@/lib/replay-budget';
import { countReplayStructureUnits } from '@/lib/replay-structure';
import { saveReassembledRecordingFragments } from '@/queries/sql/replays/saveRecording';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
assert.equal(process.env.CLICKHOUSE_URL ?? '', '');
const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname));
assert.equal(databaseUrl.pathname, '/postgres');

const client = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl.toString(), options: '-c TimeZone=UTC' }),
});
const userId = randomUUID();
const websiteId = randomUUID();
const sessionId = randomUUID();
const visitId = randomUUID();
const fragmentId = `synthetic-${randomUUID()}`;
const recordedAt = Date.now();
const event = {
  type: 4,
  timestamp: recordedAt,
  data: { href: 'https://example.test/private?token=synthetic-secret' },
};
const serialized = JSON.stringify(event);
const midpoint = Math.floor(serialized.length / 2);
const values = [serialized.slice(0, midpoint), serialized.slice(midpoint)];
const parts = values.map((_, index) => ({
  id: fragmentId,
  index,
  total: values.length,
  chunkIndex: 101 + index,
  timestamp: recordedAt,
}));
const charges = values.map((value, index) => {
  const fragment = {
    type: 'umami:rrweb-event-fragment',
    timestamp: recordedAt,
    data: { id: fragmentId, index, total: values.length, value },
  };
  const bytes = Buffer.byteLength(JSON.stringify([fragment]), 'utf8');
  const structureUnits = countReplayStructureUnits([fragment]);
  assert.ok(structureUnits !== null);
  return {
    bytes,
    structureUnits,
    chargedBytes: getReplayChargedBytes(bytes, structureUnits),
  };
});
const recording = {
  websiteId,
  sessionId,
  visitId,
  event,
  parts,
  startedAt: new Date(recordedAt),
  endedAt: new Date(recordedAt),
};

async function reserveParts() {
  for (const [index, part] of parts.entries()) {
    const charge = charges[index];
    assert.equal(
      await client.$transaction(transaction =>
        reserveReplayBudget(transaction, {
          websiteId,
          accountType: 'user',
          accountId: userId,
          visitId,
          chunkIndex: part.chunkIndex,
          idempotent: true,
          pendingExternalWrite: true,
          bytes: charge.bytes,
          events: 1,
          structureUnits: charge.structureUnits,
        }),
      ),
      true,
    );
  }
}

async function assertPendingWithoutStoredReplay() {
  const budget = await client.replayIngestBudget.findUniqueOrThrow({
    where: { websiteId_scope_scopeKey: { websiteId, scope: 'visit', scopeKey: visitId } },
  });
  assert.deepEqual(
    budget.chunkIndices,
    parts.map(part => -part.chunkIndex),
  );
  assert.equal(await client.sessionReplay.count({ where: { websiteId, visitId } }), 0);
  await assert.rejects(
    () =>
      client.$transaction(transaction =>
        reserveReplayBudget(transaction, {
          websiteId,
          accountType: 'user',
          accountId: userId,
          visitId,
          chunkIndex: parts[0].chunkIndex,
          idempotent: true,
          pendingExternalWrite: true,
          bytes: charges[0].bytes,
          events: 1,
          structureUnits: charges[0].structureUnits,
        }),
      ),
    error => error instanceof ReplayWritePendingError,
  );
}

try {
  await client.user.create({
    data: {
      id: userId,
      username: `replay-transaction-${userId}`,
      password: 'x'.repeat(60),
      role: 'user',
    },
  });
  await client.website.create({
    data: {
      id: websiteId,
      name: 'Synthetic replay transaction',
      userId,
      recorderEnabled: true,
      replayConfig: { replayEnabled: true, maskLevel: 'strict' },
    },
  });

  await assert.rejects(
    () =>
      client.$transaction(async transaction => {
        await reserveReplayBudget(transaction, {
          websiteId,
          accountType: 'user',
          accountId: userId,
          visitId,
          chunkIndex: parts[0].chunkIndex,
          idempotent: true,
          pendingExternalWrite: true,
          bytes: charges[0].bytes,
          events: 1,
          structureUnits: charges[0].structureUnits,
        });
        await reserveReplayBudget(transaction, {
          websiteId,
          accountType: 'user',
          accountId: userId,
          visitId,
          chunkIndex: parts[1].chunkIndex,
          idempotent: true,
          pendingExternalWrite: true,
          bytes: MAX_REPLAY_BYTES + 1,
          events: 1,
          structureUnits: charges[1].structureUnits,
        });
      }),
    error => error instanceof ReplayBudgetExceededError,
  );
  assert.equal(
    await client.replayIngestBudget.count({
      where: { websiteId, scope: 'visit', scopeKey: visitId },
    }),
    0,
  );

  await reserveParts();
  await assertPendingWithoutStoredReplay();

  await assert.rejects(
    () =>
      client.$transaction(async transaction => {
        await saveReassembledRecordingFragments(recording, transaction);
        throw new Error('SYNTHETIC_PRE_ACK_ROLLBACK');
      }),
    /SYNTHETIC_PRE_ACK_ROLLBACK/,
  );
  await assertPendingWithoutStoredReplay();

  let acknowledgedFirstPart = false;
  await assert.rejects(
    () =>
      client.$transaction(async transaction => {
        await saveReassembledRecordingFragments(recording, transaction);
        await markAcknowledgedReplayChunk(transaction, websiteId, visitId, parts[0].chunkIndex);
        acknowledgedFirstPart = true;
        await transaction.$queryRaw`SELECT 1 / 0`;
      }),
    /division by zero/i,
  );
  assert.ok(acknowledgedFirstPart);
  await assertPendingWithoutStoredReplay();

  await client.$transaction(async transaction => {
    for (const [index, part] of parts.entries()) {
      await markUnstoredReplayChunkRetryable(transaction, websiteId, visitId, part.chunkIndex, {
        bytes: charges[index].chargedBytes,
        events: 1,
      });
    }
  });
  const refunded = await client.replayIngestBudget.findUniqueOrThrow({
    where: { websiteId_scope_scopeKey: { websiteId, scope: 'visit', scopeKey: visitId } },
  });
  assert.deepEqual(refunded.chunkIndices, []);
  assert.equal(refunded.bytes, 0n);

  await reserveParts();
  await client.$transaction(async transaction => {
    await saveReassembledRecordingFragments(recording, transaction);
    for (const part of parts) {
      await markAcknowledgedReplayChunk(transaction, websiteId, visitId, part.chunkIndex);
    }
  });

  const stored = await client.sessionReplay.findMany({
    where: { websiteId, visitId },
    orderBy: { chunkIndex: 'asc' },
  });
  assert.equal(stored.length, parts.length);
  const reconstructed = stored
    .map(row => JSON.parse(gunzipSync(row.events).toString('utf8'))[0].data.value)
    .join('');
  assert.equal(JSON.parse(reconstructed).data.href, '');
  assert.ok(!reconstructed.includes('synthetic-secret'));
  const accepted = await client.replayIngestBudget.findUniqueOrThrow({
    where: { websiteId_scope_scopeKey: { websiteId, scope: 'visit', scopeKey: visitId } },
  });
  assert.deepEqual(
    accepted.chunkIndices,
    parts.map(part => part.chunkIndex),
  );
  assert.equal(
    accepted.bytes,
    charges.reduce((total, charge) => total + BigInt(charge.chargedBytes), 0n),
  );

  console.log(
    'Replay fragments retain pending markers through PostgreSQL rollback and retry only after verified refund.',
  );
} finally {
  await client.sessionReplay.deleteMany({ where: { websiteId } });
  await client.collectionIngestBudget.deleteMany({
    where: {
      OR: [
        { subjectType: 'source', subjectKey: `website:${websiteId}` },
        { subjectType: 'user', subjectKey: userId },
        { subjectType: 'user', subjectKey: `recorder-visits:${userId}` },
      ],
    },
  });
  await client.replayIngestBudget.deleteMany({ where: { websiteId } });
  await client.website.deleteMany({ where: { id: websiteId } });
  await client.user.deleteMany({ where: { id: userId } });
  await client.$disconnect();
}
