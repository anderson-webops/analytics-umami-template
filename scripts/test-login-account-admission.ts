import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  getLoginAccountAttemptKey,
  releaseLoginAccountAttempt,
  reserveLoginAccountAttempt,
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
const unknownKey = getLoginAccountAttemptKey();
const originalAccountLimit = process.env.LOGIN_RATE_LIMIT_ACCOUNT_FAILURES;

try {
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

  const unknownAttempts = await Promise.all(
    Array.from({ length: 12 }, () => reserveLoginAccountAttempt()),
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
    where: { key: { in: [accountKey, successfulKey, unknownKey] } },
  });
  await prisma.client.$disconnect();
}
