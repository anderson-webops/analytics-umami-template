import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { generate, generateSecret } from 'otplib';
import { Client } from 'pg';
import { POST as disableFactor } from '@/app/api/2fa/disable/route';
import { POST as cancelSetup } from '@/app/api/2fa/setup/cancel/route';
import { POST as confirmSetup } from '@/app/api/2fa/setup/confirm/route';
import { POST as initiateSetup } from '@/app/api/2fa/setup/initiate/route';
import { checkAuth } from '@/lib/auth';
import { hash, secret } from '@/lib/crypto';
import { createSecureToken } from '@/lib/jwt';
import { hashPassword } from '@/lib/password';
import { getPasswordVerificationBudgetKey } from '@/lib/password-verification-rate-limit';
import prisma from '@/lib/prisma';
import { encryptSecret } from '@/lib/two-factor/crypto';
import { replacePasswordIfCurrent } from '@/queries/prisma/user';

assert.equal(process.env.ALLOW_DESTRUCTIVE_MIGRATION_TEST, '1');
assert.equal(process.env.APP_SECRET, 'synthetic-factor-race-secret-000000000000000000');
assert.equal(process.env.REDIS_URL ?? '', '');
assert.equal(process.env.CLOUD_MODE ?? '', '');
const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname));
assert.equal(databaseUrl.pathname, '/postgres');

const totpStepMilliseconds = 30_000;
const inspector = new Client({ connectionString: databaseUrl.toString() });
const userIds: string[] = [];
let inspectorConnected = false;
let releaseRevocation = () => {};
let pendingRevocation: Promise<unknown> | null = null;
let pendingConfirmation: Promise<Response> | null = null;
let releaseRotation = () => {};
let pendingRotation: Promise<unknown> | null = null;
let pendingRotatedConfirmation: Promise<Response> | null = null;
let releaseActivation = () => {};
let pendingActivation: Promise<unknown> | null = null;
let pendingInitiation: Promise<Response> | null = null;
let releaseDisableRevocation = () => {};
let pendingDisableRevocation: Promise<unknown> | null = null;
let pendingDisable: Promise<Response> | null = null;
let releaseCancellationActivation = () => {};
let pendingCancellationActivation: Promise<unknown> | null = null;
let pendingCancellation: Promise<Response> | null = null;
let releaseCredentialEpoch = () => {};
let pendingCredentialEpoch: Promise<unknown> | null = null;
let pendingPasswordReplacement: Promise<string> | null = null;
let releaseInitiationRevocation = () => {};
let pendingInitiationRevocation: Promise<unknown> | null = null;
let pendingStaleInitiation: Promise<Response> | null = null;
let stage = 'connect';

async function withTimeout<Result>(
  promise: Promise<Result>,
  milliseconds: number,
  message: string,
) {
  return Promise.race([
    promise,
    delay(milliseconds).then(() => {
      throw new Error(message);
    }),
  ]);
}

async function waitForDatabaseLock(message: string, requestFinished?: () => boolean) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const result = await inspector.query<{ blocked: number }>(`
      SELECT count(*)::int AS blocked FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND pid <> pg_backend_pid()
    `);
    if (result.rows[0].blocked > 0) {
      return;
    }
    if (requestFinished) {
      assert.equal(requestFinished(), false, 'Request finished before the held row lock');
    }
    await delay(25);
  }
  throw new Error(message);
}

async function generateStableTotpCode(totpSecret: string) {
  const millisecondsUntilRollover = totpStepMilliseconds - (Date.now() % totpStepMilliseconds);
  if (millisecondsUntilRollover < 10_000) {
    await delay(millisecondsUntilRollover + 100);
  }
  return generate({ secret: totpSecret });
}

async function createFixture(label: string, isEnabled = false) {
  const userId = randomUUID();
  const password = `synthetic-${label}-password-000000000000`;
  const passwordHash = await hashPassword(password);
  const totpSecret = generateSecret();
  userIds.push(userId);
  await prisma.client.user.create({
    data: {
      id: userId,
      username: `factor-race-${label}-${userId}`,
      password: passwordHash,
      role: 'user',
    },
  });
  const factor = await prisma.client.twoFactorAuth.create({
    data: { userId, secret: encryptSecret(totpSecret), isEnabled },
  });
  const sessionToken = await createSecureToken(
    {
      userId,
      role: 'user',
      pwd: hash(passwordHash),
      sessionGeneration: 0,
      ...(isEnabled ? { mfa: true, mfaId: factor.id } : {}),
    },
    secret(),
    { expiresIn: '5m' },
  );

  return {
    userId,
    password,
    passwordHash,
    factorId: factor.id,
    sessionToken,
    totpCode: await generateStableTotpCode(totpSecret),
  };
}

function confirmRequest(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return new Request('https://analytics.example.com/api/2fa/setup/confirm', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${fixture.sessionToken}`,
      'content-type': 'application/json',
      origin: 'https://analytics.example.com',
    },
    body: JSON.stringify({ token: fixture.totpCode, password: fixture.password }),
  });
}

function disableRequest(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return new Request('https://analytics.example.com/api/2fa/disable', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${fixture.sessionToken}`,
      'content-type': 'application/json',
      origin: 'https://analytics.example.com',
    },
    body: JSON.stringify({ password: fixture.password, token: fixture.totpCode }),
  });
}

try {
  await inspector.connect();
  inspectorConnected = true;

  stage = 'ordinary fixture';
  const ordinary = await createFixture('ordinary');
  stage = 'ordinary confirmation';
  const ordinaryResponse = await confirmSetup(confirmRequest(ordinary));
  assert.equal(ordinaryResponse.status, 200);
  assert.ok((await ordinaryResponse.json()).backupCodes.length > 0);
  assert.equal(
    (await prisma.client.twoFactorAuth.findUniqueOrThrow({ where: { id: ordinary.factorId } }))
      .isEnabled,
    true,
  );

  stage = 'ordinary factor disable';
  const ordinaryDisable = await createFixture('ordinary-disable', true);
  const ordinaryDisableResponse = await disableFactor(disableRequest(ordinaryDisable));
  assert.equal(ordinaryDisableResponse.status, 200);
  assert.equal(
    await prisma.client.twoFactorAuth.findUnique({ where: { id: ordinaryDisable.factorId } }),
    null,
  );
  const ordinaryDisabledUser = await inspector.query<{ session_generation: number }>(
    'SELECT session_generation FROM "user" WHERE user_id = $1',
    [ordinaryDisable.userId],
  );
  assert.equal(ordinaryDisabledUser.rows[0].session_generation, 1);

  stage = 'racing fixture';
  const racing = await createFixture('racing');
  const nextPasswordHash = await hashPassword('synthetic-revoked-password-000000000000');
  let markLockHeld = () => {};
  const lockHeld = new Promise<void>(resolve => {
    markLockHeld = resolve;
  });
  const lockRelease = new Promise<void>(resolve => {
    releaseRevocation = resolve;
  });

  stage = 'held revocation';
  pendingRevocation = prisma.transaction(async transaction => {
    const updated = await transaction.user.updateMany({
      where: {
        id: racing.userId,
        password: racing.passwordHash,
        sessionGeneration: 0,
      },
      data: { password: nextPasswordHash, sessionGeneration: { increment: 1 } },
    });
    assert.equal(updated.count, 1);
    markLockHeld();
    await lockRelease;
  });
  await withTimeout(lockHeld, 3_000, 'Synthetic credential revocation did not lock the user row');

  let confirmationFinished = false;
  stage = 'racing confirmation';
  pendingConfirmation = confirmSetup(confirmRequest(racing));
  pendingConfirmation.then(
    () => {
      confirmationFinished = true;
    },
    () => {
      confirmationFinished = true;
    },
  );

  await waitForDatabaseLock(
    'Confirmation did not wait on the revocation lock',
    () => confirmationFinished,
  );

  stage = 'release revocation';
  releaseRevocation();
  stage = 'await revocation';
  await withTimeout(pendingRevocation, 3_000, 'Credential revocation did not finish');
  stage = 'await racing confirmation';
  const racingResponse = await withTimeout(
    pendingConfirmation,
    3_000,
    'Factor confirmation did not finish after revocation',
  );
  assert.equal(racingResponse.status, 401);
  stage = 'verify unchanged factor';
  const racingFactors = await inspector.query<{ is_enabled: boolean }>(
    'SELECT is_enabled FROM two_factor_auth WHERE id = $1',
    [racing.factorId],
  );
  assert.equal(racingFactors.rows.length, 1);
  assert.equal(racingFactors.rows[0].is_enabled, false);
  stage = 'verify absent backup codes';
  const backupCodes = await inspector.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM two_factor_backup_code WHERE user_id = $1',
    [racing.userId],
  );
  assert.equal(backupCodes.rows[0].count, 0);
  stage = 'verify absent OTP consumption';
  const usedCodes = await inspector.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM two_factor_otp_used WHERE user_id = $1',
    [racing.userId],
  );
  assert.equal(usedCodes.rows[0].count, 0);
  stage = 'verify revoked user';
  const revokedUsers = await inspector.query<{ password: string; session_generation: number }>(
    'SELECT password, session_generation FROM "user" WHERE user_id = $1',
    [racing.userId],
  );
  assert.equal(revokedUsers.rows.length, 1);
  assert.equal(revokedUsers.rows[0].password, nextPasswordHash);
  assert.equal(revokedUsers.rows[0].session_generation, 1);
  stage = 'verify stale session';
  assert.equal(
    await checkAuth(
      new Request('https://analytics.example.com/api/2fa/status', {
        headers: { authorization: `Bearer ${racing.sessionToken}` },
      }),
    ),
    null,
  );

  stage = 'stale initiation fixture';
  const staleInitiation = await createFixture('stale-initiation');
  const staleFactor = await inspector.query<{ secret: string }>(
    'SELECT secret FROM two_factor_auth WHERE id = $1',
    [staleInitiation.factorId],
  );
  const nextInitiationPasswordHash = await hashPassword(
    'synthetic-stale-initiation-password-0000000000',
  );
  let markInitiationLockHeld = () => {};
  const initiationLockHeld = new Promise<void>(resolve => {
    markInitiationLockHeld = resolve;
  });
  const initiationLockRelease = new Promise<void>(resolve => {
    releaseInitiationRevocation = resolve;
  });

  stage = 'held initiation revocation';
  pendingInitiationRevocation = prisma.transaction(async transaction => {
    const updated = await transaction.user.updateMany({
      where: {
        id: staleInitiation.userId,
        password: staleInitiation.passwordHash,
        sessionGeneration: 0,
      },
      data: { password: nextInitiationPasswordHash, sessionGeneration: { increment: 1 } },
    });
    assert.equal(updated.count, 1);
    markInitiationLockHeld();
    await initiationLockRelease;
  });
  await withTimeout(initiationLockHeld, 3_000, 'Initiation revocation did not lock the user');

  stage = 'racing stale initiation';
  pendingStaleInitiation = initiateSetup(
    new Request('https://analytics.example.com/api/2fa/setup/initiate', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${staleInitiation.sessionToken}`,
        'content-type': 'application/json',
        origin: 'https://analytics.example.com',
      },
      body: JSON.stringify({ password: staleInitiation.password }),
    }),
  );
  await waitForDatabaseLock('Stale initiation did not wait on password revocation');

  stage = 'release initiation revocation';
  releaseInitiationRevocation();
  await withTimeout(pendingInitiationRevocation, 3_000, 'Initiation revocation did not finish');
  const staleInitiationResponse = await withTimeout(
    pendingStaleInitiation,
    3_000,
    'Stale initiation did not finish after revocation',
  );
  assert.equal(staleInitiationResponse.status, 401);
  const retainedFactor = await inspector.query<{ secret: string; is_enabled: boolean }>(
    'SELECT secret, is_enabled FROM two_factor_auth WHERE id = $1',
    [staleInitiation.factorId],
  );
  assert.equal(retainedFactor.rows[0].secret, staleFactor.rows[0].secret);
  assert.equal(retainedFactor.rows[0].is_enabled, false);

  stage = 'rotated fixture';
  const rotating = await createFixture('rotating');
  const rotatedSecret = encryptSecret(generateSecret());
  let markRotationLockHeld = () => {};
  const rotationLockHeld = new Promise<void>(resolve => {
    markRotationLockHeld = resolve;
  });
  const rotationLockRelease = new Promise<void>(resolve => {
    releaseRotation = resolve;
  });

  stage = 'held factor rotation';
  pendingRotation = prisma.transaction(async transaction => {
    const updated = await transaction.twoFactorAuth.updateMany({
      where: { id: rotating.factorId, userId: rotating.userId, isEnabled: false },
      data: { secret: rotatedSecret },
    });
    assert.equal(updated.count, 1);
    markRotationLockHeld();
    await rotationLockRelease;
  });
  await withTimeout(rotationLockHeld, 3_000, 'Synthetic factor rotation did not lock the row');

  stage = 'rotating confirmation';
  pendingRotatedConfirmation = confirmSetup(confirmRequest(rotating));
  await waitForDatabaseLock('Confirmation did not wait on factor rotation');

  stage = 'release factor rotation';
  releaseRotation();
  await withTimeout(pendingRotation, 3_000, 'Factor rotation did not finish');
  const rotatedResponse = await withTimeout(
    pendingRotatedConfirmation,
    3_000,
    'Factor confirmation did not finish after rotation',
  );
  assert.equal(rotatedResponse.status, 409);
  stage = 'verify rotated factor remains pending';
  const rotatedFactors = await inspector.query<{ secret: string; is_enabled: boolean }>(
    'SELECT secret, is_enabled FROM two_factor_auth WHERE id = $1',
    [rotating.factorId],
  );
  assert.equal(rotatedFactors.rows.length, 1);
  assert.equal(rotatedFactors.rows[0].secret, rotatedSecret);
  assert.equal(rotatedFactors.rows[0].is_enabled, false);
  const rotatedUsers = await inspector.query<{ session_generation: number }>(
    'SELECT session_generation FROM "user" WHERE user_id = $1',
    [rotating.userId],
  );
  assert.equal(rotatedUsers.rows[0].session_generation, 0);

  stage = 'activation fixture';
  const activating = await createFixture('activating');
  const pendingFactor = await inspector.query<{ secret: string }>(
    'SELECT secret FROM two_factor_auth WHERE id = $1',
    [activating.factorId],
  );
  let markActivationLockHeld = () => {};
  const activationLockHeld = new Promise<void>(resolve => {
    markActivationLockHeld = resolve;
  });
  const activationLockRelease = new Promise<void>(resolve => {
    releaseActivation = resolve;
  });

  stage = 'held factor activation';
  pendingActivation = prisma.transaction(async transaction => {
    const updated = await transaction.twoFactorAuth.updateMany({
      where: { id: activating.factorId, userId: activating.userId, isEnabled: false },
      data: { isEnabled: true },
    });
    assert.equal(updated.count, 1);
    markActivationLockHeld();
    await activationLockRelease;
  });
  await withTimeout(activationLockHeld, 3_000, 'Synthetic factor activation did not lock the row');

  stage = 'racing setup initiation';
  pendingInitiation = initiateSetup(
    new Request('https://analytics.example.com/api/2fa/setup/initiate', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${activating.sessionToken}`,
        'content-type': 'application/json',
        origin: 'https://analytics.example.com',
      },
      body: JSON.stringify({ password: activating.password }),
    }),
  );
  await waitForDatabaseLock('Setup initiation did not wait on factor');

  stage = 'release factor activation';
  releaseActivation();
  await withTimeout(pendingActivation, 3_000, 'Factor activation did not finish');
  const initiatedResponse = await withTimeout(
    pendingInitiation,
    3_000,
    'Setup initiation did not finish after activation',
  );
  assert.equal(initiatedResponse.status, 409);
  stage = 'verify enabled factor unchanged';
  const activatedFactor = await inspector.query<{ secret: string; is_enabled: boolean }>(
    'SELECT secret, is_enabled FROM two_factor_auth WHERE id = $1',
    [activating.factorId],
  );
  assert.equal(activatedFactor.rows.length, 1);
  assert.equal(activatedFactor.rows[0].secret, pendingFactor.rows[0].secret);
  assert.equal(activatedFactor.rows[0].is_enabled, true);

  stage = 'disable fixture';
  const disabling = await createFixture('disabling', true);
  const nextDisablePasswordHash = await hashPassword('synthetic-disabled-race-password-0000000000');
  let markDisableLockHeld = () => {};
  const disableLockHeld = new Promise<void>(resolve => {
    markDisableLockHeld = resolve;
  });
  const disableLockRelease = new Promise<void>(resolve => {
    releaseDisableRevocation = resolve;
  });

  stage = 'held disable revocation';
  pendingDisableRevocation = prisma.transaction(async transaction => {
    const updated = await transaction.user.updateMany({
      where: { id: disabling.userId, password: disabling.passwordHash, sessionGeneration: 0 },
      data: { password: nextDisablePasswordHash, sessionGeneration: { increment: 1 } },
    });
    assert.equal(updated.count, 1);
    markDisableLockHeld();
    await disableLockRelease;
  });
  await withTimeout(disableLockHeld, 3_000, 'Synthetic disable revocation did not lock the user');

  stage = 'racing factor disable';
  pendingDisable = disableFactor(disableRequest(disabling));
  await waitForDatabaseLock('Factor disable did not wait on revocation');

  stage = 'release disable revocation';
  releaseDisableRevocation();
  await withTimeout(pendingDisableRevocation, 3_000, 'Disable revocation did not finish');
  const disableResponse = await withTimeout(
    pendingDisable,
    3_000,
    'Factor disable did not finish after revocation',
  );
  assert.equal(disableResponse.status, 401);
  stage = 'verify revoked factor remains enabled';
  const disabledFactor = await inspector.query<{ is_enabled: boolean }>(
    'SELECT is_enabled FROM two_factor_auth WHERE id = $1',
    [disabling.factorId],
  );
  assert.equal(disabledFactor.rows.length, 1);
  assert.equal(disabledFactor.rows[0].is_enabled, true);

  stage = 'cancel fixture';
  const cancelling = await createFixture('cancelling');
  let markCancellationLockHeld = () => {};
  const cancellationLockHeld = new Promise<void>(resolve => {
    markCancellationLockHeld = resolve;
  });
  const cancellationLockRelease = new Promise<void>(resolve => {
    releaseCancellationActivation = resolve;
  });

  stage = 'held cancellation activation';
  pendingCancellationActivation = prisma.transaction(async transaction => {
    const updated = await transaction.twoFactorAuth.updateMany({
      where: { id: cancelling.factorId, userId: cancelling.userId, isEnabled: false },
      data: { isEnabled: true },
    });
    assert.equal(updated.count, 1);
    markCancellationLockHeld();
    await cancellationLockRelease;
  });
  await withTimeout(
    cancellationLockHeld,
    3_000,
    'Synthetic cancellation activation did not lock the factor',
  );

  stage = 'racing setup cancellation';
  pendingCancellation = cancelSetup(
    new Request('https://analytics.example.com/api/2fa/setup/cancel', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cancelling.sessionToken}`,
        'content-type': 'application/json',
        origin: 'https://analytics.example.com',
      },
      body: '{}',
    }),
  );
  await waitForDatabaseLock('Setup cancellation did not wait on activation');

  stage = 'release cancellation activation';
  releaseCancellationActivation();
  await withTimeout(pendingCancellationActivation, 3_000, 'Cancellation activation did not finish');
  const cancellationResponse = await withTimeout(
    pendingCancellation,
    3_000,
    'Setup cancellation did not finish after activation',
  );
  assert.equal(cancellationResponse.status, 200);
  stage = 'verify enabled factor survives cancellation';
  const cancelledFactor = await inspector.query<{ is_enabled: boolean }>(
    'SELECT is_enabled FROM two_factor_auth WHERE id = $1',
    [cancelling.factorId],
  );
  assert.equal(cancelledFactor.rows.length, 1);
  assert.equal(cancelledFactor.rows[0].is_enabled, true);

  stage = 'credential-write fixture';
  const credentialWrite = await createFixture('credential-write');
  const nextCredentialHash = await hashPassword('synthetic-stale-credential-write-0000000000');
  let markCredentialEpochHeld = () => {};
  const credentialEpochHeld = new Promise<void>(resolve => {
    markCredentialEpochHeld = resolve;
  });
  const credentialEpochRelease = new Promise<void>(resolve => {
    releaseCredentialEpoch = resolve;
  });

  stage = 'held credential-epoch change';
  pendingCredentialEpoch = prisma.transaction(async transaction => {
    const updated = await transaction.user.updateMany({
      where: { id: credentialWrite.userId, sessionGeneration: 0 },
      data: { sessionGeneration: { increment: 1 } },
    });
    assert.equal(updated.count, 1);
    markCredentialEpochHeld();
    await credentialEpochRelease;
  });
  await withTimeout(credentialEpochHeld, 3_000, 'Credential-epoch change did not lock the user');

  stage = 'racing password replacement';
  pendingPasswordReplacement = replacePasswordIfCurrent(
    credentialWrite.userId,
    credentialWrite.passwordHash,
    nextCredentialHash,
    0,
  ).then(
    () => 'accepted',
    error => (error instanceof Error ? error.message : 'unknown-error'),
  );
  await waitForDatabaseLock('Password replacement did not wait on the credential-epoch change');

  stage = 'release credential-epoch change';
  releaseCredentialEpoch();
  await withTimeout(pendingCredentialEpoch, 3_000, 'Credential-epoch change did not finish');
  const passwordReplacementResult = await withTimeout(
    pendingPasswordReplacement,
    3_000,
    'Password replacement did not finish after epoch change',
  );
  assert.equal(passwordReplacementResult, 'USER_CREDENTIALS_CHANGED');
  const credentialWriteUser = await inspector.query<{
    password: string;
    session_generation: number;
  }>('SELECT password, session_generation FROM "user" WHERE user_id = $1', [
    credentialWrite.userId,
  ]);
  assert.equal(credentialWriteUser.rows[0].password, credentialWrite.passwordHash);
  assert.equal(credentialWriteUser.rows[0].session_generation, 1);

  console.log('PostgreSQL security state rejects concurrent credential and factor changes.');
} catch (error) {
  console.error(`Synthetic factor enrollment race failed during ${stage}.`);
  console.error(`Caught ${error instanceof Error ? error.name : typeof error}.`);
  throw error;
} finally {
  releaseRevocation();
  releaseRotation();
  releaseActivation();
  releaseDisableRevocation();
  releaseCancellationActivation();
  releaseCredentialEpoch();
  releaseInitiationRevocation();
  if (pendingRevocation) {
    await Promise.allSettled([pendingRevocation]);
  }
  if (pendingConfirmation) {
    await Promise.allSettled([pendingConfirmation]);
  }
  if (pendingRotation) {
    await Promise.allSettled([pendingRotation]);
  }
  if (pendingRotatedConfirmation) {
    await Promise.allSettled([pendingRotatedConfirmation]);
  }
  if (pendingActivation) {
    await Promise.allSettled([pendingActivation]);
  }
  if (pendingInitiation) {
    await Promise.allSettled([pendingInitiation]);
  }
  if (pendingDisableRevocation) {
    await Promise.allSettled([pendingDisableRevocation]);
  }
  if (pendingDisable) {
    await Promise.allSettled([pendingDisable]);
  }
  if (pendingCancellationActivation) {
    await Promise.allSettled([pendingCancellationActivation]);
  }
  if (pendingCancellation) {
    await Promise.allSettled([pendingCancellation]);
  }
  if (pendingCredentialEpoch) {
    await Promise.allSettled([pendingCredentialEpoch]);
  }
  if (pendingPasswordReplacement) {
    await Promise.allSettled([pendingPasswordReplacement]);
  }
  if (pendingInitiationRevocation) {
    await Promise.allSettled([pendingInitiationRevocation]);
  }
  if (pendingStaleInitiation) {
    await Promise.allSettled([pendingStaleInitiation]);
  }
  if (inspectorConnected) {
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
  }
  await prisma.client.$disconnect();
}
