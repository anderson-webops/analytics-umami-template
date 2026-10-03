import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import prisma from '@/lib/prisma';
import { reserveTwoFactorAttempt, resetRateLimit } from '@/lib/two-factor/rate-limit';
import { consumeOtp } from '@/lib/two-factor/replay-prevention';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
const address = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname));
assert.equal(address.pathname, '/postgres');

const userId = randomUUID();
let created = false;

try {
  await prisma.client.user.create({
    data: {
      id: userId,
      username: `mfa-regression-${userId}`,
      password: 'x'.repeat(60),
      role: 'user',
    },
  });
  created = true;

  const attempts = await Promise.all(
    Array.from({ length: 24 }, () => reserveTwoFactorAttempt(userId)),
  );
  assert.equal(attempts.filter(attempt => attempt.allowed).length, 5);
  assert.equal(attempts.filter(attempt => !attempt.allowed).length, 19);
  const fifthAttempt = attempts.find(attempt => attempt.allowed && attempt.lockedUntil);
  assert.ok(fifthAttempt?.lockedUntil);
  assert.ok(fifthAttempt.lockedUntil.getTime() > Date.now() + 14 * 60 * 1000);
  const rejectedAttempt = attempts.find(attempt => !attempt.allowed);
  assert.ok(rejectedAttempt?.lockedUntil);
  assert.ok(rejectedAttempt.lockedUntil.getTime() > Date.now() + 14 * 60 * 1000);

  const firstWindow = await prisma.client.twoFactorRateLimit.findUniqueOrThrow({
    where: { userId },
  });
  assert.equal(firstWindow.attempts, 5);
  const firstExpiry = await prisma.client.$queryRaw<Array<{ epoch: number }>>`
    SELECT EXTRACT(EPOCH FROM "locked_until")::float8 AS "epoch"
    FROM "two_factor_rate_limit" WHERE "user_id" = ${userId}::uuid
  `;
  assert.ok(
    firstExpiry[0].epoch * 1000 > Date.now() + 14 * 60 * 1000,
    `Unexpected lock expiry at ${firstExpiry[0].epoch} epoch seconds`,
  );
  assert.equal((await reserveTwoFactorAttempt(userId)).allowed, false);

  await prisma.client.$executeRaw`
    UPDATE "two_factor_rate_limit"
    SET "locked_until" = clock_timestamp() - interval '1 minute'
    WHERE "user_id" = ${userId}::uuid
  `;

  const afterExpiry = await reserveTwoFactorAttempt(userId);
  assert.equal(afterExpiry.allowed, true);
  assert.equal(afterExpiry.lockedUntil, undefined);

  const secondWindow = await prisma.client.twoFactorRateLimit.findUniqueOrThrow({
    where: { userId },
  });
  assert.equal(secondWindow.attempts, 1);
  assert.equal(secondWindow.lockedUntil, null);

  for (let attempt = 2; attempt <= 5; attempt++) {
    assert.equal((await reserveTwoFactorAttempt(userId)).allowed, true);
  }
  assert.equal((await reserveTwoFactorAttempt(userId)).allowed, false);

  await resetRateLimit(userId);
  assert.equal(await prisma.client.twoFactorRateLimit.findUnique({ where: { userId } }), null);
  assert.equal((await reserveTwoFactorAttempt(userId)).allowed, true);
  assert.equal(await consumeOtp(userId, '123456'), true);
  assert.equal(await consumeOtp(userId, '123456'), false);

  console.log('Atomic two-factor admission, lock expiry, and success reset passed.');
} finally {
  await prisma.client.twoFactorRateLimit.deleteMany({ where: { userId } });
  await prisma.client.twoFactorOtpUsed.deleteMany({ where: { userId } });
  if (created) {
    await prisma.client.user.delete({ where: { id: userId } });
  }
  await prisma.client.$disconnect();
}
