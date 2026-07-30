import { z } from 'zod';
import { getRecorderConfig } from '@/lib/recorder';
import { isAllowedTrackingHostname } from '@/lib/security';
import { findWebsite } from '@/queries/prisma';

function getTrackingOrigin(request: Request): URL | null {
  const value = request.headers.get('origin') || request.headers.get('referer');

  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);

    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}

function unavailable() {
  return Response.json(
    { enabled: false },
    {
      status: 404,
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ websiteId: string }> },
) {
  const { websiteId } = await params;
  const origin = getTrackingOrigin(request);

  if (!z.uuid().safeParse(websiteId).success || !origin) {
    return unavailable();
  }

  const website = await findWebsite({
    where: {
      id: websiteId,
      deletedAt: null,
    },
  });

  if (!website || !isAllowedTrackingHostname(website.domain, origin.hostname, origin.toString())) {
    return unavailable();
  }

  const headers = {
    'Access-Control-Allow-Origin': origin.origin,
    'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    Vary: 'Origin',
  };

  if (!website.recorderEnabled) {
    return Response.json({ enabled: false }, { headers });
  }

  const config = getRecorderConfig(website.replayConfig);

  return Response.json(
    {
      enabled: true,
      replayEnabled: config.replayEnabled === true,
      heatmapEnabled: config.heatmapEnabled === true,
      sampleRate: config.sampleRate ?? 0.15,
      heatmapSampleRate: config.heatmapSampleRate ?? 0.15,
      maskLevel: config.maskLevel ?? 'moderate',
      maxDuration: config.maxDuration ?? 300_000,
      blockSelector: config.blockSelector ?? '',
    },
    { headers },
  );
}
