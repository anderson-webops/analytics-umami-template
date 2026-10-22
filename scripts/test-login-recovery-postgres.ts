import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { POST as login } from '@/app/api/auth/login/route';
import { POST as issueRecoveryCodes } from '@/app/api/auth/recovery-codes/route';
import { hash, secret } from '@/lib/crypto';
import { createSecureToken } from '@/lib/jwt';
import {
  getLoginLimit,
  releaseLoginOverflowAttempt,
  reserveLoginAccountAttempt,
  reserveLoginOverflowAttempt,
} from '@/lib/login-rate-limit';
import {
  consumeLoginRecoveryCode,
  generateLoginRecoveryCodes,
  getLoginRecoveryKeyFingerprint,
  lookupLoginRecoveryCode,
  persistLoginRecoveryCodes,
} from '@/lib/login-recovery';
import { hashPassword } from '@/lib/password';
import prisma from '@/lib/prisma';
import { runCredentialRevocationMutation } from '@/queries/prisma/authorization';
import { rehashPasswordIfCurrent } from '@/queries/prisma/user';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname));
assert.ok(['/postgres', '/umami_login_recovery_test'].includes(databaseUrl.pathname));
const siteUrl = new URL(process.env.PUBLIC_URL || 'https://analytics.example.com');
const siteOrigin = siteUrl.origin;

const client = new Client({ connectionString: databaseUrl.toString() });
const ownerId = randomUUID();
const otherId = randomUUID();
const administratorId = randomUUID();

async function recoveryRequest(token: string, password: string, userId: string) {
  return issueRecoveryCodes(
    new Request(`${siteOrigin}/api/auth/recovery-codes`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        origin: siteOrigin,
      },
      body: JSON.stringify({ password, userId }),
    }),
  );
}

async function loginRequest(
  username: string,
  password: string,
  recoveryCode?: string,
  captchaToken?: string,
) {
  return login(
    new Request(`${siteOrigin}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: siteOrigin,
      },
      body: JSON.stringify({ username, password, recoveryCode, captchaToken }),
    }),
  );
}

try {
  await client.connect();
  const migration = await client.query<{ migration_name: string }>(
    `SELECT migration_name FROM "_prisma_migrations"
     WHERE migration_name = '41_add_login_recovery_credentials' AND finished_at IS NOT NULL`,
  );
  assert.equal(migration.rows.length, 1);
  await client.query(
    `INSERT INTO "user" (user_id, username, password, role)
     VALUES ($1, $2, $3, 'user'), ($4, $5, $6, 'user')`,
    [ownerId, 'alice', 'old-hash', otherId, 'bob', 'other-hash'],
  );

  const [first, second] = generateLoginRecoveryCodes();
  await prisma.client.loginRecoveryCredential.createMany({
    data: [first, second].map(({ digest }) => ({
      userId: ownerId,
      codeDigest: digest,
      passwordFingerprint: hash('old-hash'),
      keyFingerprint: getLoginRecoveryKeyFingerprint(),
    })),
  });

  const stored = await client.query<{ code_digest: string }>(
    'SELECT code_digest FROM login_recovery_credential WHERE user_id = $1',
    [ownerId],
  );
  assert.equal(stored.rows.length, 2);
  assert.ok(
    stored.rows.every(({ code_digest }) => ![first.code, second.code].includes(code_digest)),
  );
  assert.equal(await lookupLoginRecoveryCode('bob', first.code), null);
  const firstMatch = await lookupLoginRecoveryCode(' ALICE ', first.code);
  assert.deepEqual(firstMatch, { userId: ownerId, passwordHash: 'old-hash' });
  assert.ok(firstMatch);

  const attempts = await Promise.all(
    Array.from({ length: 12 }, () => consumeLoginRecoveryCode('alice', first.code, firstMatch)),
  );
  assert.equal(attempts.filter(userId => userId === ownerId).length, 1);
  assert.equal(await lookupLoginRecoveryCode('alice', first.code), null);

  await client.query('UPDATE "user" SET session_generation = 1 WHERE user_id = $1', [ownerId]);
  const secondMatch = await lookupLoginRecoveryCode('alice', second.code);
  assert.deepEqual(secondMatch, { userId: ownerId, passwordHash: 'old-hash' });
  assert.ok(secondMatch);
  await rehashPasswordIfCurrent(ownerId, 'old-hash', 'rehash-hash', 1);
  assert.deepEqual(await lookupLoginRecoveryCode('alice', second.code), {
    userId: ownerId,
    passwordHash: 'rehash-hash',
  });
  await client.query('UPDATE "user" SET password = $2 WHERE user_id = $1', [ownerId, 'new-hash']);
  assert.equal(await lookupLoginRecoveryCode('alice', second.code), null);
  assert.equal(await consumeLoginRecoveryCode('alice', second.code, secondMatch), null);

  const [current] = generateLoginRecoveryCodes();
  await prisma.client.loginRecoveryCredential.create({
    data: {
      userId: ownerId,
      codeDigest: current.digest,
      passwordFingerprint: hash('new-hash'),
      keyFingerprint: getLoginRecoveryKeyFingerprint(),
    },
  });
  const currentMatch = await lookupLoginRecoveryCode('alice', current.code);
  assert.deepEqual(currentMatch, { userId: ownerId, passwordHash: 'new-hash' });
  assert.ok(currentMatch);
  await client.query('UPDATE "user" SET deleted_at = CURRENT_TIMESTAMP WHERE user_id = $1', [
    ownerId,
  ]);
  assert.equal(await lookupLoginRecoveryCode('alice', current.code), null);
  assert.equal(await consumeLoginRecoveryCode('alice', current.code, currentMatch), null);

  await client.query('DELETE FROM "user" WHERE user_id = $1', [ownerId]);
  const afterDelete = await client.query<{ count: string }>(
    'SELECT count(*) FROM login_recovery_credential WHERE user_id = $1',
    [ownerId],
  );
  assert.equal(afterDelete.rows[0].count, '0');

  const administratorPassword = 'synthetic-admin-password-000000000000';
  const administratorHash = await hashPassword(administratorPassword);
  const targetPassword = 'synthetic-target-password-000000000000';
  const targetHash = await hashPassword(targetPassword);
  await prisma.client.user.create({
    data: {
      id: administratorId,
      username: 'recovery-administrator',
      password: administratorHash,
      role: 'admin',
    },
  });
  await client.query('UPDATE "user" SET password = $2 WHERE user_id = $1', [otherId, targetHash]);
  const administratorToken = await createSecureToken(
    {
      userId: administratorId,
      role: 'admin',
      pwd: hash(administratorHash),
      sessionGeneration: 0,
    },
    secret(),
    { expiresIn: '5m' },
  );
  const targetToken = await createSecureToken(
    { userId: otherId, role: 'user', pwd: hash(targetHash), sessionGeneration: 0 },
    secret(),
    { expiresIn: '5m' },
  );

  const forbiddenResponse = await recoveryRequest(targetToken, targetPassword, administratorId);
  assert.equal(forbiddenResponse.status, 403);
  const badPasswordResponse = await recoveryRequest(administratorToken, 'wrong-password', otherId);
  assert.equal(badPasswordResponse.status, 400);

  const issuedResponse = await recoveryRequest(administratorToken, administratorPassword, otherId);
  assert.equal(issuedResponse.status, 200);
  assert.equal(issuedResponse.headers.get('Cache-Control'), 'no-store');
  const { recoveryCodes } = (await issuedResponse.json()) as { recoveryCodes: string[] };
  assert.equal(recoveryCodes.length, 8);
  assert.equal(new Set(recoveryCodes).size, recoveryCodes.length);
  const storedTargetCodes = await client.query<{ code_digest: string }>(
    'SELECT code_digest FROM login_recovery_credential WHERE user_id = $1',
    [otherId],
  );
  assert.equal(storedTargetCodes.rows.length, recoveryCodes.length);
  assert.ok(storedTargetCodes.rows.every(row => !recoveryCodes.includes(row.code_digest)));
  assert.deepEqual(await lookupLoginRecoveryCode('bob', recoveryCodes[0]), {
    userId: otherId,
    passwordHash: targetHash,
  });
  assert.equal(await lookupLoginRecoveryCode('recovery-administrator', recoveryCodes[0]), null);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await reserveLoginAccountAttempt('bob')).blocked, false);
  }
  assert.equal((await reserveLoginAccountAttempt('bob')).blocked, true);
  assert.equal((await loginRequest('bob', targetPassword)).status, 401);
  const sourceRequest = new Request(`${siteOrigin}/api/auth/login`);
  for (let attempt = 0; attempt < 11; attempt += 1) {
    await getLoginLimit(sourceRequest, 'bob');
  }
  assert.equal((await loginRequest('bob', targetPassword)).status, 429);
  const ownerRecoveryResponse = await loginRequest('bob', targetPassword, recoveryCodes[0]);
  assert.equal(ownerRecoveryResponse.status, 200);
  assert.ok(ownerRecoveryResponse.headers.get('Set-Cookie')?.includes('analytics-session='));
  assert.equal(await lookupLoginRecoveryCode('bob', recoveryCodes[0]), null);
  assert.equal((await loginRequest('bob', targetPassword, recoveryCodes[0])).status, 401);
  assert.equal((await loginRequest('bob', 'wrong-password', recoveryCodes[1])).status, 401);
  assert.equal(await lookupLoginRecoveryCode('bob', recoveryCodes[1]), null);

  const overflow = await reserveLoginOverflowAttempt('bob');
  assert.equal(overflow.blocked, false);
  if (!overflow.blocked) {
    await releaseLoginOverflowAttempt('bob', overflow.windowExpiresAt, overflow.leaseId);
  }

  const originalFetch = globalThis.fetch;
  const originalPublicUrl = process.env.PUBLIC_URL;
  process.env.TURNSTILE_SITE_KEY = 'synthetic-local-site-key';
  process.env.TURNSTILE_SECRET_KEY = 'synthetic-local-secret-key';
  process.env.PUBLIC_URL = siteOrigin;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(init?.method, 'POST');
    assert.ok(init?.body instanceof URLSearchParams);
    assert.equal(init.body.get('secret'), 'synthetic-local-secret-key');
    assert.ok(['challenge-1', 'challenge-2'].includes(init.body.get('response') ?? ''));
    return Response.json({ success: true, action: 'login', hostname: siteUrl.hostname });
  };
  try {
    assert.equal((await loginRequest('bob', targetPassword, undefined, 'challenge-1')).status, 401);
    assert.equal((await loginRequest('bob', targetPassword, recoveryCodes[2])).status, 401);
    const challengedRecovery = await loginRequest(
      'bob',
      targetPassword,
      recoveryCodes[2],
      'challenge-2',
    );
    assert.equal(challengedRecovery.status, 200);
    assert.equal(await lookupLoginRecoveryCode('bob', recoveryCodes[2]), null);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
    if (originalPublicUrl === undefined) {
      delete process.env.PUBLIC_URL;
    } else {
      process.env.PUBLIC_URL = originalPublicUrl;
    }
  }

  await client.query('UPDATE "user" SET role = $2 WHERE user_id = $1', [administratorId, 'user']);
  const downgradedResponse = await recoveryRequest(
    administratorToken,
    administratorPassword,
    otherId,
  );
  assert.equal(downgradedResponse.status, 401);
  const retainedCodes = await client.query<{ code_digest: string }>(
    'SELECT code_digest FROM login_recovery_credential WHERE user_id = $1',
    [otherId],
  );
  assert.deepEqual(retainedCodes.rows, storedTargetCodes.rows);

  await client.query('UPDATE "user" SET role = $2 WHERE user_id = $1', [administratorId, 'admin']);
  const bootstrapCodes = generateLoginRecoveryCodes();
  await runCredentialRevocationMutation(transaction =>
    persistLoginRecoveryCodes(transaction, administratorId, bootstrapCodes),
  );
  assert.deepEqual(
    await lookupLoginRecoveryCode('recovery-administrator', bootstrapCodes[0].code),
    { userId: administratorId, passwordHash: administratorHash },
  );
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await reserveLoginAccountAttempt('recovery-administrator')).blocked, false);
  }
  const bootstrapResponse = await loginRequest(
    'recovery-administrator',
    administratorPassword,
    bootstrapCodes[0].code,
  );
  assert.equal(bootstrapResponse.status, 200);
  assert.equal(
    await lookupLoginRecoveryCode('recovery-administrator', bootstrapCodes[0].code),
    null,
  );

  console.log(
    'Disposable PostgreSQL login recovery, targeted lockout, and administrator route passed.',
  );
} finally {
  await prisma.client.$disconnect();
  await client.end();
}
