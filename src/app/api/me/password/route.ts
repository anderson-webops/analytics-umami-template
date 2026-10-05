import { z } from 'zod';
import { saveAuth } from '@/lib/auth';
import { hash, secret } from '@/lib/crypto';
import { createSecureToken } from '@/lib/jwt';
import { checkPassword, hashPassword } from '@/lib/password';
import { reservePasswordVerificationAttempt } from '@/lib/password-verification-rate-limit';
import redis from '@/lib/redis';
import { parseRequest } from '@/lib/request';
import {
  badRequest,
  json,
  serviceUnavailable,
  tooManyRequests,
  unauthorized,
} from '@/lib/response';
import { loginPasswordParam, passwordParam } from '@/lib/schema';
import { getAuthSessionTtlSeconds } from '@/lib/security';
import { setSessionCookie } from '@/lib/session';
import { getUser, replacePasswordIfCurrent } from '@/queries/prisma/user';

export async function POST(request: Request) {
  const schema = z.object({
    currentPassword: loginPasswordParam,
    newPassword: passwordParam,
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const userId = auth.user.id;
  const { currentPassword, newPassword } = body;

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

  if (!(await checkPassword(currentPassword, user.password))) {
    return badRequest({ message: 'Current password is incorrect' });
  }

  if (await checkPassword(newPassword, user.password)) {
    return badRequest({ message: 'New password must differ from the current password' });
  }

  const password = await hashPassword(newPassword);
  let updated;

  try {
    updated = await replacePasswordIfCurrent(
      userId,
      user.password,
      password,
      auth.sessionGeneration,
    );
  } catch (error: any) {
    if (error?.message === 'USER_CREDENTIALS_CHANGED') {
      return unauthorized({
        message:
          'Your credentials changed while this request was in progress. Please sign in again.',
      });
    }

    throw error;
  }

  if (!updated) {
    return unauthorized();
  }

  const sessionTtl = getAuthSessionTtlSeconds();
  const passwordFingerprint = hash(password);
  const sessionData = {
    userId,
    role: updated.role,
    pwd: passwordFingerprint,
    sessionGeneration: updated.sessionGeneration,
    mfa: auth.mfaVerified === true,
    ...(auth.mfaVerified ? { mfaId: auth.mfaId } : {}),
  };
  let token: string;

  if (redis.enabled) {
    if (auth.authKey) {
      await redis.client.del(auth.authKey);
    }

    token = await saveAuth(sessionData, sessionTtl);
  } else {
    token = await createSecureToken(sessionData, secret(), {
      expiresIn: sessionTtl,
    });
  }

  const { sessionGeneration, ...publicUser } = updated;

  return setSessionCookie(json({ ...publicUser, token }), token, sessionTtl);
}
