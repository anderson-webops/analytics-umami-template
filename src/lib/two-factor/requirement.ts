import prisma from '@/lib/prisma';

export async function getTwoFactorRequirement(userId: string) {
  const client = '$primary' in prisma.client ? prisma.client.$primary() : prisma.client;
  const globalSetting = await client.appSetting.findUnique({
    where: { key: 'twoFactorRequiredGlobal' },
  });
  const globalRequired = globalSetting?.value === 'true';

  if (globalRequired) {
    return { reason: 'global' as const, globalRequired };
  }

  const user = await client.user.findUnique({
    where: { id: userId },
    select: { twoFactorRequired: true },
  });

  if (user?.twoFactorRequired) {
    return { reason: 'user' as const, globalRequired };
  }

  const memberships = await client.teamUser.findMany({ where: { userId } });
  const teamIds = memberships.map(membership => membership.teamId);
  const requiredTeams = teamIds.length
    ? await client.team.findMany({
        where: { id: { in: teamIds }, twoFactorRequired: true },
      })
    : [];

  return {
    reason: requiredTeams.length > 0 ? ('team' as const) : null,
    globalRequired,
  };
}
