export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { POST } from '@/app/api/send/route';
import type { Link } from '@/generated/prisma/client';
import redis from '@/lib/redis';
import { notFound } from '@/lib/response';
import { httpUrlParam, routeSlugParam } from '@/lib/schema';
import { findLink } from '@/queries/prisma';

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  if (!routeSlugParam.safeParse(slug).success) {
    return notFound();
  }

  let link: Link;

  if (redis.enabled) {
    link = await redis.client.fetch(
      `link:${slug}`,
      async () => {
        return findLink({
          where: {
            slug,
            deletedAt: null,
          },
        });
      },
      86400,
    );

    if (!link) {
      return notFound();
    }
  } else {
    link = await findLink({
      where: {
        slug,
        deletedAt: null,
      },
    });

    if (!link) {
      return notFound();
    }
  }

  if (!httpUrlParam.safeParse(link.url).success) {
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

  await POST(req);

  const response = NextResponse.redirect(link.url);
  response.headers.set('Cache-Control', 'no-store');

  return response;
}
