import { redactWebsiteShareId } from '@/lib/api-key';
import { parseRequest } from '@/lib/request';
import { badRequest, json, notFound, ok, serverError, unauthorized } from '@/lib/response';
import { publicSharesDisabled } from '@/lib/security';
import { canDeleteWebsite, canUpdateWebsite, canViewSharedWebsite } from '@/permissions';
import { deleteWebsite, getWebsite, updateWebsite } from '@/queries/prisma';
import { updateWebsiteRequestSchema } from '../request-schema';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { websiteId } = await params;

  if (!(await canViewSharedWebsite(auth, websiteId))) {
    return unauthorized();
  }

  const website = await getWebsite(websiteId);

  if (!website) {
    return notFound();
  }

  if (!auth.user) {
    return json({
      id: website.id,
      name: website.name,
      domain: website.domain,
      resetAt: website.resetAt,
      createdAt: website.createdAt,
      updatedAt: website.updatedAt,
    });
  }

  const canManageShares = auth.authType === 'session' && (await canUpdateWebsite(auth, websiteId));

  return json(redactWebsiteShareId(website, auth.authType, canManageShares));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { auth, body, error } = await parseRequest(request, updateWebsiteRequestSchema);

  if (error) {
    return error();
  }

  const { websiteId } = await params;
  const { name, domain, shareId, replayConfig } = body;

  if (auth.authType === 'api-key' && shareId !== undefined) {
    return unauthorized({ message: 'An interactive session is required to manage public shares.' });
  }

  if (shareId && publicSharesDisabled()) {
    return badRequest({ message: 'Public analytics shares are disabled.' });
  }

  if (!(await canUpdateWebsite(auth, websiteId))) {
    return unauthorized();
  }

  try {
    const { website, share } = await updateWebsite(
      websiteId,
      {
        name,
        domain,
      },
      auth.user.id,
      {
        shareSlug: shareId,
        replayConfig,
      },
    );

    return json({
      ...website,
      shareId: auth.authType === 'api-key' ? null : (share?.slug ?? null),
    });
  } catch (e: any) {
    if (e.message === 'ENTITY_NOT_FOUND') {
      return notFound({ message: 'Website not found.' });
    }

    if (e.message === 'ENTITY_ACTOR_NOT_AUTHORIZED') {
      return unauthorized({ message: 'Your website-update permission changed.' });
    }

    if (e.message === 'WEBSITE_SHARE_ROTATION_AMBIGUOUS') {
      return badRequest({ message: 'Manage the existing website shares individually.' });
    }

    if (e?.code === 'P2002') {
      return badRequest({ message: 'That share ID is already taken.' });
    }

    return serverError(e);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { auth, error } = await parseRequest(request);

  if (error) {
    return error();
  }

  const { websiteId } = await params;

  if (!(await canDeleteWebsite(auth, websiteId))) {
    return unauthorized();
  }

  try {
    await deleteWebsite(websiteId, auth.user.id);
  } catch (error: any) {
    switch (error?.message) {
      case 'ENTITY_NOT_FOUND':
        return notFound({ message: 'Website not found.' });
      case 'ENTITY_ACTOR_NOT_AUTHORIZED':
        return unauthorized({ message: 'Your website-deletion permission changed.' });
      default:
        throw error;
    }
  }

  return ok();
}
