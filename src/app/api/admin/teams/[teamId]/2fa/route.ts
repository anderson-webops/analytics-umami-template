import { z } from 'zod';
import { isEnvEnabled } from '@/lib/env';
import { parseRequest } from '@/lib/request';
import { json, notFound, serviceUnavailable, unauthorized } from '@/lib/response';
import { getTwoFactorConfigurationError, isTwoFactorConfigured } from '@/lib/two-factor/crypto';
import { canEnforceTwoFactorAuthForTeam } from '@/permissions';
import { runAuthorizedAdministratorMutation } from '@/queries/prisma/authorization';

export async function POST(request: Request, { params }: { params: Promise<{ teamId: string }> }) {
  if (isEnvEnabled('CLOUD_MODE')) {
    return notFound();
  }

  const schema = z.object({ required: z.boolean() });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { teamId } = await params;

  if (!(await canEnforceTwoFactorAuthForTeam(auth, teamId))) {
    return unauthorized();
  }
  const { required } = body;

  if (required && !isTwoFactorConfigured()) {
    return serviceUnavailable(getTwoFactorConfigurationError());
  }

  try {
    await runAuthorizedAdministratorMutation(auth.user.id, async transaction => {
      const updated = await transaction.team.updateMany({
        where: { id: teamId, deletedAt: null },
        data: { twoFactorRequired: required },
      });

      if (updated.count !== 1) {
        throw new Error('TEAM_NOT_FOUND');
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'ENTITY_ADMIN_REQUIRED') {
      return unauthorized({ message: 'Your administrator permission changed.' });
    }

    if (error instanceof Error && error.message === 'TEAM_NOT_FOUND') {
      return notFound();
    }

    throw error;
  }

  return json({ ok: true, teamId, twoFactorRequired: required });
}
