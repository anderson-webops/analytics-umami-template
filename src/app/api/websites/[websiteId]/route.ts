import { z } from 'zod';
import { parseRequest } from '@/lib/request';
import { badRequest, json, notFound, ok, serverError, unauthorized } from '@/lib/response';
import { domainParam, routeSlugParam } from '@/lib/schema';
import { publicSharesDisabled } from '@/lib/security';
import { canDeleteWebsite, canUpdateWebsite, canViewSharedWebsite } from '@/permissions';
import { deleteWebsite, getWebsite, updateWebsite } from '@/queries/prisma';

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

  return json(website);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const schema = z.object({
    name: z.string().trim().min(1).max(100).optional(),
    domain: domainParam.optional(),
    shareId: routeSlugParam.nullable().optional(),
    replayConfig: z
      .object({
        replayEnabled: z.boolean().optional(),
        heatmapEnabled: z.boolean().optional(),
        sampleRate: z.number().min(0).max(1).optional(),
        heatmapSampleRate: z.number().min(0).max(1).optional(),
        maskLevel: z.enum(['strict', 'moderate']).optional(),
        maxDuration: z.number().int().min(60_000).max(3_600_000).optional(),
        blockSelector: z.string().max(1_000).optional(),
      })
      .strict()
      .nullable()
      .optional(),
  });

  const { auth, body, error } = await parseRequest(request, schema);

  if (error) {
    return error();
  }

  const { websiteId } = await params;
  const { name, domain, shareId, replayConfig } = body;

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
      shareId: share?.slug ?? null,
    });
  } catch (e: any) {
    if (e.message === 'ENTITY_NOT_FOUND') {
      return notFound({ message: 'Website not found.' });
    }

    if (e.message === 'ENTITY_ACTOR_NOT_AUTHORIZED') {
      return unauthorized({ message: 'Your website-update permission changed.' });
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
