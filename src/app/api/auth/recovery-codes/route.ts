import { ROLES } from '@/lib/constants';
import { isEnvEnabled } from '@/lib/env';
import {
  generateLoginRecoveryCodes,
  getLoginRecoveryKeyFingerprint,
  persistLoginRecoveryCodes,
  RecoveryTargetNotFoundError,
} from '@/lib/login-recovery';
import { checkPassword } from '@/lib/password';
import { reservePasswordVerificationAttempt } from '@/lib/password-verification-rate-limit';
import prisma from '@/lib/prisma';
import { parseRequest } from '@/lib/request';
import {
  badRequest,
  forbidden,
  json,
  notFound,
  serviceUnavailable,
  tooManyRequests,
  unauthorized,
} from '@/lib/response';
import {
  assertActorIsAdministrator,
  assertCurrentActorAuth,
  runActiveSessionMutation,
  SessionRevokedError,
} from '@/queries/prisma/authorization';
import { getUser } from '@/queries/prisma/user';
import { rotateLoginRecoveryCodesSchema } from './schema';

export async function GET(request: Request) {
  if (isEnvEnabled('CLOUD_MODE')) {
    return notFound();
  }

  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  if (
    auth.authType !== 'session' ||
    !auth.user?.id ||
    auth.enrollmentOnly ||
    !auth.passwordFingerprint
  ) {
    return unauthorized();
  }

  const count = await prisma.client.loginRecoveryCredential.count({
    where: {
      userId: auth.user.id,
      passwordFingerprint: auth.passwordFingerprint,
      keyFingerprint: getLoginRecoveryKeyFingerprint(),
      consumedAt: null,
    },
  });

  return json({ remaining: count }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  if (isEnvEnabled('CLOUD_MODE')) {
    return notFound();
  }

  if (isEnvEnabled('DISABLE_LOGIN')) {
    return forbidden({ code: 'login-disabled' });
  }

  const { auth, body, error } = await parseRequest(request, rotateLoginRecoveryCodesSchema, {
    maxBodyBytes: 16 * 1024,
  });

  if (error) {
    return error();
  }

  if (
    auth.authType !== 'session' ||
    !auth.user?.id ||
    auth.enrollmentOnly ||
    !auth.passwordFingerprint
  ) {
    return unauthorized();
  }

  const userId = auth.user.id;
  const targetUserId = body.userId ?? userId;
  if (targetUserId !== userId && auth.user.role !== ROLES.admin) {
    return forbidden();
  }

  const user = await getUser(userId, { includePassword: true });

  if (!user) {
    return unauthorized();
  }

  let attempt;
  try {
    attempt = await reservePasswordVerificationAttempt(userId);
  } catch {
    return serviceUnavailable({ message: 'Credential verification is temporarily unavailable' });
  }

  if (!attempt.allowed) {
    return tooManyRequests(attempt.retryAfter, { message: 'Too many password attempts' });
  }

  if (!(await checkPassword(body.password, user.password))) {
    return badRequest({ code: 'incorrect-username-password', message: 'Incorrect password' });
  }

  const credentials = generateLoginRecoveryCodes();

  try {
    await runActiveSessionMutation(auth, async transaction => {
      await assertCurrentActorAuth(transaction, userId, auth);
      if (targetUserId !== userId) {
        await assertActorIsAdministrator(transaction, userId);
      }

      await persistLoginRecoveryCodes(transaction, targetUserId, credentials);
    });
  } catch (error) {
    if (error instanceof RecoveryTargetNotFoundError) {
      return notFound();
    }

    if (
      error instanceof SessionRevokedError ||
      (error instanceof Error &&
        ['ENTITY_ACTOR_NOT_AUTHORIZED', 'ENTITY_ADMIN_REQUIRED'].includes(error.message))
    ) {
      return unauthorized();
    }

    throw error;
  }

  return json(
    { recoveryCodes: credentials.map(({ code }) => code) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
