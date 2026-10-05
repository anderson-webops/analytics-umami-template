import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { checkAuth } from '@/lib/auth';
import { hash, secret } from '@/lib/crypto';
import { createSecureToken } from '@/lib/jwt';
import prisma from '@/lib/prisma';
import { createApiKey } from '@/queries/prisma/apiKey';
import { replacePasswordIfCurrent } from '@/queries/prisma/user';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
assert.equal(process.env.APP_SECRET, 'synthetic-session-generation-secret-0000000000000000');
assert.equal(process.env.REDIS_URL ?? '', '');
assert.equal(process.env.CLOUD_MODE ?? '', '');
const address = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname));
assert.equal(address.pathname, '/postgres');

const userId = randomUUID();
const password = 'x'.repeat(60);
let created = false;

async function sessionRequest(token: string) {
  return checkAuth(
    new Request('http://localhost/api/2fa/status', {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

try {
  await prisma.client.user.create({
    data: {
      id: userId,
      username: `session-generation-${userId}`,
      password,
      role: 'user',
    },
  });
  created = true;

  const factor = await prisma.client.twoFactorAuth.create({
    data: { userId, secret: 'synthetic-factor', isEnabled: true },
  });
  const oldVerifiedToken = await createSecureToken(
    { userId, role: 'user', pwd: hash(password), mfa: true, mfaId: factor.id },
    secret(),
    { expiresIn: '5m' },
  );
  const oldPasswordToken = await createSecureToken(
    { userId, role: 'user', pwd: hash(password) },
    secret(),
    { expiresIn: '5m' },
  );

  assert.equal((await sessionRequest(oldVerifiedToken))?.user?.id, userId);
  assert.equal(await sessionRequest(oldPasswordToken), null);

  await prisma.transaction(async transaction => {
    const removed = await transaction.twoFactorAuth.deleteMany({
      where: { id: factor.id, userId },
    });
    assert.equal(removed.count, 1);
    const updated = await transaction.user.updateMany({
      where: { id: userId, deletedAt: null },
      data: { sessionGeneration: { increment: 1 } },
    });
    assert.equal(updated.count, 1);
  });

  assert.equal(await sessionRequest(oldVerifiedToken), null);
  assert.equal(await sessionRequest(oldPasswordToken), null);
  await assert.rejects(
    replacePasswordIfCurrent(userId, password, 'y'.repeat(60), 0),
    /USER_CREDENTIALS_CHANGED/,
  );

  const replacementToken = await createSecureToken(
    { userId, role: 'user', pwd: hash(password), sessionGeneration: 1 },
    secret(),
    { expiresIn: '5m' },
  );
  assert.equal((await sessionRequest(replacementToken))?.user?.id, userId);
  const keyId = randomUUID();
  const apiKey = {
    id: keyId,
    userId,
    name: 'synthetic key',
    keyHash: 'a'.repeat(128),
    keyPrefix: 'umami_synthetic',
  };
  assert.equal(await createApiKey(apiKey, 0), null);
  assert.equal(await prisma.client.apiKey.findUnique({ where: { id: keyId } }), null);
  assert.equal((await createApiKey(apiKey, 1))?.id, keyId);
  assert.equal(
    (await prisma.client.user.findUniqueOrThrow({ where: { id: userId } })).password,
    password,
  );

  console.log('PostgreSQL session revocation and stale credential issuance denial passed.');
} finally {
  await prisma.client.apiKey.deleteMany({ where: { userId } });
  await prisma.client.twoFactorAuth.deleteMany({ where: { userId } });
  if (created) {
    await prisma.client.user.delete({ where: { id: userId } });
  }
  await prisma.client.$disconnect();
}
