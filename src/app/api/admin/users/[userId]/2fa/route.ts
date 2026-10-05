import { z } from 'zod';
import { isEnvEnabled } from '@/lib/env';
import prisma from '@/lib/prisma';
import { parseRequest } from '@/lib/request';
import { json, notFound, serviceUnavailable, unauthorized } from '@/lib/response';
import { getTwoFactorConfigurationError, isTwoFactorConfigured } from '@/lib/two-factor/crypto';
import { canEnforceTwoFactorAuthForUser } from '@/permissions';
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

  const { twoFactorAuth, backupCodes, otpUsed, rateLimit } = await prisma.transaction(async tx => {
    const twoFactorAuth = await tx.twoFactorAuth.deleteMany({ where: { userId } });

    if (twoFactorAuth.count > 0) {
      await tx.user.updateMany({
        where: { id: userId, deletedAt: null },
        data: { sessionGeneration: { increment: 1 } },
      });
    }

    const backupCodes = await tx.twoFactorBackupCode.deleteMany({ where: { userId } });
    const otpUsed = await tx.twoFactorOtpUsed.deleteMany({ where: { userId } });
    const rateLimit = await tx.twoFactorRateLimit.deleteMany({ where: { userId } });

    return { twoFactorAuth, backupCodes, otpUsed, rateLimit };
  });

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
