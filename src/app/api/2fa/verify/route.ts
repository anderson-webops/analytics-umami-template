import { z } from 'zod';
import { saveAuth } from '@/lib/auth';
import { PARTIAL_AUTH_TOKEN_TYPE, ROLES } from '@/lib/constants';
import { hash, secret } from '@/lib/crypto';
import { isEnvEnabled } from '@/lib/env';
import { createSecureToken, parseSecureToken } from '@/lib/jwt';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';
import { parseRequest } from '@/lib/request';
import {
  badRequest,
  forbidden,
  json,
  notFound,
  serviceUnavailable,
  unauthorized,
} from '@/lib/response';
import { getAuthSessionTtlSeconds } from '@/lib/security';
import { getBearerToken, setSessionCookie } from '@/lib/session';
import { hasCurrentSessionGeneration } from '@/lib/session-generation';
import { verifyBackupCode } from '@/lib/two-factor/backup-codes';
import {
  decryptSecret,
  getTwoFactorConfigurationError,
  isTwoFactorConfigured,
} from '@/lib/two-factor/crypto';
import { reserveTwoFactorAttempt, resetRateLimit } from '@/lib/two-factor/rate-limit';
import { consumeOtp } from '@/lib/two-factor/replay-prevention';
import { verifyTotp } from '@/lib/two-factor/totp';
import { getAllUserTeams, getUser } from '@/queries/prisma';

export async function POST(request: Request) {
  if (isEnvEnabled('CLOUD_MODE')) {
    return notFound();
  }

  if (isEnvEnabled('DISABLE_LOGIN')) {
    return forbidden({ code: 'login-disabled' });
  }

  const schema = z.union([
    z.object({ token: z.string().length(6) }).strict(),
    z.object({ backupCode: z.string().min(1) }).strict(),
  ]);

  const rawToken = getBearerToken(request);
  if (!rawToken) {
    return unauthorized({ code: 'two-factor-error-missing-token' });
  }

  const payload = (await parseSecureToken(rawToken, secret())) as any;
  if (
    payload?.type !== PARTIAL_AUTH_TOKEN_TYPE ||
    !payload.userId ||
    typeof payload.pwd !== 'string'
  ) {
    return unauthorized({ code: 'two-factor-error-invalid-partial-token' });
  }

  if (!isTwoFactorConfigured()) {
    return serviceUnavailable(getTwoFactorConfigurationError());
  }

  const { body, error } = await parseRequest(request, schema, {
    skipAuth: true,
    maxBodyBytes: 16 * 1024,
  });
  if (error) {
    return error();
  }

  const userId = payload.userId as string;
  const user = await getUser(userId, {
    includePassword: true,
    includeSessionGeneration: true,
  });

  if (
    !user ||
    hash(user.password) !== payload.pwd ||
    !hasCurrentSessionGeneration(payload.sessionGeneration, user.sessionGeneration)
  ) {
    return unauthorized({ code: 'credentials-changed' });
  }

  const twoFactor = await prisma.client.twoFactorAuth.findUnique({ where: { userId } });

  if (!twoFactor?.isEnabled) {
    return badRequest({
      code: 'two-factor-error-not-enabled',
      message: '2FA not enabled for this user',
    });
  }

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

  if (body.backupCode) {
    const unusedCodes = await prisma.client.twoFactorBackupCode.findMany({
      where: { userId, used: false },
    });
    const hashes = unusedCodes.map(c => c.codeHash);
    const matchIndex = await verifyBackupCode(body.backupCode, hashes);

    if (matchIndex === null) {
      return badRequest({
        code: 'two-factor-error-invalid-backup-code',
        message: 'Invalid backup code',
        ...(attempt.lockedUntil && { lockedUntil: attempt.lockedUntil }),
      });
    }

    const consumed = await prisma.client.twoFactorBackupCode.updateMany({
      where: { id: unusedCodes[matchIndex].id, used: false },
      data: { used: true },
    });

    if (consumed.count === 0) {
      return badRequest({
        code: 'two-factor-error-invalid-backup-code',
        message: 'Invalid backup code',
        ...(attempt.lockedUntil && { lockedUntil: attempt.lockedUntil }),
      });
    }

    await resetRateLimit(userId);
  } else {
    const { token } = body;

    const decryptedSecret = decryptSecret(twoFactor.secret);

    if (!(await verifyTotp(token, decryptedSecret))) {
      return badRequest({
        code: 'two-factor-error-invalid-code',
        message: 'Invalid verification code',
        ...(attempt.lockedUntil && { lockedUntil: attempt.lockedUntil }),
      });
    }

    if (!(await consumeOtp(userId, token))) {
      return badRequest({ code: 'two-factor-error-code-used', message: 'Code already used' });
    }

    await resetRateLimit(userId);
  }

  const { id, role, createdAt, username } = user;

  const passwordFingerprint = hash(user.password);
  const sessionTtl = getAuthSessionTtlSeconds();
  let fullToken: string;
  if (redis.enabled) {
    fullToken = await saveAuth(
      {
        userId: id,
        role,
        pwd: passwordFingerprint,
        sessionGeneration: user.sessionGeneration,
        mfa: true,
        mfaId: twoFactor.id,
      },
      sessionTtl,
    );
  } else {
    fullToken = await createSecureToken(
      {
        userId: id,
        role,
        pwd: passwordFingerprint,
        sessionGeneration: user.sessionGeneration,
        mfa: true,
        mfaId: twoFactor.id,
      },
      secret(),
      { expiresIn: sessionTtl },
    );
  }

  const teams = await getAllUserTeams(id);

  return setSessionCookie(
    json({
      token: fullToken,
      user: { id, username, role, createdAt, isAdmin: role === ROLES.admin, teams },
    }),
    fullToken,
    sessionTtl,
  );
}
