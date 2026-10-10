export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { POST } from '@/app/api/send/route';
import { getCollectionIpLimit, transferCollectionIpLimit } from '@/lib/collection-rate-limit';
import { notFound, tooManyRequests } from '@/lib/response';
import { httpUrlParam, routeSlugParam } from '@/lib/schema';
import { findLink } from '@/queries/prisma';

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  if (!routeSlugParam.safeParse(slug).success) {
    return notFound();
  }

  const collectionLimit = await getCollectionIpLimit(request);

  if (collectionLimit.blocked) {
    return tooManyRequests(collectionLimit.retryAfter);
  }

  const link = await findLink({ where: { slug, deletedAt: null } });

  if (!link || !httpUrlParam.safeParse(link.url).success) {
    return notFound();
  }

  const payload = {
    type: 'event',
    payload: {
      link: link.id,
      url: request.url,
      referrer: request.headers.get('referer') || undefined,
    },
  };

  const headers = new Headers(request.headers);
  headers.delete('authorization');
  headers.delete('content-length');
  headers.delete('cookie');
  headers.delete('x-umami-cache');
  headers.set('content-type', 'application/json');

  const req = new Request(request.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  transferCollectionIpLimit(request, req);
  await POST(req);

  const currentLink = await findLink({ where: { slug, deletedAt: null } });

  if (
    !currentLink ||
    currentLink.id !== link.id ||
    !httpUrlParam.safeParse(currentLink.url).success
  ) {
    return notFound();
  }

  const response = NextResponse.redirect(currentLink.url);
  response.headers.set('Cache-Control', 'no-store');

  return response;
}
