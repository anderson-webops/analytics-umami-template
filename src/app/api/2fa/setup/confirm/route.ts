import { z } from 'zod';
import { saveAuth } from '@/lib/auth';
import { hash, secret } from '@/lib/crypto';
import { isEnvEnabled } from '@/lib/env';
import { createSecureToken } from '@/lib/jwt';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';
import { parseRequest } from '@/lib/request';
import {
  badRequest,
  conflict,
  json,
  notFound,
  serviceUnavailable,
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

class SetupChangedError extends Error {}

class CodeAlreadyUsedError extends Error {}

export async function POST(request: Request) {
  if (isEnvEnabled('CLOUD_MODE')) {
    return notFound();
  }

  const schema = z.object({ token: z.string().length(6) });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  if (!isTwoFactorConfigured()) {
    return serviceUnavailable(getTwoFactorConfigurationError());
  }

  const userId = auth.user.id;
  const { token } = body;

  const twoFactor = await prisma.client.twoFactorAuth.findUnique({ where: { userId } });

  // Verify if 2FA is waiting for setup
  if (!twoFactor || twoFactor.isEnabled) {
    return badRequest({
      code: 'two-factor-error-no-pending-setup',
      message: 'No pending 2FA setup found',
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
      const updated = await tx.twoFactorAuth.updateMany({
        where: { id: twoFactor.id, userId, secret: twoFactor.secret, isEnabled: false },
        data: { isEnabled: true },
      });

      if (updated.count !== 1) {
        throw new SetupChangedError();
      }

      if (!(await consumeOtp(userId, token, tx))) {
        throw new CodeAlreadyUsedError();
      }

      await tx.twoFactorBackupCode.deleteMany({ where: { userId } });
      await tx.twoFactorBackupCode.createMany({
        data: hashed.map(codeHash => ({ userId, codeHash })),
      });
    });
  } catch (error) {
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

  if (!user || user.sessionGeneration !== auth.sessionGeneration) {
    return unauthorized();
  }

  const sessionTtl = getAuthSessionTtlSeconds();
  const sessionData = {
    userId,
    role: user.role,
    pwd: hash(user.password),
    sessionGeneration: auth.sessionGeneration,
    mfa: true,
    mfaId: twoFactor.id,
  };
  const sessionToken = redis.enabled
    ? await saveAuth(sessionData, sessionTtl)
    : await createSecureToken(sessionData, secret(), { expiresIn: sessionTtl });

  return setSessionCookie(json({ backupCodes: plaintext }), sessionToken, sessionTtl);
}
