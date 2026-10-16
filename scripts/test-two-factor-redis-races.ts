import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { generate, generateSecret } from 'otplib';
import { Client } from 'pg';
import { POST as cancelSetup } from '@/app/api/2fa/setup/cancel/route';
import { POST as confirmSetup } from '@/app/api/2fa/setup/confirm/route';
import { POST as initiateSetup } from '@/app/api/2fa/setup/initiate/route';
import { POST as logoutSession } from '@/app/api/auth/logout/route';
import { hash, secret } from '@/lib/crypto';
import { createSecureToken } from '@/lib/jwt';
import { hashPassword } from '@/lib/password';
import { getPasswordVerificationBudgetKey } from '@/lib/password-verification-rate-limit';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';
import { encryptSecret } from '@/lib/two-factor/crypto';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
assert.equal(process.env.APP_SECRET, 'synthetic-factor-race-secret-000000000000000000');
const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
const redisUrl = new URL(process.env.REDIS_URL ?? '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname));
assert.equal(databaseUrl.pathname, '/postgres');
assert.equal(redisUrl.protocol, 'redis:');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(redisUrl.hostname));
assert.equal(redisUrl.username, '');
assert.equal(redisUrl.password, '');
assert.equal(redis.enabled, true);

const inspector = new Client({ connectionString: databaseUrl.toString() });
const userIds: string[] = [];
const authKeys: string[] = [];
let stage = 'connect';

async function waitForBlockedRequests(count: number) {
  for (let attempt = 0; attempt < 160; attempt++) {
    const result = await inspector.query<{ blocked: number }>(`
      SELECT count(*)::int AS blocked FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND pid <> pg_backend_pid()
    `);
    if (result.rows[0].blocked >= count) {
      return;
    }
    await delay(25);
  }
  throw new Error(`Expected ${count} blocked credential transactions`);
}

async function withTimeout<Result>(promise: Promise<Result>, message: string) {
  return Promise.race([
    promise,
    delay(8_000).then(() => {
      throw new Error(message);
    }),
  ]);
}

async function createFixture(label: string) {
  const userId = randomUUID();
  const authKey = `auth:synthetic-race:${randomUUID()}`;
  const password = `synthetic-${label}-password-000000000000`;
  const passwordHash = await hashPassword(password);
  const totpSecret = generateSecret();
  userIds.push(userId);
  authKeys.push(authKey);
  await prisma.client.user.create({
    data: {
      id: userId,
      username: `factor-redis-race-${label}-${userId}`,
      password: passwordHash,
      role: 'user',
    },
  });
  const factor = await prisma.client.twoFactorAuth.create({
    data: { userId, secret: encryptSecret(totpSecret), isEnabled: false },
  });
  await redis.client.set(
    authKey,
    { userId, role: 'user', pwd: hash(passwordHash), sessionGeneration: 0 },
    300,
  );
  const sessionToken = await createSecureToken({ authKey }, secret(), { expiresIn: 300 });
  const millisecondsUntilRollover = 30_000 - (Date.now() % 30_000);
  if (millisecondsUntilRollover < 10_000) {
    await delay(millisecondsUntilRollover + 100);
  }
  return {
    userId,
    authKey,
    factorId: factor.id,
    password,
    passwordHash,
    sessionToken,
    totpCode: await generate({ secret: totpSecret }),
  };
}

function request(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  path: string,
  body?: Record<string, string>,
) {
  return new Request(`https://analytics.example.com${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${fixture.sessionToken}`,
      'content-type': 'application/json',
      origin: 'https://analytics.example.com',
    },
    body: JSON.stringify(body ?? {}),
  });
}

async function assertRevokedBeforeWrite(
  label: string,
  operation: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<Response>,
) {
  stage = label;
  const fixture = await createFixture(label);
  const before = await inspector.query<{ secret: string }>(
    'SELECT secret FROM two_factor_auth WHERE id = $1',
    [fixture.factorId],
  );
  const blocker = new Client({ connectionString: databaseUrl.toString() });
  await blocker.connect();
  let pendingLogout: Promise<Response> | null = null;
  let pendingMutation: Promise<Response> | null = null;

  try {
    await blocker.query('BEGIN');
    await blocker.query("SELECT pg_advisory_xact_lock(hashtext('umami:user-mutations'))");

    pendingLogout = logoutSession(request(fixture, '/api/auth/logout'));
    await waitForBlockedRequests(1);
    pendingMutation = operation(fixture);
    await waitForBlockedRequests(2);

    await blocker.query('ROLLBACK');
    const logout = await withTimeout(pendingLogout, `${label} logout did not finish`);
    assert.equal(logout.status, 200);
    const result = await withTimeout(pendingMutation, `${label} mutation did not finish`);
    assert.equal(result.status, 401);
    assert.equal(await redis.client.get(fixture.authKey), null);

    const after = await inspector.query<{ secret: string; is_enabled: boolean }>(
      'SELECT secret, is_enabled FROM two_factor_auth WHERE id = $1',
      [fixture.factorId],
    );
    assert.deepEqual(after.rows, [{ secret: before.rows[0].secret, is_enabled: false }]);
  } finally {
    await blocker.query('ROLLBACK');
    await Promise.allSettled([pendingLogout, pendingMutation].filter(Boolean));
    await blocker.end();
  }
}

try {
  await inspector.connect();
  await assertRevokedBeforeWrite('initiate', fixture =>
    initiateSetup(request(fixture, '/api/2fa/setup/initiate', { password: fixture.password })),
  );
  await assertRevokedBeforeWrite('cancel', fixture =>
    cancelSetup(request(fixture, '/api/2fa/setup/cancel')),
  );
  await assertRevokedBeforeWrite('confirm', fixture =>
    confirmSetup(
      request(fixture, '/api/2fa/setup/confirm', {
        password: fixture.password,
        token: fixture.totpCode,
      }),
    ),
  );
  stage = 'independent Redis sessions';
  const retained = await createFixture('retained-session');
  const secondAuthKey = `auth:synthetic-race:${randomUUID()}`;
  authKeys.push(secondAuthKey);
  await redis.client.set(
    secondAuthKey,
    {
      userId: retained.userId,
      role: 'user',
      pwd: hash(retained.passwordHash),
      sessionGeneration: 0,
    },
    300,
  );
  const secondSessionToken = await createSecureToken({ authKey: secondAuthKey }, secret(), {
    expiresIn: 300,
  });
  const logout = await logoutSession(request(retained, '/api/auth/logout'));
  assert.equal(logout.status, 200);
  assert.equal(await redis.client.get(retained.authKey), null);
  assert.ok(await redis.client.get(secondAuthKey));
  const cancel = await cancelSetup(
    request({ ...retained, sessionToken: secondSessionToken }, '/api/2fa/setup/cancel'),
  );
  assert.equal(cancel.status, 200);
  assert.equal(
    await prisma.client.twoFactorAuth.findUnique({ where: { id: retained.factorId } }),
    null,
  );
  console.log('Redis session deletion precedes all in-flight 2FA setup writes.');
} catch (error) {
  console.error(`Synthetic Redis factor race failed during ${stage}.`);
  console.error(`Caught ${error instanceof Error ? error.name : typeof error}.`);
  throw error;
} finally {
  for (const authKey of authKeys) {
    await redis.client.del(authKey);
  }
  for (const userId of userIds) {
    await inspector.query('DELETE FROM two_factor_backup_code WHERE user_id = $1', [userId]);
    await inspector.query('DELETE FROM two_factor_otp_used WHERE user_id = $1', [userId]);
    await inspector.query('DELETE FROM two_factor_rate_limit WHERE user_id = $1', [userId]);
    await inspector.query('DELETE FROM two_factor_auth WHERE user_id = $1', [userId]);
    await inspector.query('DELETE FROM app_setting WHERE key = $1', [
      getPasswordVerificationBudgetKey(userId),
    ]);
    await inspector.query('DELETE FROM "user" WHERE user_id = $1', [userId]);
  }
  await inspector.end();
  await prisma.client.$disconnect();
  if (redis.client.client.isOpen) {
    await redis.client.client.quit();
  }
}
