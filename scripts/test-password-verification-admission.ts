import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { reservePasswordVerificationAttempt } from '@/lib/password-verification-rate-limit';
import prisma from '@/lib/prisma';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
const address = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname));
assert.equal(address.pathname, '/postgres');

const userId = randomUUID();
const budgetKey = `password-verification:${createHash('sha512').update(userId).digest('hex').slice(0, 32)}`;
let created = false;

try {
  await prisma.client.user.create({
    data: {
      id: userId,
      username: `password-regression-${userId}`,
      password: 'x'.repeat(60),
      role: 'user',
    },
  });
  created = true;

  const attempts = await Promise.all(
    Array.from({ length: 24 }, () => reservePasswordVerificationAttempt(userId)),
  );
  assert.equal(attempts.filter(attempt => attempt.allowed).length, 5);
  assert.equal(attempts.filter(attempt => !attempt.allowed).length, 19);
  assert.ok(attempts.every(attempt => attempt.allowed || attempt.retryAfter > 0));

  const firstWindow = await prisma.client.appSetting.findUniqueOrThrow({
    where: { key: budgetKey },
  });
  assert.equal(JSON.parse(firstWindow.value).attempts, 5);
  const firstExpiry = await prisma.client.$queryRaw<Array<{ epoch: number }>>`
    SELECT EXTRACT(EPOCH FROM ("value"::jsonb->>'expiresAt')::timestamptz)::float8 AS "epoch"
    FROM "app_setting" WHERE "key" = ${budgetKey}
  `;
  assert.ok(
    firstExpiry[0].epoch * 1000 > Date.now() + 14 * 60 * 1000,
    `Unexpected password-verification expiry epoch ${firstExpiry[0].epoch}`,
  );
  assert.equal((await reservePasswordVerificationAttempt(userId)).allowed, false);

  await prisma.client.$executeRaw`
    UPDATE "app_setting"
    SET "value" = jsonb_set("value"::jsonb, '{expiresAt}',
      to_jsonb(clock_timestamp() - interval '1 minute'))::text
    WHERE "key" = ${budgetKey}
  `;

  assert.equal((await reservePasswordVerificationAttempt(userId)).allowed, true);
  const secondWindow = await prisma.client.appSetting.findUniqueOrThrow({
    where: { key: budgetKey },
  });
  assert.equal(JSON.parse(secondWindow.value).attempts, 1);
  const secondExpiry = await prisma.client.$queryRaw<Array<{ epoch: number }>>`
    SELECT EXTRACT(EPOCH FROM ("value"::jsonb->>'expiresAt')::timestamptz)::float8 AS "epoch"
    FROM "app_setting" WHERE "key" = ${budgetKey}
  `;
  assert.ok(
    secondExpiry[0].epoch * 1000 > Date.now() + 14 * 60 * 1000,
    `Unexpected refreshed password-verification expiry epoch ${secondExpiry[0].epoch}`,
  );

  await prisma.client.appSetting.update({ where: { key: budgetKey }, data: { value: '{}' } });
  assert.equal((await reservePasswordVerificationAttempt(userId)).allowed, false);
  await prisma.client.appSetting.update({
    where: { key: budgetKey },
    data: { value: 'not-json' },
  });
  await assert.rejects(() => reservePasswordVerificationAttempt(userId));

  console.log('Atomic password-verification admission, expiry, and malformed-state denial passed.');
} finally {
  await prisma.client.appSetting.deleteMany({ where: { key: budgetKey } });
  if (created) {
    await prisma.client.user.delete({ where: { id: userId } });
  }
  await prisma.client.$disconnect();
}
