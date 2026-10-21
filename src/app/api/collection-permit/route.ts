import { z } from 'zod';
import { hasCurrentCacheGeneration, parseCacheToken } from '@/lib/cache-token';
import { createCollectionPermit } from '@/lib/collection-permit';
import { CollectionRequestReplayError, getBackendCollectionRequest } from '@/lib/collection-proof';
import { getCollectionIpLimit } from '@/lib/collection-rate-limit';
import { secret } from '@/lib/crypto';
import { getRecorderConfig } from '@/lib/recorder';
import { parseRequest } from '@/lib/request';
import {
  badRequest,
  conflict,
  forbidden,
  json,
  serverError,
  tooManyRequests,
} from '@/lib/response';
import { getAllowedTrackingOrigin } from '@/lib/tracking-origin';
import { reserveBackendCollectionRequest, withActiveCollectionSource } from '@/queries/prisma';

const schema = z
  .object({
    website: z.uuid().transform(value => value.toLowerCase()),
    feature: z.enum(['record', 'heatmap']),
    origin: z.url().max(253),
    consent: z.literal(true),
  })
  .strict();

export async function POST(request: Request) {
  try {
    const limit = await getCollectionIpLimit(request);

    if (limit.blocked) {
      return tooManyRequests(limit.retryAfter);
    }

    const { body, error } = await parseRequest(request, schema, {
      skipAuth: true,
      maxBodyBytes: 1024,
    });

    if (error) {
      return error();
    }

    const backendRequest = getBackendCollectionRequest(request, body.website, ['recorder']);
    const cache = parseCacheToken(request.headers.get('x-umami-cache'), secret());

    if (
      !backendRequest ||
      !cache ||
      cache.websiteId !== body.website ||
      !cache.sessionId ||
      !cache.visitId
    ) {
      return forbidden({ message: 'Recording authorization required.' });
    }

    try {
      const response = await withActiveCollectionSource(
        'website',
        body.website,
        async transaction => {
          const website = await transaction.website.findFirst({
            where: { id: body.website, deletedAt: null },
            select: {
              domain: true,
              collectionGeneration: true,
              recorderEnabled: true,
              replayConfig: true,
            },
          });
          const config = getRecorderConfig(website?.replayConfig);
          const featureEnabled =
            body.feature === 'record' ? config.replayEnabled : config.heatmapEnabled;
          const allowedOrigin = getAllowedTrackingOrigin(body.origin, website?.domain);

          if (website && !hasCurrentCacheGeneration(cache, website.collectionGeneration)) {
            return forbidden({ message: 'Recording authorization required.' });
          }

          if (
            !website?.recorderEnabled ||
            !website.domain ||
            !featureEnabled ||
            !allowedOrigin?.startsWith('https://')
          ) {
            return badRequest({ message: 'Recording is not enabled for this website.' });
          }

          if (body.feature === 'record' && config.maskLevel !== 'strict') {
            return forbidden({ message: 'Strict masking is required for replay.' });
          }

          await reserveBackendCollectionRequest(transaction, body.website, backendRequest);
          return json({
            permit: createCollectionPermit(
              cache,
              body.feature,
              backendRequest,
              allowedOrigin,
              website.domain,
            ),
          });
        },
        backendRequest,
      );
      response.headers.set('Cache-Control', 'no-store');
      return response;
    } catch (error) {
      if (error instanceof Error && error.message === 'COLLECTION_SOURCE_NOT_FOUND') {
        return badRequest({ message: 'Recording is not enabled for this website.' });
      }
      if (error instanceof Error && error.message === 'COLLECTION_KEY_OWNER_CHANGED') {
        return forbidden({ message: 'Recording authorization required.' });
      }
      if (error instanceof CollectionRequestReplayError) {
        return conflict({ message: 'Backend collection request already accepted.' });
      }

      throw error;
    }
  } catch (error) {
    return serverError(error);
  }
}
