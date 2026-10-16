import { isEnvEnabled } from '@/lib/env';
import { checkPassword } from '@/lib/password';
import { reservePasswordVerificationAttempt } from '@/lib/password-verification-rate-limit';
import prisma from '@/lib/prisma';
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
import {
  encryptSecret,
  getTwoFactorConfigurationError,
  isTwoFactorConfigured,
} from '@/lib/two-factor/crypto';
import {
  generateOtpAuthUri,
  generateQrCodeDataUrl,
  generateTotpSecret,
} from '@/lib/two-factor/totp';
import { runActiveSessionMutation, SessionRevokedError } from '@/queries/prisma/authorization';
import { getUser } from '@/queries/prisma/user';
import { initiateTwoFactorSetupSchema } from './schema';

export async function POST(request: Request) {
  if (isEnvEnabled('CLOUD_MODE')) {
    return notFound();
  }

  const { auth, body, error } = await parseRequest(request, initiateTwoFactorSetupSchema, {
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

  // Secrets cannot be stored without an encryption key
  if (!isTwoFactorConfigured()) {
    return serviceUnavailable(getTwoFactorConfigurationError());
  }

  const userId = auth.user.id;
  const user = await getUser(userId, { includePassword: true });

  if (!user) {
    return unauthorized();
  }

  const existing = await prisma.client.twoFactorAuth.findUnique({ where: { userId } });

  if (existing?.isEnabled) {
    return badRequest({
      code: 'two-factor-error-already-enabled',
      message: '2FA is already enabled',
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

  if (!(await checkPassword(body.password, user.password))) {
    return badRequest({
      code: 'two-factor-error-incorrect-password',
      message: 'Incorrect password',
    });
  }

  const secret = generateTotpSecret();
  const encryptedSecret = encryptSecret(secret);
  const otpAuthUri = generateOtpAuthUri(secret, user.username);
  const qrCodeDataUrl = await generateQrCodeDataUrl(otpAuthUri);

  let writeResult;
  try {
    writeResult = await runActiveSessionMutation(auth, async transaction => {
      const current = await transaction.$queryRaw<Array<{ sessionGeneration: number }>>`
      SELECT "session_generation" AS "sessionGeneration"
      FROM "user"
      WHERE "user_id" = ${userId}::uuid
        AND "password" = ${user.password}
        AND "deleted_at" IS NULL
        AND "session_generation" = ${auth.sessionGeneration}
      FOR UPDATE
    `;

      if (current.length !== 1) {
        return 'credentials-changed';
      }

      if (existing) {
        const updated = await transaction.$queryRaw<Array<{ id: string }>>`
        UPDATE "two_factor_auth"
        SET "secret" = ${encryptedSecret},
            "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${existing.id}
          AND "user_id" = ${userId}::uuid
          AND "secret" = ${existing.secret}
          AND "is_enabled" = false
        RETURNING "id"
      `;
        return updated.length === 1 ? 'written' : 'setup-changed';
      }

      const created = await transaction.twoFactorAuth.createMany({
        data: [{ userId, secret: encryptedSecret, isEnabled: false }],
        skipDuplicates: true,
      });
      return created.count === 1 ? 'written' : 'setup-changed';
    });
  } catch (error) {
    if (error instanceof SessionRevokedError) {
      return unauthorized({ code: 'credentials-changed' });
    }

    throw error;
  }

  if (writeResult === 'credentials-changed') {
    return unauthorized({ code: 'credentials-changed' });
  }

  if (writeResult !== 'written') {
    return conflict({
      code: 'two-factor-error-setup-changed',
      message: '2FA setup changed; start again',
    });
  }

  /*
  `manualKey` is intentionally plaintext as the user needs it once for manual entry.
  The encrypted copy in DB is what matters for long-term storage.
   */
  return json({ qrCodeDataUrl, manualKey: secret });
}
