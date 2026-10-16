import { z } from 'zod';
import { generateApiKey, getApiKeyPrefix, hashApiKey, isApiKeyEnabled } from '@/lib/api-key';
import { uuid } from '@/lib/crypto';
import { checkPassword } from '@/lib/password';
import { reservePasswordVerificationAttempt } from '@/lib/password-verification-rate-limit';
import prisma from '@/lib/prisma';
import { parseRequest } from '@/lib/request';
import {
  badRequest,
  conflict,
  json,
  notFound,
  serviceUnavailable,
  tooManyRequests,
  unauthorized,
} from '@/lib/response';
import {
  decryptSecret,
  getTwoFactorConfigurationError,
  isTwoFactorConfigured,
} from '@/lib/two-factor/crypto';
import { reserveTwoFactorAttempt } from '@/lib/two-factor/rate-limit';
import { verifyTotp } from '@/lib/two-factor/totp';
import {
  ApiKeyCodeUsedError,
  ApiKeyLimitReachedError,
  createApiKey,
  getUserApiKeys,
} from '@/queries/prisma/apiKey';
import { getUser } from '@/queries/prisma/user';
import { createApiKeySchema } from './schema';

export async function GET(request: Request) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  if (!isApiKeyEnabled()) {
    return notFound();
  }

  const cursors = new URL(request.url).searchParams.getAll('cursor');
  const cursor = cursors.length === 0 ? undefined : z.uuid().safeParse(cursors[0]);

  if (cursors.length > 1 || (cursor && !cursor.success)) {
    return badRequest({ message: 'Invalid API key cursor' });
  }

  const keys = await getUserApiKeys(auth.user.id, cursor?.data);

  if (!keys) {
    return badRequest({ message: 'Invalid API key cursor' });
  }

  return json(keys);
}

export async function POST(request: Request) {
  const { auth, body, error } = await parseRequest(request, createApiKeySchema, {
    maxBodyBytes: 16 * 1024,
  });

  if (error) {
    return error();
  }

  if (!isApiKeyEnabled()) {
    return notFound();
  }

  if (auth.authType !== 'session' || !auth.user?.id || auth.enrollmentOnly) {
    return unauthorized();
  }

  const user = await getUser(auth.user.id, { includePassword: true });
  if (!user) {
    return unauthorized();
  }

  let attempt;
  try {
    attempt = await reservePasswordVerificationAttempt(user.id);
  } catch {
    return serviceUnavailable({ message: 'Credential verification is temporarily unavailable' });
  }

  if (!attempt.allowed) {
    return tooManyRequests(attempt.retryAfter, { message: 'Too many password attempts' });
  }

  if (!(await checkPassword(body.currentPassword, user.password))) {
    return badRequest({ code: 'incorrect-password', message: 'Current password is incorrect' });
  }

  const authClient = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;
  const twoFactor = await authClient.twoFactorAuth.findUnique({
    where: { userId: user.id },
    select: { id: true, secret: true, isEnabled: true },
  });
  let factor = null;

  if (twoFactor?.isEnabled) {
    if (!auth.mfaVerified) {
      return unauthorized();
    }

    if (!isTwoFactorConfigured()) {
      return serviceUnavailable(getTwoFactorConfigurationError());
    }

    if (!body.token) {
      return badRequest({
        code: 'two-factor-error-invalid-code',
        message: 'Verification code required',
      });
    }

    let twoFactorAttempt;
    try {
      twoFactorAttempt = await reserveTwoFactorAttempt(user.id);
    } catch {
      return serviceUnavailable({ message: 'Credential verification is temporarily unavailable' });
    }

    if (!twoFactorAttempt.allowed) {
      const retryAfter = twoFactorAttempt.lockedUntil
        ? Math.max(1, Math.ceil((twoFactorAttempt.lockedUntil.getTime() - Date.now()) / 1000))
        : 60;
      return tooManyRequests(retryAfter, { message: 'Too many verification attempts' });
    }

    if (!(await verifyTotp(body.token, decryptSecret(twoFactor.secret)))) {
      return badRequest({
        code: 'two-factor-error-invalid-code',
        message: 'Invalid verification code',
      });
    }

    factor = { id: twoFactor.id, secret: twoFactor.secret, token: body.token };
  } else if (body.token) {
    return badRequest({ code: 'two-factor-error-not-enabled', message: '2FA is not enabled' });
  }

  const key = generateApiKey();

  let apiKey;

  try {
    apiKey = await createApiKey(
      {
        id: uuid(),
        userId: auth.user.id,
        name: body.name,
        keyHash: hashApiKey(key),
        keyPrefix: getApiKeyPrefix(key),
      },
      auth.sessionGeneration,
      user.password,
      factor,
    );
  } catch (error) {
    if (error instanceof ApiKeyCodeUsedError) {
      return badRequest({ code: 'two-factor-error-code-used', message: 'Code already used' });
    }

    if (error instanceof ApiKeyLimitReachedError) {
      return conflict({
        code: 'api-key-limit-reached',
        message: 'Delete an existing API key before creating another',
      });
    }

    if (error instanceof Error && error.message === 'API_KEY_AUTHORIZATION_CHANGED') {
      return unauthorized({ code: 'credentials-changed' });
    }

    throw error;
  }

  if (!apiKey) {
    return unauthorized({ code: 'credentials-changed' });
  }

  // The plaintext key is only returned once, at creation time.
  return json({ ...apiKey, key });
}
