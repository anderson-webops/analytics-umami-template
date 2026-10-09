import { generateApiKey, getApiKeyPrefix, hashApiKey, isApiKeyEnabled } from '@/lib/api-key';
import { uuid } from '@/lib/crypto';
import { checkPassword } from '@/lib/password';
import { reservePasswordVerificationAttempt } from '@/lib/password-verification-rate-limit';
import { parseRequest } from '@/lib/request';
import {
  badRequest,
  json,
  notFound,
  serviceUnavailable,
  tooManyRequests,
  unauthorized,
} from '@/lib/response';
import { createApiKey, getUserApiKeys } from '@/queries/prisma/apiKey';
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

  return json(await getUserApiKeys(auth.user.id));
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

  const key = generateApiKey();

  const apiKey = await createApiKey(
    {
      id: uuid(),
      userId: auth.user.id,
      name: body.name,
      keyHash: hashApiKey(key),
      keyPrefix: getApiKeyPrefix(key),
    },
    auth.sessionGeneration,
    user.password,
  );

  if (!apiKey) {
    return unauthorized({ code: 'credentials-changed' });
  }

  // The plaintext key is only returned once, at creation time.
  return json({ ...apiKey, key });
}
