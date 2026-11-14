import { hasPermission } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/constants';
import { getBillingAccess, getTeamBillingScope } from '@/lib/load';
import type { Auth } from '@/lib/types';
import { getTeam, getTeamUser } from '@/queries/prisma';
import { canMutateResource } from './mutation';

async function hasTeamBillingAccess(teamId: string) {
  return !(await getBillingAccess(await getTeamBillingScope(teamId))).isPastDue;
}

export async function canViewTeamSubscription({ user }: Auth, teamId: string) {
  if (!user) {
    return false;
  }

  if (user.isAdmin) {
    return !!(await getTeam(teamId));
  }

  return !!(await getTeamUser(teamId, user.id));
}

export async function canViewTeam(auth: Auth, teamId: string) {
  if (!(await canViewTeamSubscription(auth, teamId))) {
    return false;
  }

  return hasTeamBillingAccess(teamId);
}

export async function canCreateTeam({ user }: Auth) {
  if (!canMutateResource(user)) {
    return false;
  }

  if (user.isAdmin) {
    return true;
  }

  return (
    !(await getBillingAccess({ accountId: user.id }, user.id)).isPastDue &&
    hasPermission(user.role, PERMISSIONS.teamCreate)
  );
}

export async function canUpdateTeam({ user }: Auth, teamId: string) {
  if (!canMutateResource(user)) {
    return false;
  }

  if (user.isAdmin) {
    return !!(await getTeam(teamId));
  }

  const teamUser = await getTeamUser(teamId, user.id);

  return (
    !!teamUser &&
    (await hasTeamBillingAccess(teamId)) &&
    hasPermission(teamUser.role, PERMISSIONS.teamUpdate)
  );
}

export async function canDeleteTeam({ user }: Auth, teamId: string) {
  if (!canMutateResource(user)) {
    return false;
  }

  if (user.isAdmin) {
    return !!(await getTeam(teamId));
  }

  const teamUser = await getTeamUser(teamId, user.id);

  return (
    !!teamUser &&
    (await hasTeamBillingAccess(teamId)) &&
    hasPermission(teamUser.role, PERMISSIONS.teamDelete)
  );
}

export async function canDeleteTeamUser({ user }: Auth, teamId: string, removeUserId: string) {
  if (!canMutateResource(user)) {
    return false;
  }

  if (user.isAdmin) {
    return !!(await getTeam(teamId));
  }

  if (removeUserId === user.id) {
    return hasTeamBillingAccess(teamId);
  }

  const teamUser = await getTeamUser(teamId, user.id);

  return (
    !!teamUser &&
    (await hasTeamBillingAccess(teamId)) &&
    hasPermission(teamUser.role, PERMISSIONS.teamUpdate)
  );
}

export async function canTransferTeamOwnership({ user }: Auth, teamId: string) {
  if (!canMutateResource(user)) {
    return false;
  }

  if (user.isAdmin) {
    return !!(await getTeam(teamId));
  }

  const teamUser = await getTeamUser(teamId, user.id);

  return teamUser?.role === 'team-owner';
}

export async function canCreateTeamWebsite({ user }: Auth, teamId: string) {
  if (!canMutateResource(user)) {
    return false;
  }

  if (user.isAdmin) {
    return !!(await getTeam(teamId));
  }

  // A team role never overrides a globally view-only user. Only the global role is
  // checked here, not personal billing; team billing applies to team resources.
  if (!hasPermission(user.role, PERMISSIONS.websiteCreate)) {
    return false;
  }

  const teamUser = await getTeamUser(teamId, user.id);

  return (
    !!teamUser &&
    (await hasTeamBillingAccess(teamId)) &&
    hasPermission(teamUser.role, PERMISSIONS.websiteCreate)
  );
}

export async function canUpdateTeamWebsites({ user }: Auth, teamId: string) {
  if (!canMutateResource(user)) {
    return false;
  }

  if (user.isAdmin) {
    return !!(await getTeam(teamId));
  }

  const teamUser = await getTeamUser(teamId, user.id);

  return !!teamUser && hasPermission(teamUser.role, PERMISSIONS.websiteUpdate);
}

export async function canViewAllTeams({ user }: Auth) {
  return user?.isAdmin ?? false;
}

export async function canEnforceTwoFactorAuthForTeam({ user }: Auth, teamId: string) {
  if (!user) {
    return false;
  }

  return user.isAdmin && !!(await getTeam(teamId));
}
