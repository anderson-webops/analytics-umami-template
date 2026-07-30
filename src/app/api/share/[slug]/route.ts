import { ROLES, SHARE_TOKEN_TYPE } from '@/lib/constants';
import { secret } from '@/lib/crypto';
import { createToken } from '@/lib/jwt';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';
import { json, notFound } from '@/lib/response';
import { routeSlugParam, whiteLabelParam } from '@/lib/schema';
import { getShareTokenTtlSeconds, publicSharesDisabled } from '@/lib/security';
import { resolveShareAccess, type ShareEntity } from '@/lib/share-access';
import type { WhiteLabel } from '@/lib/types';
import { getShareByCode } from '@/queries/prisma';

async function getAccountId(entity: ShareEntity): Promise<string | null> {
  if (entity.userId) {
    return entity.userId;
  }

  if (entity.teamId) {
    const teamOwner = await prisma.client.teamUser.findFirst({
      where: {
        teamId: entity.teamId,
        role: ROLES.teamOwner,
        team: { deletedAt: null },
        user: { deletedAt: null },
      },
      select: {
        userId: true,
      },
    });

    return teamOwner?.userId || null;
  }

  return null;
}

async function getWhiteLabel(accountId: string): Promise<WhiteLabel | null> {
  if (!redis.enabled) {
    return null;
  }

  const data = await redis.client.get(`white-label:${accountId}`);
  const result = whiteLabelParam.safeParse(data);

  return result.success ? (result.data as WhiteLabel) : null;
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (publicSharesDisabled()) {
    return notFound();
  }

  const { slug } = await params;

  if (!routeSlugParam.safeParse(slug).success) {
    return notFound();
  }

  const share = await getShareByCode(slug);

  if (!share) {
    return notFound();
  }

  const access = await resolveShareAccess(share);

  if (!access) {
    return notFound();
  }

  const data: Record<string, any> = { ...access.data };
  data.token = createToken({ ...data, type: SHARE_TOKEN_TYPE }, secret(), {
    expiresIn: getShareTokenTtlSeconds(),
  });

  const accountId = await getAccountId(access.entity);

  if (accountId) {
    const whiteLabel = await getWhiteLabel(accountId);

    if (whiteLabel) {
      data.whiteLabel = whiteLabel;
    }
  }

  return json(data);
}
