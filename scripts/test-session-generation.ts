import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { checkAuth } from '@/lib/auth';
import { hash, secret } from '@/lib/crypto';
import { createSecureToken } from '@/lib/jwt';
import { hashPassword } from '@/lib/password';
import prisma from '@/lib/prisma';
import { createApiKey } from '@/queries/prisma/apiKey';
import {
  rehashPasswordIfCurrent,
  replacePasswordIfCurrent,
  updateUser,
} from '@/queries/prisma/user';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
assert.equal(process.env.APP_SECRET, 'synthetic-session-generation-secret-0000000000000000');
assert.equal(process.env.REDIS_URL ?? '', '');
assert.equal(process.env.CLOUD_MODE ?? '', '');
const address = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname));
assert.equal(address.pathname, '/postgres');

const userId = randomUUID();
const adminId = randomUUID();
const username = `session-generation-${userId}`;
const provisionedUsername = `session-admin-${adminId}`;
const provisioningDomain = `session-${adminId}.example.test`;
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
      username,
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
  assert.equal(await createApiKey(apiKey, 0, password), null);
  assert.equal(await prisma.client.apiKey.findUnique({ where: { id: keyId } }), null);
  assert.equal((await createApiKey(apiKey, 1, password))?.id, keyId);
  assert.equal(
    (await prisma.client.user.findUniqueOrThrow({ where: { id: userId } })).password,
    password,
  );

  const nextPassword = 'y'.repeat(60);
  const rotated = await replacePasswordIfCurrent(userId, password, nextPassword, 1);
  assert.equal(rotated?.sessionGeneration, 2);
  assert.equal(await prisma.client.apiKey.findUnique({ where: { id: keyId } }), null);
  assert.equal(await sessionRequest(replacementToken), null);
  assert.equal(
    await createApiKey({ ...apiKey, id: randomUUID(), keyHash: 'b'.repeat(128) }, 1, password),
    null,
  );
  assert.equal(
    (await prisma.client.user.findUniqueOrThrow({ where: { id: userId } })).password,
    nextPassword,
  );

  const rehashKeyId = randomUUID();
  assert.equal(
    (await createApiKey({ ...apiKey, id: rehashKeyId, keyHash: 'c'.repeat(128) }, 2, nextPassword))
      ?.id,
    rehashKeyId,
  );
  const rehashed = await rehashPasswordIfCurrent(userId, nextPassword, 'z'.repeat(60), 2);
  assert.equal(rehashed?.sessionGeneration, 2);
  assert.notEqual(await prisma.client.apiKey.findUnique({ where: { id: rehashKeyId } }), null);

  await prisma.client.user.create({
    data: {
      id: adminId,
      username: provisionedUsername,
      password: await hashPassword('synthetic-role-admin-password-000000'),
      role: 'admin',
    },
  });
  await updateUser(userId, { password: 'w'.repeat(60) }, adminId);
  assert.equal(
    (await prisma.client.user.findUniqueOrThrow({ where: { id: userId } })).sessionGeneration,
    3,
  );
  assert.equal(await prisma.client.apiKey.findUnique({ where: { id: rehashKeyId } }), null);

  const operatorKeyId = randomUUID();
  assert.equal(
    (
      await createApiKey(
        { ...apiKey, id: operatorKeyId, keyHash: 'd'.repeat(128) },
        3,
        'w'.repeat(60),
      )
    )?.id,
    operatorKeyId,
  );
  const operatorRotation = spawnSync(process.execPath, ['scripts/change-password.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DOTENV_CONFIG_PATH: '/dev/null',
      UMAMI_USERNAME: username,
      UMAMI_PASSWORD: 'synthetic-operator-rotation-000000000000',
    },
    encoding: 'utf8',
  });
  assert.equal(operatorRotation.status, 0, operatorRotation.stderr);
  assert.equal(
    (await prisma.client.user.findUniqueOrThrow({ where: { id: userId } })).sessionGeneration,
    4,
  );
  assert.equal(await prisma.client.apiKey.findUnique({ where: { id: operatorKeyId } }), null);

  const racingKey = { ...apiKey, id: randomUUID(), keyHash: 'e'.repeat(128) };
  let releaseKey: () => void = () => {};
  let signalKeyReady: () => void = () => {};
  const keyGate = new Promise<void>(resolve => {
    releaseKey = resolve;
  });
  const keyReady = new Promise<void>(resolve => {
    signalKeyReady = resolve;
  });
  const keyTransaction = prisma.transaction(async transaction => {
    const rows = await transaction.$queryRaw<Array<{ sessionGeneration: number }>>`
      SELECT session_generation AS "sessionGeneration" FROM "user"
      WHERE user_id = ${userId}::uuid FOR UPDATE
    `;
    assert.equal(rows[0]?.sessionGeneration, 4);
    signalKeyReady();
    await keyGate;
    await transaction.apiKey.create({ data: racingKey });
  });

  await keyReady;
  const operatorPassword = (await prisma.client.user.findUniqueOrThrow({ where: { id: userId } }))
    .password;
  const racingRotation = replacePasswordIfCurrent(userId, operatorPassword, 'r'.repeat(60), 4);

  try {
    let blocked = false;

    for (let attempt = 0; attempt < 200; attempt++) {
      const [{ waiting }] = await prisma.client.$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND wait_event IN ('transactionid', 'tuple')
      `;

      if (waiting > 0) {
        blocked = true;
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 25));
    }

    assert.equal(blocked, true);
  } finally {
    releaseKey();
  }

  await keyTransaction;
  assert.equal((await racingRotation)?.sessionGeneration, 5);
  assert.equal(await prisma.client.apiKey.findUnique({ where: { id: racingKey.id } }), null);
  assert.equal(
    await createApiKey(
      { ...apiKey, id: randomUUID(), keyHash: 'f'.repeat(128) },
      4,
      operatorPassword,
    ),
    null,
  );

  const protectedKeyId = randomUUID();
  assert.equal(
    (
      await createApiKey(
        { ...apiKey, id: protectedKeyId, keyHash: 'g'.repeat(128) },
        5,
        'r'.repeat(60),
      )
    )?.id,
    protectedKeyId,
  );

  let releaseDemotion: () => void = () => {};
  let signalDemotionReady: () => void = () => {};
  const demotionGate = new Promise<void>(resolve => {
    releaseDemotion = resolve;
  });
  const demotionReady = new Promise<void>(resolve => {
    signalDemotionReady = resolve;
  });
  const demotion = prisma.transaction(
    async transaction => {
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtext(${'umami:user-mutations'}))::text
      `;
      await transaction.user.update({ where: { id: adminId }, data: { role: 'user' } });
      signalDemotionReady();
      await demotionGate;
    },
    { isolationLevel: 'Serializable', timeout: 15_000 },
  );

  await demotionReady;
  const staleAdminReset = updateUser(userId, { password: 's'.repeat(60) }, adminId).then(
    () => null,
    error => error,
  );

  try {
    let blocked = false;

    for (let attempt = 0; attempt < 200; attempt++) {
      const [{ waiting }] = await prisma.client.$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
      `;

      if (waiting > 0) {
        blocked = true;
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 25));
    }

    assert.equal(blocked, true);
  } finally {
    releaseDemotion();
  }

  await demotion;
  assert.match((await staleAdminReset)?.message ?? '', /ADMIN_AUTHORIZATION_CHANGED/);
  assert.equal(
    (await prisma.client.user.findUniqueOrThrow({ where: { id: userId } })).sessionGeneration,
    5,
  );
  assert.equal(
    (await prisma.client.user.findUniqueOrThrow({ where: { id: userId } })).password,
    'r'.repeat(60),
  );
  assert.notEqual(await prisma.client.apiKey.findUnique({ where: { id: protectedKeyId } }), null);

  const prePromotionToken = await createSecureToken(
    {
      userId: adminId,
      role: 'user',
      pwd: hash((await prisma.client.user.findUniqueOrThrow({ where: { id: adminId } })).password),
    },
    secret(),
    { expiresIn: '5m' },
  );
  assert.equal((await sessionRequest(prePromotionToken))?.user?.id, adminId);

  function provisionAdmin(extraEnv: Record<string, string> = {}) {
    return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/provision-site.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DOTENV_CONFIG_PATH: '/dev/null',
        UMAMI_ADMIN_USERNAME: provisionedUsername,
        UMAMI_PROMOTE_EXISTING_ADMIN: 'true',
        UMAMI_WEBSITE_NAME: 'Synthetic session provisioning',
        UMAMI_WEBSITE_DOMAIN: provisioningDomain,
        UMAMI_ADMIN_PASSWORD: '',
        UMAMI_UPDATE_ADMIN_PASSWORD: '',
        ...extraEnv,
      },
      encoding: 'utf8',
    });
  }

  const promoted = provisionAdmin();
  assert.equal(promoted.status, 0, promoted.stderr);
  const promotedUser = await prisma.client.user.findUniqueOrThrow({ where: { id: adminId } });
  assert.equal(promotedUser.role, 'admin');
  assert.equal(promotedUser.sessionGeneration, 1);
  assert.equal(await sessionRequest(prePromotionToken), null);

  const repeatedProvision = provisionAdmin();
  assert.equal(repeatedProvision.status, 0, repeatedProvision.stderr);
  assert.equal(
    (await prisma.client.user.findUniqueOrThrow({ where: { id: adminId } })).sessionGeneration,
    1,
  );

  await prisma.client.user.update({ where: { id: adminId }, data: { role: 'user' } });
  const preCombinedToken = await createSecureToken(
    {
      userId: adminId,
      role: 'user',
      pwd: hash((await prisma.client.user.findUniqueOrThrow({ where: { id: adminId } })).password),
      sessionGeneration: 1,
    },
    secret(),
    { expiresIn: '5m' },
  );
  assert.equal((await sessionRequest(preCombinedToken))?.user?.id, adminId);

  const combinedProvision = provisionAdmin({
    UMAMI_ADMIN_PASSWORD: 'synthetic-provision-password-000000000000',
    UMAMI_UPDATE_ADMIN_PASSWORD: 'true',
  });
  assert.equal(combinedProvision.status, 0, combinedProvision.stderr);
  const combinedUser = await prisma.client.user.findUniqueOrThrow({ where: { id: adminId } });
  assert.equal(combinedUser.role, 'admin');
  assert.equal(combinedUser.sessionGeneration, 2);
  assert.equal(await sessionRequest(preCombinedToken), null);

  console.log('PostgreSQL session revocation and stale credential issuance denial passed.');
} finally {
  await prisma.client.apiKey.deleteMany({ where: { userId } });
  await prisma.client.twoFactorAuth.deleteMany({ where: { userId } });
  await prisma.client.website.deleteMany({ where: { domain: provisioningDomain } });
  if (created) {
    await prisma.client.user.delete({ where: { id: userId } });
  }
  await prisma.client.user.deleteMany({ where: { id: adminId } });
  await prisma.client.$disconnect();
}
