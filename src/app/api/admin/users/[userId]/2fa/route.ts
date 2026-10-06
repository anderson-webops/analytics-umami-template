import { z } from 'zod';
import { isEnvEnabled } from '@/lib/env';
import prisma from '@/lib/prisma';
import { parseRequest } from '@/lib/request';
import { json, notFound, serviceUnavailable, unauthorized } from '@/lib/response';
import { getTwoFactorConfigurationError, isTwoFactorConfigured } from '@/lib/two-factor/crypto';
import { canEnforceTwoFactorAuthForUser } from '@/permissions';
import { runAuthorizedAdministratorMutation } from '@/queries/prisma/authorization';
import { updateUser } from '@/queries/prisma/user';

export async function GET(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  if (isEnvEnabled('CLOUD_MODE')) {
    return notFound();
  }

  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  if (!(await canEnforceTwoFactorAuthForUser(auth))) {
    return unauthorized();
  }

  const { userId } = await params;

  const twoFactor = await prisma.client.twoFactorAuth.findUnique({ where: { userId } });

  return json({ isEnabled: twoFactor?.isEnabled ?? false });
}

export async function POST(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  if (isEnvEnabled('CLOUD_MODE')) {
    return notFound();
  }

  const schema = z.object({ required: z.boolean() });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  if (!(await canEnforceTwoFactorAuthForUser(auth))) {
    return unauthorized();
  }

  const { userId } = await params;
  const { required } = body;

  if (required && !isTwoFactorConfigured()) {
    return serviceUnavailable(getTwoFactorConfigurationError());
  }

  const user = await updateUser(userId, { twoFactorRequired: required }, auth.user.id);

  return json({ ok: true, userId: user.id, twoFactorRequired: required });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  if (isEnvEnabled('CLOUD_MODE')) {
    return notFound();
  }

  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  if (!(await canEnforceTwoFactorAuthForUser(auth))) {
    return unauthorized();
  }

  const { userId } = await params;

  let reset;

  try {
    reset = await runAuthorizedAdministratorMutation(auth.user.id, async transaction => {
      const target = await transaction.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: { id: true },
      });

      if (!target) {
        throw new Error('USER_NOT_FOUND');
      }

      const twoFactorAuth = await transaction.twoFactorAuth.deleteMany({ where: { userId } });

      if (twoFactorAuth.count > 0) {
        const updated = await transaction.user.updateMany({
          where: { id: userId, deletedAt: null },
          data: { sessionGeneration: { increment: 1 } },
        });

        if (updated.count !== 1) {
          throw new Error('USER_NOT_FOUND');
        }
      }

      const backupCodes = await transaction.twoFactorBackupCode.deleteMany({ where: { userId } });
      const otpUsed = await transaction.twoFactorOtpUsed.deleteMany({ where: { userId } });
      const rateLimit = await transaction.twoFactorRateLimit.deleteMany({ where: { userId } });

      return { twoFactorAuth, backupCodes, otpUsed, rateLimit };
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'ENTITY_ADMIN_REQUIRED') {
      return unauthorized({ message: 'Your administrator permission changed.' });
    }

    if (error instanceof Error && error.message === 'USER_NOT_FOUND') {
      return notFound();
    }

    throw error;
  }

  const { twoFactorAuth, backupCodes, otpUsed, rateLimit } = reset;

  return json({
    ok: true,
    userId,
    reset: {
      twoFactorAuth: twoFactorAuth.count,
      backupCodes: backupCodes.count,
      otpUsed: otpUsed.count,
      rateLimit: rateLimit.count,
    },
  });
}
