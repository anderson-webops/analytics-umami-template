import { z } from 'zod';
import { uuid } from '@/lib/crypto';
import { getQueryFilters, parseRequest } from '@/lib/request';
import { conflict, json, unauthorized } from '@/lib/response';
import {
  httpUrlParam,
  pagingParams,
  routeSlugParam,
  searchParams,
  sortingParams,
} from '@/lib/schema';
import { canCreateTeamWebsite, canCreateWebsite } from '@/permissions';
import { createLink, getUserLinks } from '@/queries/prisma';

export async function GET(request: Request) {
  const schema = z.object({
    ...pagingParams,
    ...searchParams,
    ...sortingParams,
  });

  const { auth, query, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const filters = await getQueryFilters(query);

  const links = await getUserLinks(auth.user.id, filters);

  return json(links);
}

export async function POST(request: Request) {
  const schema = z.object({
    name: z.string().trim().min(1).max(100),
    url: httpUrlParam,
    slug: routeSlugParam,
    teamId: z.uuid().nullable().optional(),
    id: z.uuid().nullable().optional(),
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { id, name, url, slug, teamId } = body;

  if (id && !auth.user.isAdmin) {
    return unauthorized({ message: 'Only an administrator can supply an entity ID.' });
  }

  if ((teamId && !(await canCreateTeamWebsite(auth, teamId))) || !(await canCreateWebsite(auth))) {
    return unauthorized();
  }

  const data: any = {
    id: id ?? uuid(),
    name,
    url,
    slug,
    teamId,
  };

  if (!teamId) {
    data.userId = auth.user.id;
  }

  let result;

  try {
    result = await createLink(data, auth.user.id, { customEntityId: !!id });
  } catch (error: any) {
    switch (error?.message) {
      case 'ENTITY_ID_CONFLICT':
        return conflict({ message: 'That entity ID is already in use.' });
      case 'ENTITY_OWNER_NOT_FOUND':
        return unauthorized({ message: 'The selected owner is no longer available.' });
      case 'ENTITY_ACTOR_NOT_AUTHORIZED':
        return unauthorized({ message: 'Your link-creation permission changed.' });
      case 'ENTITY_ADMIN_REQUIRED':
        return unauthorized({ message: 'Only an administrator can supply an entity ID.' });
      default:
        if (error?.code === 'P2002') {
          return conflict({ message: 'That link slug is already in use.' });
        }

        throw error;
    }
  }

  return json(result);
}
