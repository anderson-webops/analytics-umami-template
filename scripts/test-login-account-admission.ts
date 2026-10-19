import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hash } from '@/lib/crypto';
import {
  getLoginAccountAttemptKey,
  releaseLoginAccountAttempt,
  releaseLoginAccountAttemptOnce,
  releaseLoginOverflowAttempt,
  releaseLoginPasswordWork,
  reserveLoginAccountAttempt,
  reserveLoginOverflowAttempt,
  reserveLoginPasswordWork,
} from '@/lib/login-rate-limit';
import prisma from '@/lib/prisma';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
const address = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname));
assert.equal(address.pathname, '/postgres');

const userId = randomUUID();
const accountKey = getLoginAccountAttemptKey(userId);
const successfulUserId = randomUUID();
const successfulKey = getLoginAccountAttemptKey(successfulUserId);
const onceUserId = randomUUID();
const onceKey = getLoginAccountAttemptKey(onceUserId);
const unknownUsername = randomUUID();
const unknownKey = getLoginAccountAttemptKey(unknownUsername);
const legacyUserId = randomUUID();
const legacyKey = `login-admission:${hash(legacyUserId).slice(0, 32)}`;
const originalAccountLimit = process.env.LOGIN_RATE_LIMIT_ACCOUNT_FAILURES;

try {
  const workLeases = await Promise.all(
    Array.from({ length: 24 }, () => reserveLoginPasswordWork()),
  );
  const admittedWork = workLeases.filter(lease => lease !== null);
  assert.equal(admittedWork.length, 4);
  assert.equal(await reserveLoginPasswordWork(), null);
  const retiredLease = admittedWork[0];
  await releaseLoginPasswordWork(retiredLease);
  const replacementLease = await reserveLoginPasswordWork();
  assert.ok(replacementLease);
  await releaseLoginPasswordWork(retiredLease);
  const activeSlot = await prisma.client.appSetting.findUniqueOrThrow({
    where: { key: replacementLease.key },
  });
  assert.equal(JSON.parse(activeSlot.value).leaseId, replacementLease.leaseId);
  await prisma.client.$executeRaw`
    UPDATE "app_setting"
    SET "value" = jsonb_set("value"::jsonb, '{expiresAt}',
      to_jsonb(clock_timestamp() - interval '1 second'))::text
    WHERE "key" = ${replacementLease.key}
  `;
  const recoveredWork = await reserveLoginPasswordWork();
  assert.ok(recoveredWork);
  assert.equal(recoveredWork.key, replacementLease.key);
  await releaseLoginPasswordWork(replacementLease);
  const recoveredSlot = await prisma.client.appSetting.findUniqueOrThrow({
    where: { key: recoveredWork.key },
  });
  assert.equal(JSON.parse(recoveredSlot.value).leaseId, recoveredWork.leaseId);
  await Promise.all([recoveredWork, ...admittedWork.slice(1)].map(releaseLoginPasswordWork));

  const attempts = await Promise.all(
    Array.from({ length: 24 }, () => reserveLoginAccountAttempt(userId)),
  );
  assert.equal(attempts.filter(attempt => !attempt.blocked).length, 10);
  assert.equal(attempts.filter(attempt => attempt.blocked).length, 14);
  assert.ok(attempts.every(attempt => !attempt.blocked || attempt.retryAfter > 0));

  const firstWindow = await prisma.client.appSetting.findUniqueOrThrow({
    where: { key: accountKey },
  });
  assert.equal(JSON.parse(firstWindow.value).attempts, 10);
  assert.equal((await reserveLoginAccountAttempt(userId)).blocked, true);
  const unchangedWindow = await prisma.client.appSetting.findUniqueOrThrow({
    where: { key: accountKey },
  });
  assert.equal(unchangedWindow.value, firstWindow.value);

  const overflowAttempts = await Promise.all(
    Array.from({ length: 24 }, () => reserveLoginOverflowAttempt(userId)),
  );
  const admittedOverflow = overflowAttempts.filter(attempt => !attempt.blocked);
  assert.equal(admittedOverflow.length, 1);
  assert.equal(overflowAttempts.filter(attempt => attempt.blocked).length, 23);
  const firstOverflow = admittedOverflow[0];
  if (!('leaseId' in firstOverflow)) {
    throw new Error('Expected one challenged overflow lease');
  }
  await releaseLoginOverflowAttempt(userId, 'wrong-window', firstOverflow.leaseId);
  const leasedWindow = await prisma.client.appSetting.findUniqueOrThrow({
    where: { key: accountKey },
  });
  assert.equal(JSON.parse(leasedWindow.value).overflowLeaseId, firstOverflow.leaseId);
  await releaseLoginOverflowAttempt(userId, firstOverflow.windowExpiresAt, firstOverflow.leaseId);
  assert.equal((await reserveLoginOverflowAttempt(userId)).blocked, true);

  await prisma.client.$executeRaw`
    UPDATE "app_setting"
    SET "value" = ("value"::jsonb || jsonb_build_object(
      'overflowNextAt', clock_timestamp() - interval '1 second'
    ))::text
    WHERE "key" = ${accountKey}
  `;
  const secondOverflow = await reserveLoginOverflowAttempt(userId);
  assert.equal(secondOverflow.blocked, false);
  if (!('leaseId' in secondOverflow)) {
    throw new Error('Expected a new challenged overflow lease');
  }
  await releaseLoginOverflowAttempt(userId, firstOverflow.windowExpiresAt, firstOverflow.leaseId);
  const retainedLease = await prisma.client.appSetting.findUniqueOrThrow({
    where: { key: accountKey },
  });
  assert.equal(JSON.parse(retainedLease.value).overflowLeaseId, secondOverflow.leaseId);
  await releaseLoginOverflowAttempt(userId, secondOverflow.windowExpiresAt, secondOverflow.leaseId);

  await prisma.client.$executeRaw`
    UPDATE "app_setting"
    SET "value" = ("value"::jsonb || jsonb_build_object(
      'overflowNextAt', clock_timestamp() - interval '1 second'
    ))::text
    WHERE "key" = ${accountKey}
  `;
  const abandonedOverflow = await reserveLoginOverflowAttempt(userId);
  assert.equal(abandonedOverflow.blocked, false);
  if (!('leaseId' in abandonedOverflow)) {
    throw new Error('Expected an abandoned challenged overflow lease');
  }
  await prisma.client.$executeRaw`
    UPDATE "app_setting"
    SET "value" = ("value"::jsonb || jsonb_build_object(
      'overflowLeaseUntil', clock_timestamp() - interval '1 second',
      'overflowNextAt', clock_timestamp() - interval '1 second'
    ))::text
    WHERE "key" = ${accountKey}
  `;
  const recoveredOverflow = await reserveLoginOverflowAttempt(userId);
  assert.equal(recoveredOverflow.blocked, false);
  if (!('leaseId' in recoveredOverflow)) {
    throw new Error('Expected recovery from an abandoned overflow lease');
  }
  await releaseLoginOverflowAttempt(
    userId,
    abandonedOverflow.windowExpiresAt,
    abandonedOverflow.leaseId,
  );
  const recoveredLease = await prisma.client.appSetting.findUniqueOrThrow({
    where: { key: accountKey },
  });
  assert.equal(JSON.parse(recoveredLease.value).overflowLeaseId, recoveredOverflow.leaseId);
  await releaseLoginOverflowAttempt(
    userId,
    recoveredOverflow.windowExpiresAt,
    recoveredOverflow.leaseId,
  );

  const unknownAttempts = await Promise.all(
    Array.from({ length: 12 }, () => reserveLoginAccountAttempt(unknownUsername)),
  );
  assert.equal(unknownAttempts.filter(attempt => !attempt.blocked).length, 10);
  assert.equal(unknownAttempts.filter(attempt => attempt.blocked).length, 2);

  let firstSuccessfulWindow = '';

  for (let index = 0; index < 12; index += 1) {
    const admission = await reserveLoginAccountAttempt(successfulUserId);
    assert.equal(admission.blocked, false);

    if (!admission.blocked) {
      firstSuccessfulWindow ||= admission.windowExpiresAt;
      await releaseLoginAccountAttempt(successfulUserId, admission.windowExpiresAt);
      const releasedWindow = await prisma.client.appSetting.findUniqueOrThrow({
        where: { key: successfulKey },
      });
      assert.equal(JSON.parse(releasedWindow.value).attempts, 0);
    }
  }

  const successfulWindow = await prisma.client.appSetting.findUniqueOrThrow({
    where: { key: successfulKey },
  });
  assert.equal(JSON.parse(successfulWindow.value).attempts, 0);

  const firstOnce = await reserveLoginAccountAttempt(onceUserId);
  const secondOnce = await reserveLoginAccountAttempt(onceUserId);
  assert.equal(firstOnce.blocked, false);
  assert.equal(secondOnce.blocked, false);
  if (!('windowExpiresAt' in firstOnce) || !('windowExpiresAt' in secondOnce)) {
    throw new Error('Expected two reserved account attempts');
  }
  const attemptId = randomUUID();
  const duplicateReleases = await Promise.all(
    Array.from({ length: 2 }, () =>
      releaseLoginAccountAttemptOnce(onceUserId, firstOnce.windowExpiresAt, attemptId),
    ),
  );
  assert.deepEqual(duplicateReleases.sort(), [false, true]);
  const onceWindow = await prisma.client.appSetting.findUniqueOrThrow({ where: { key: onceKey } });
  assert.equal(JSON.parse(onceWindow.value).attempts, 1);
  const thirdOnce = await reserveLoginAccountAttempt(onceUserId);
  assert.equal(thirdOnce.blocked, false);
  assert.equal(
    await releaseLoginAccountAttemptOnce(onceUserId, firstOnce.windowExpiresAt, attemptId),
    false,
  );
  const replayWindow = await prisma.client.appSetting.findUniqueOrThrow({
    where: { key: onceKey },
  });
  assert.equal(JSON.parse(replayWindow.value).attempts, 2);
  assert.equal(
    await releaseLoginAccountAttemptOnce(onceUserId, firstOnce.windowExpiresAt, randomUUID()),
    true,
  );
  const fullyReleased = await prisma.client.appSetting.findUniqueOrThrow({
    where: { key: onceKey },
  });
  assert.equal(JSON.parse(fullyReleased.value).attempts, 1);
  assert.equal(
    await releaseLoginAccountAttemptOnce(onceUserId, firstOnce.windowExpiresAt, randomUUID()),
    true,
  );
  const allReleased = await prisma.client.appSetting.findUniqueOrThrow({ where: { key: onceKey } });
  assert.equal(JSON.parse(allReleased.value).attempts, 0);

  const legacyExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await prisma.client.appSetting.create({
    data: { key: legacyKey, value: JSON.stringify({ attempts: 1, expiresAt: legacyExpiry }) },
  });
  assert.equal(
    await releaseLoginAccountAttemptOnce('alice', legacyExpiry, randomUUID(), legacyUserId),
    true,
  );
  const legacyWindow = await prisma.client.appSetting.findUniqueOrThrow({
    where: { key: legacyKey },
  });
  assert.equal(JSON.parse(legacyWindow.value).attempts, 0);

  await prisma.client.$executeRaw`
    UPDATE "app_setting"
    SET "value" = jsonb_set("value"::jsonb, '{expiresAt}',
      to_jsonb(clock_timestamp() - interval '1 minute'))::text
    WHERE "key" = ${successfulKey}
  `;

  const renewedSuccess = await reserveLoginAccountAttempt(successfulUserId);
  assert.equal(renewedSuccess.blocked, false);
  await releaseLoginAccountAttempt(successfulUserId, firstSuccessfulWindow);
  const retainedNewWindow = await prisma.client.appSetting.findUniqueOrThrow({
    where: { key: successfulKey },
  });
  assert.equal(JSON.parse(retainedNewWindow.value).attempts, 1);

  process.env.LOGIN_RATE_LIMIT_ACCOUNT_FAILURES = '3';
  assert.equal((await reserveLoginAccountAttempt(userId)).blocked, true);

  await prisma.client.$executeRaw`
    UPDATE "app_setting"
    SET "value" = jsonb_set("value"::jsonb, '{expiresAt}',
      to_jsonb(clock_timestamp() - interval '1 minute'))::text
    WHERE "key" = ${accountKey}
  `;

  const renewedAttempts = await Promise.all(
    Array.from({ length: 4 }, () => reserveLoginAccountAttempt(userId)),
  );
  assert.equal(renewedAttempts.filter(attempt => !attempt.blocked).length, 3);
  assert.equal(renewedAttempts.filter(attempt => attempt.blocked).length, 1);
  const renewedWindow = await prisma.client.appSetting.findUniqueOrThrow({
    where: { key: accountKey },
  });
  assert.equal(JSON.parse(renewedWindow.value).attempts, 3);

  await prisma.client.appSetting.update({ where: { key: accountKey }, data: { value: '{}' } });
  assert.equal((await reserveLoginAccountAttempt(userId)).blocked, true);
  await prisma.client.appSetting.update({
    where: { key: accountKey },
    data: { value: 'not-json' },
  });
  await assert.rejects(() => reserveLoginAccountAttempt(userId));

  console.log('Shared login admission, concurrency, expiry, and malformed-state denial passed.');
} finally {
  if (originalAccountLimit === undefined) {
    delete process.env.LOGIN_RATE_LIMIT_ACCOUNT_FAILURES;
  } else {
    process.env.LOGIN_RATE_LIMIT_ACCOUNT_FAILURES = originalAccountLimit;
  }
  await prisma.client.appSetting.deleteMany({
    where: { key: { in: [accountKey, successfulKey, onceKey, unknownKey, legacyKey] } },
  });
  await prisma.client.appSetting.deleteMany({
    where: { key: { startsWith: 'login-password-work:' } },
  });
  await prisma.client.$disconnect();
}
