export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { POST } from '@/app/api/send/route';
import type { Pixel } from '@/generated/prisma/client';
import redis from '@/lib/redis';
import { notFound } from '@/lib/response';
import { routeSlugParam } from '@/lib/schema';
import { findPixel } from '@/queries/prisma';

const image = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw', 'base64');

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  if (!routeSlugParam.safeParse(slug).success) {
    return notFound();
  }

  let pixel: Pixel;

  if (redis.enabled) {
    pixel = await redis.client.fetch(
      `pixel:${slug}`,
      async () => {
        return findPixel({
          where: {
            slug,
            deletedAt: null,
          },
        });
      },
      86400,
    );

    if (!pixel) {
      return notFound();
    }
  } else {
    pixel = await findPixel({
      where: {
        slug,
        deletedAt: null,
      },
    });

    if (!pixel) {
      return notFound();
    }
  }

  const payload = {
    type: 'event',
    payload: {
      pixel: pixel.id,
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

  return new NextResponse(image, {
    headers: {
      'Content-Type': 'image/gif',
      'Content-Length': image.length.toString(),
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    },
  });
}
