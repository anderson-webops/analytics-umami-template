import { z } from 'zod';
import { uuid } from '@/lib/crypto';
import { isEnvEnabled } from '@/lib/env';
import { fetchAccount, fetchTeam } from '@/lib/load';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { conflict, forbidden, json, unauthorized } from '@/lib/response';
import {
  domainParam,
  pagingParams,
  routeSlugParam,
  searchParams,
  sortingParams,
} from '@/lib/schema';
import { publicSharesDisabled } from '@/lib/security';
import { getCloudWebsiteLimit } from '@/lib/subscription';
import { canCreateTeamWebsite, canCreateWebsite } from '@/permissions';
import { createWebsite } from '@/queries/prisma';
import { getAllUserWebsitesIncludingTeamAccess, getUserWebsites } from '@/queries/prisma/website';

export async function GET(request: Request) {
  const schema = z.object({
    ...pagingParams,
    ...searchParams,
    ...sortingParams,
    includeTeams: z.string().optional(),
  });

  const { auth, query, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const userId = auth.user.id;

  const filters = await getQueryFilters(query);

  if (query.includeTeams) {
    return json(await getAllUserWebsitesIncludingTeamAccess(userId, filters));
  }

  return json(await getUserWebsites(userId, filters));
}

export async function POST(request: Request) {
  const schema = z.object({
    name: z.string().trim().min(1).max(100),
    domain: domainParam,
    shareId: routeSlugParam.nullable().optional(),
    teamId: z.uuid().nullable().optional(),
    id: z.uuid().nullable().optional(),
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { id, name, domain, shareId, teamId } = body;

  if (id && !auth.user.isAdmin) {
    return unauthorized({ message: 'Only an administrator can supply an entity ID.' });
  }

  if (shareId && publicSharesDisabled()) {
    return forbidden({ message: 'Public analytics shares are disabled.' });
  }

  let activeOwnerWebsiteLimit: number | undefined;

  if (isEnvEnabled('CLOUD_MODE')) {
    const account = teamId ? await fetchTeam(teamId) : await fetchAccount(auth.user.id);
    const websiteLimit = getCloudWebsiteLimit(account);

    activeOwnerWebsiteLimit = websiteLimit ?? undefined;
  }

  if ((teamId && !(await canCreateTeamWebsite(auth, teamId))) || !(await canCreateWebsite(auth))) {
    return unauthorized();
  }

  const websiteId = id ?? uuid();
  const data: any = {
    id: websiteId,
    createdBy: auth.user.id,
    name,
    domain,
    teamId,
  };

  if (!teamId) {
    data.userId = auth.user.id;
  }

  let website;
  let share;

  try {
    ({ website, share } = await createWebsite(data, auth.user.id, {
      activeOwnerWebsiteLimit,
      customEntityId: !!id,
      initialShare: shareId
        ? {
            name,
            slug: shareId,
            parameters: { overview: true, events: true },
          }
        : undefined,
    }));
  } catch (error: any) {
    switch (error?.message) {
      case 'ENTITY_ID_CONFLICT':
        return conflict({ message: 'That entity ID is already in use.' });
      case 'ENTITY_OWNER_NOT_FOUND':
        return unauthorized({ message: 'The selected owner is no longer available.' });
      case 'ENTITY_ACTOR_NOT_AUTHORIZED':
        return unauthorized({ message: 'Your website-creation permission changed.' });
      case 'ENTITY_ADMIN_REQUIRED':
        return unauthorized({ message: 'Only an administrator can supply an entity ID.' });
      case 'WEBSITE_LIMIT_REACHED':
        return unauthorized({ message: 'Website limit reached.' });
      default:
        if (error?.code === 'P2002') {
          return conflict({ message: 'That website or share identifier is already in use.' });
        }

        throw error;
    }
  }

  return json({
    ...website,
    shareId: share?.slug ?? null,
  });
}
