import { saveAuth } from '@/lib/auth';
import { hash, secret } from '@/lib/crypto';
import { isEnvEnabled } from '@/lib/env';
import { createSecureToken } from '@/lib/jwt';
import { clearFailedLogins } from '@/lib/login-rate-limit';
import { checkPassword } from '@/lib/password';
import {
  getPasswordVerificationBudgetKey,
  reservePasswordVerificationAttempt,
} from '@/lib/password-verification-rate-limit';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';
import { parseRequest } from '@/lib/request';
import {
  badRequest,
  conflict,
  forbidden,
  json,
  notFound,
  serviceUnavailable,
  tooManyRequests,
  unauthorized,
} from '@/lib/response';
import { getAuthSessionTtlSeconds } from '@/lib/security';
import { setSessionCookie } from '@/lib/session';
import { generateBackupCodes } from '@/lib/two-factor/backup-codes';
import {
  decryptSecret,
  getTwoFactorConfigurationError,
  isTwoFactorConfigured,
} from '@/lib/two-factor/crypto';
import { reserveTwoFactorAttempt, resetRateLimit } from '@/lib/two-factor/rate-limit';
import { consumeOtp } from '@/lib/two-factor/replay-prevention';
import { verifyTotp } from '@/lib/two-factor/totp';
import { getUser } from '@/queries/prisma/user';
import { confirmTwoFactorSetupSchema } from './schema';

class SetupChangedError extends Error {}

class CodeAlreadyUsedError extends Error {}

class CredentialsChangedError extends Error {}

export async function POST(request: Request) {
  if (isEnvEnabled('CLOUD_MODE')) {
    return notFound();
  }

  const { auth, body, error } = await parseRequest(request, confirmTwoFactorSetupSchema, {
    maxBodyBytes: 16 * 1024,
  });

  if (error) {
    return error();
  }

  if (auth.authType !== 'session' || !auth.user?.id) {
    return unauthorized();
  }

  if (auth.enrollmentOnly && isEnvEnabled('DISABLE_LOGIN')) {
    return forbidden({ code: 'login-disabled' });
  }

  if (!isTwoFactorConfigured()) {
    return serviceUnavailable(getTwoFactorConfigurationError());
  }

  const userId = auth.user.id;
  const { token, password } = body;

  const userWithPassword = await getUser(userId, { includePassword: true });
  if (!userWithPassword) {
    return unauthorized();
  }

  const twoFactor = await prisma.client.twoFactorAuth.findUnique({ where: { userId } });

  if (!twoFactor || twoFactor.isEnabled) {
    return badRequest({
      code: 'two-factor-error-no-pending-setup',
      message: 'No pending 2FA setup found',
    });
  }

  let passwordAttempt;
  try {
    passwordAttempt = await reservePasswordVerificationAttempt(userId);
  } catch {
    return serviceUnavailable({ message: 'Credential verification is temporarily unavailable' });
  }

  if (!passwordAttempt.allowed) {
    return tooManyRequests(passwordAttempt.retryAfter, {
      message: 'Too many password attempts',
    });
  }

  if (!(await checkPassword(password, userWithPassword.password))) {
    return badRequest({
      code: 'two-factor-error-incorrect-password',
      message: 'Incorrect password',
    });
  }

  // Verify rate limit
  const attempt = await reserveTwoFactorAttempt(userId);
  if (!attempt.allowed) {
    return Response.json(
      {
        error: {
          code: 'two-factor-error-too-many-attempts',
          message: 'Too many failed attempts',
          lockedUntil: attempt.lockedUntil,
        },
      },
      { status: 429 },
    );
  }

  // Verify TOTP
  const totpSecret = decryptSecret(twoFactor.secret);
  if (!(await verifyTotp(token, totpSecret))) {
    return badRequest({
      code: 'two-factor-error-invalid-code',
      message: 'Invalid verification code',
      ...(attempt.lockedUntil && { lockedUntil: attempt.lockedUntil }),
    });
  }

  const { plaintext, hashed } = await generateBackupCodes();

  try {
    await prisma.transaction(async tx => {
      const updatedUsers = await tx.$queryRaw<Array<{ sessionGeneration: number }>>`
        UPDATE "user"
        SET "session_generation" = "session_generation" + 1,
            "updated_at" = CURRENT_TIMESTAMP
        WHERE "user_id" = ${userId}::uuid
          AND "password" = ${userWithPassword.password}
          AND "deleted_at" IS NULL
          AND "session_generation" = ${auth.sessionGeneration}
        RETURNING "session_generation" AS "sessionGeneration"
      `;

      if (
        updatedUsers.length !== 1 ||
        updatedUsers[0].sessionGeneration !== auth.sessionGeneration + 1
      ) {
        throw new CredentialsChangedError();
      }

      const updatedFactors = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE "two_factor_auth"
        SET "is_enabled" = true,
            "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${twoFactor.id}
          AND "user_id" = ${userId}::uuid
          AND "secret" = ${twoFactor.secret}
          AND "is_enabled" = false
        RETURNING "id"
      `;

      if (updatedFactors.length !== 1) {
        throw new SetupChangedError();
      }

      if (!(await consumeOtp(userId, token, tx))) {
        throw new CodeAlreadyUsedError();
      }

      await tx.twoFactorBackupCode.deleteMany({ where: { userId } });
      await tx.twoFactorBackupCode.createMany({
        data: hashed.map(codeHash => ({ userId, codeHash })),
      });
      await tx.apiKey.deleteMany({ where: { userId } });
      await tx.appSetting.deleteMany({ where: { key: getPasswordVerificationBudgetKey(userId) } });
    });
  } catch (error) {
    if (error instanceof CredentialsChangedError) {
      return unauthorized({ code: 'credentials-changed' });
    }

    if (error instanceof SetupChangedError) {
      return conflict({
        code: 'two-factor-error-setup-changed',
        message: '2FA setup changed; start again',
      });
    }

    if (error instanceof CodeAlreadyUsedError) {
      return badRequest({ code: 'two-factor-error-code-used', message: 'Code already used' });
    }

    throw error;
  }

  await resetRateLimit(userId);

  const user = await getUser(userId, {
    includePassword: true,
    includeSessionGeneration: true,
  });

  if (
    !user ||
    user.sessionGeneration !== auth.sessionGeneration + 1 ||
    user.role !== auth.user.role
  ) {
    return unauthorized();
  }

  const sessionTtl = getAuthSessionTtlSeconds();
  const sessionData = {
    userId,
    role: user.role,
    pwd: hash(user.password),
    sessionGeneration: user.sessionGeneration,
    mfa: true,
    mfaId: twoFactor.id,
  };
  const sessionToken = redis.enabled
    ? await saveAuth(sessionData, sessionTtl)
    : await createSecureToken(sessionData, secret(), { expiresIn: sessionTtl });
  await clearFailedLogins(request, user.username);

  return setSessionCookie(json({ backupCodes: plaintext }), sessionToken, sessionTtl);
}
