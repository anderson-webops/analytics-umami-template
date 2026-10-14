import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import {
  getReplaySaved,
  getSavedReplays,
  setReplaySavedByActor,
} from '@/queries/prisma/sessionReplay';
import { getReplayChunks } from '@/queries/sql/replays/getReplayChunks';
import { saveRecording } from '@/queries/sql/replays/saveRecording';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname));

const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const userId = randomUUID();
const websiteId = randomUUID();
const sessionId = randomUUID();
const legacyVisitId = randomUUID();
const mixedVisitId = randomUUID();
const expiredVisitId = randomUUID();
let created = false;

function cleanup(maxBatches = '1') {
  return spawnSync(process.execPath, ['scripts/prune-expired-session-replays.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, REPLAY_PRUNE_MAX_BATCHES: maxBatches },
    encoding: 'utf8',
  });
}

async function record(visitId: string) {
  return client.$transaction(transaction =>
    saveRecording(
      {
        websiteId,
        sessionId,
        visitId,
        chunkIndex: 0,
        events: [{ type: 4, timestamp: 1, data: { width: 100 } }],
        eventCount: 1,
        startedAt: new Date(),
        endedAt: new Date(),
      },
      transaction,
    ),
  );
}

try {
  const columns = await client.$queryRaw<
    Array<{ table_name: string; column_default: string | null }>
  >`
    SELECT table_name, column_default FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name IN ('session_replay', 'session_replay_saved')
      AND column_name = 'retention_expires_at'
    ORDER BY table_name
  `;
  assert.deepEqual(columns, [
    { table_name: 'session_replay', column_default: "(CURRENT_TIMESTAMP + '30 days'::interval)" },
    { table_name: 'session_replay_saved', column_default: null },
  ]);

  await client.$executeRawUnsafe(
    "ALTER TABLE session_replay ALTER COLUMN retention_expires_at SET DEFAULT CURRENT_TIMESTAMP + INTERVAL '365 days'",
  );
  try {
    const guard = spawnSync(process.execPath, ['scripts/check-db.js', '--migrate-only'], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
    });
    assert.notEqual(guard.status, 0);
    assert.match(`${guard.stdout}${guard.stderr}`, /Database schema is incomplete after migration/);
    const rejectedCleanup = cleanup();
    assert.notEqual(rejectedCleanup.status, 0);
    assert.match(rejectedCleanup.stderr, /Replay cleanup failed/);
  } finally {
    await client.$executeRawUnsafe(
      "ALTER TABLE session_replay ALTER COLUMN retention_expires_at SET DEFAULT CURRENT_TIMESTAMP + INTERVAL '30 days'",
    );
  }

  await client.user.create({
    data: {
      id: userId,
      username: `replay-retention-${userId}`,
      password: 'x'.repeat(60),
      role: 'user',
    },
  });
  await client.website.create({
    data: { id: websiteId, name: 'Synthetic replay retention', userId, recorderEnabled: true },
  });
  created = true;
  await client.session.create({ data: { id: sessionId, websiteId } });

  const legacy = await record(legacyVisitId);
  assert.ok(legacy.retentionExpiresAt);
  assert.ok(legacy.retentionExpiresAt.getTime() > Date.now() + 29 * 86_400_000);
  assert.ok(legacy.retentionExpiresAt.getTime() < Date.now() + 31 * 86_400_000);
  await client.sessionReplay.update({
    where: { id: legacy.id },
    data: { retentionExpiresAt: null },
  });
  await setReplaySavedByActor(websiteId, legacyVisitId, true, 'Legacy bookmark', userId);
  assert.equal((await getReplayChunks(websiteId, legacyVisitId)).length, 1);
  assert.equal(await getReplaySaved(websiteId, legacyVisitId), true);

  const mixedLegacy = await record(mixedVisitId);
  await client.sessionReplay.update({
    where: { id: mixedLegacy.id },
    data: { retentionExpiresAt: null },
  });
  await setReplaySavedByActor(websiteId, mixedVisitId, true, 'Mixed bookmark', userId);
  const mixedNew = await record(mixedVisitId);
  await setReplaySavedByActor(websiteId, mixedVisitId, true, 'Updated mixed bookmark', userId);
  const mixedSaved = await client.sessionReplaySaved.findUniqueOrThrow({
    where: { websiteId_visitId: { websiteId, visitId: mixedVisitId } },
  });
  assert.equal(mixedSaved.retentionExpiresAt, null);
  await client.$executeRaw`
    UPDATE session_replay SET retention_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
    WHERE replay_id = ${mixedNew.id}::uuid
  `;
  assert.equal(await getReplaySaved(websiteId, mixedVisitId), true);
  assert.equal((await getReplayChunks(websiteId, mixedVisitId)).length, 1);

  const expired = await record(expiredVisitId);
  await setReplaySavedByActor(websiteId, expiredVisitId, true, 'Expiring bookmark', userId);
  const saved = await client.sessionReplaySaved.findUniqueOrThrow({
    where: { websiteId_visitId: { websiteId, visitId: expiredVisitId } },
  });
  assert.equal(saved.retentionExpiresAt?.getTime(), expired.retentionExpiresAt?.getTime());
  assert.equal((await getSavedReplays(websiteId, {})).count, 3);
  await client.$executeRaw`
    UPDATE session_replay SET retention_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
    WHERE replay_id = ${expired.id}::uuid
  `;
  await client.$executeRaw`
    UPDATE session_replay_saved SET retention_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
    WHERE website_id = ${websiteId}::uuid AND visit_id = ${expiredVisitId}::uuid
  `;
  assert.deepEqual(await getReplayChunks(websiteId, expiredVisitId), []);
  assert.equal(await getReplaySaved(websiteId, expiredVisitId), false);
  assert.equal((await getSavedReplays(websiteId, {})).count, 2);
  assert.equal(await client.sessionReplay.count({ where: { id: expired.id } }), 1);

  const first = cleanup();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Expired replay payloads removed: 2; bookmarks removed: 1/);
  assert.equal(await client.sessionReplay.count({ where: { id: expired.id } }), 0);
  assert.equal(await client.sessionReplay.count({ where: { id: legacy.id } }), 1);
  assert.equal(await client.sessionReplay.count({ where: { id: mixedLegacy.id } }), 1);
  assert.equal(
    await client.sessionReplaySaved.count({ where: { websiteId, visitId: legacyVisitId } }),
    1,
  );

  const rows = await client.sessionReplay.createMany({
    data: Array.from({ length: 401 }, (_, chunkIndex) => ({
      id: randomUUID(),
      websiteId,
      sessionId,
      visitId: expiredVisitId,
      chunkIndex,
      events: new Uint8Array([1]),
      eventCount: 1,
      startedAt: new Date(),
      endedAt: new Date(),
    })),
  });
  assert.equal(rows.count, 401);
  await client.$executeRaw`
    UPDATE session_replay SET retention_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
    WHERE website_id = ${websiteId}::uuid AND visit_id = ${expiredVisitId}::uuid
  `;
  const [{ eligible }] = await client.$queryRaw<Array<{ eligible: bigint }>>`
    SELECT count(*) AS eligible FROM session_replay
    WHERE website_id = ${websiteId}::uuid
      AND retention_expires_at <= CURRENT_TIMESTAMP
  `;
  assert.equal(eligible, 401n);
  const bounded = cleanup();
  assert.equal(bounded.status, 2, `${bounded.stdout}\n${bounded.stderr}`);
  assert.match(bounded.stdout, /Expired replay payloads removed: 400/);
  assert.equal(
    await client.sessionReplay.count({ where: { websiteId, visitId: expiredVisitId } }),
    1,
  );
  const remainder = cleanup();
  assert.equal(remainder.status, 0, remainder.stderr);
  assert.match(remainder.stdout, /Expired replay payloads removed: 1/);
} finally {
  if (created) {
    await client.sessionReplaySaved.deleteMany({ where: { websiteId } });
    await client.sessionReplay.deleteMany({ where: { websiteId } });
    await client.session.deleteMany({ where: { websiteId } });
    await client.website.delete({ where: { id: websiteId } });
    await client.user.delete({ where: { id: userId } });
  }
  await client.$disconnect();
}
