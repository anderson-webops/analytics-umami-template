import { z } from 'zod';
import { saveAuth } from '@/lib/auth';
import { secret as authSecret, hash } from '@/lib/crypto';
import { isEnvEnabled } from '@/lib/env';
import { createSecureToken } from '@/lib/jwt';
import { checkPassword } from '@/lib/password';
import { reservePasswordVerificationAttempt } from '@/lib/password-verification-rate-limit';
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
import { clearSessionCookies, setSessionCookie } from '@/lib/session';
import {
  decryptSecret,
  getTwoFactorConfigurationError,
  isTwoFactorConfigured,
} from '@/lib/two-factor/crypto';
import { reserveTwoFactorAttempt } from '@/lib/two-factor/rate-limit';
import { consumeOtp } from '@/lib/two-factor/replay-prevention';
import { getTwoFactorRequirement } from '@/lib/two-factor/requirement';
import { verifyTotp } from '@/lib/two-factor/totp';
import { getUser } from '@/queries/prisma/user';

class CredentialsChangedError extends Error {}
class FactorChangedError extends Error {}
class CodeAlreadyUsedError extends Error {}

export async function POST(request: Request) {
  if (isEnvEnabled('CLOUD_MODE')) {
    return notFound();
  }

  const schema = z.object({
    password: z.string(),
    token: z.string().length(6),
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  if (!isTwoFactorConfigured()) {
    return serviceUnavailable(getTwoFactorConfigurationError());
  }

  const userId = auth.user.id;
  const { password, token } = body;

  const requirement = await getTwoFactorRequirement(userId);

  if (requirement.reason !== null) {
    return forbidden({
      code: 'two-factor-error-disable-not-allowed',
      message: '2FA is required and cannot be disabled',
    });
  }

  const userWithPw = await getUser(userId, { includePassword: true });
  if (!userWithPw) {
    return badRequest({
      code: 'two-factor-error-incorrect-password',
      message: 'Incorrect password',
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

  // Verify password
  if (!(await checkPassword(password, userWithPw.password))) {
    return badRequest({
      code: 'two-factor-error-incorrect-password',
      message: 'Incorrect password',
    });
  }

  // Verify if 2FA is enabled
  const twoFactor = await prisma.client.twoFactorAuth.findUnique({ where: { userId } });
  if (!twoFactor?.isEnabled) {
    return badRequest({ code: 'two-factor-error-not-enabled', message: '2FA is not enabled' });
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
  const secret = decryptSecret(twoFactor.secret);
  if (!(await verifyTotp(token, secret))) {
    return badRequest({
      code: 'two-factor-error-invalid-code',
      message: 'Invalid verification code',
      ...(attempt.lockedUntil && { lockedUntil: attempt.lockedUntil }),
    });
  }

  let updatedUser;

  try {
    updatedUser = await prisma.transaction(async tx => {
      const updated = await tx.user.updateMany({
        where: { id: userId, password: userWithPw.password, deletedAt: null },
        data: { sessionGeneration: { increment: 1 } },
      });

      if (updated.count !== 1) {
        throw new CredentialsChangedError();
      }

      if (!(await consumeOtp(userId, token, tx))) {
        throw new CodeAlreadyUsedError();
      }

      const removed = await tx.twoFactorAuth.deleteMany({
        where: { id: twoFactor.id, userId, isEnabled: true },
      });

      if (removed.count !== 1) {
        throw new FactorChangedError();
      }

      await tx.twoFactorBackupCode.deleteMany({ where: { userId } });
      await tx.twoFactorRateLimit.deleteMany({ where: { userId } });

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { role: true, password: true, sessionGeneration: true },
      });

      if (!user) {
        throw new CredentialsChangedError();
      }

      return user;
    });
  } catch (error) {
    if (error instanceof CodeAlreadyUsedError) {
      return badRequest({ code: 'two-factor-error-code-used', message: 'Code already used' });
    }

    if (error instanceof FactorChangedError) {
      return conflict({ message: '2FA enrollment changed; try again' });
    }

    if (error instanceof CredentialsChangedError) {
      return unauthorized({ message: 'Your credentials changed. Please sign in again.' });
    }

    throw error;
  }

  const sessionTtl = getAuthSessionTtlSeconds();
  const sessionData = {
    userId,
    role: updatedUser.role,
    pwd: hash(updatedUser.password),
    sessionGeneration: updatedUser.sessionGeneration,
  };
  let sessionToken: string;

  try {
    sessionToken = redis.enabled
      ? await saveAuth(sessionData, sessionTtl)
      : await createSecureToken(sessionData, authSecret(), { expiresIn: sessionTtl });
  } catch {
    return clearSessionCookies(
      serviceUnavailable({ message: '2FA was disabled. Please sign in again.' }),
    );
  }

  return setSessionCookie(json({ ok: true, token: sessionToken }), sessionToken, sessionTtl);
}
