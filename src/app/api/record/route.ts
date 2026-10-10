import { z } from 'zod';
import { type CacheToken, parseCacheToken } from '@/lib/cache-token';
import clickhouse from '@/lib/clickhouse';
import { CollectionBudgetExceededError } from '@/lib/collection-budget';
import {
  getCollectionIpLimit,
  getCollectionSourceLimit,
  getCollectionSourceStatus,
} from '@/lib/collection-rate-limit';
import { CACHE_TOKEN_TYPE, HEATMAP_EVENT_TYPE } from '@/lib/constants';
import { corsPreflight, withCorsHeaders } from '@/lib/cors';
import { secret } from '@/lib/crypto';
import { getClientInfo, hasBlockedIp } from '@/lib/detect';
import { isEnvEnabled } from '@/lib/env';
import { HeatmapBudgetExceededError, reserveHeatmapBudget } from '@/lib/heatmap-budget';
import { getHeatmapUrlPath } from '@/lib/heatmap-url';
import { fetchAccount, fetchTeam } from '@/lib/load';
import { getRecorderConfig } from '@/lib/recorder';
import { getReplayEventCount } from '@/lib/replay';
import { ReplayBudgetExceededError, reserveReplayBudget } from '@/lib/replay-budget';
import { countReplayStructureUnits } from '@/lib/replay-structure';
import { parseRequest } from '@/lib/request';
import {
  badRequest,
  conflict,
  forbidden,
  json,
  payloadTooLarge,
  serverError,
  tooManyRequests,
} from '@/lib/response';
import { replayObjectParam, urlOrPathParam } from '@/lib/schema';
import { getWebsite, withActiveCollectionSource } from '@/queries/prisma';
import { saveRecording } from '@/queries/sql';
import { saveHeatmapEvents } from '@/queries/sql/heatmap/saveHeatmapEvents';

const MAX_RECORD_REQUEST_BYTES = 1024 * 1024;
const MAX_RECORD_EVENTS = 200;
const MAX_REPLAY_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

const replayEventTimestampParam = z.coerce
  .number()
  .finite()
  .nonnegative()
  .refine(
    value => value >= Date.now() - MAX_REPLAY_AGE_MS && value <= Date.now() + MAX_FUTURE_SKEW_MS,
    'Replay event timestamp is outside the accepted window.',
  );

const requestTimestampParam = z.coerce
  .number()
  .int()
  .refine(value => {
    const now = Math.floor(Date.now() / 1000);

    return value >= now - MAX_REPLAY_AGE_MS / 1000 && value <= now + MAX_FUTURE_SKEW_MS / 1000;
  }, 'Replay timestamp is outside the accepted window.');

const replayEventParam = replayObjectParam.and(
  z
    .object({
      timestamp: replayEventTimestampParam.optional(),
    })
    .passthrough(),
);

const coordinateParam = z.coerce.number().finite().nonnegative().max(10_000_000);

const schema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('record'),
    payload: z.object({
      website: z.uuid().transform(value => value.toLowerCase()),
      events: z.array(replayEventParam).max(MAX_RECORD_EVENTS),
      timestamp: requestTimestampParam.optional(),
    }),
  }),
  z.object({
    type: z.literal('heatmap'),
    payload: z.object({
      website: z.uuid().transform(value => value.toLowerCase()),
      events: z
        .array(
          z.discriminatedUnion('type', [
            z
              .object({
                type: z.literal('click'),
                url: urlOrPathParam,
                x: coordinateParam.optional(),
                y: coordinateParam.optional(),
                pageX: coordinateParam.optional(),
                pageY: coordinateParam.optional(),
                pageW: coordinateParam.optional(),
                pageH: coordinateParam.optional(),
                viewportW: coordinateParam.optional(),
                viewportH: coordinateParam.optional(),
                timestamp: replayEventTimestampParam.optional(),
              })
              .strict(),
            z
              .object({
                type: z.literal('scroll'),
                url: urlOrPathParam,
                scrollPct: z.coerce.number().finite().min(0).max(100).optional(),
                pageW: coordinateParam.optional(),
                pageH: coordinateParam.optional(),
                viewportW: coordinateParam.optional(),
                viewportH: coordinateParam.optional(),
                timestamp: replayEventTimestampParam.optional(),
              })
              .strict(),
          ]),
        )
        .max(MAX_RECORD_EVENTS),
      timestamp: requestTimestampParam.optional(),
    }),
  }),
]);

export function OPTIONS() {
  return corsPreflight();
}

export async function POST(request: Request) {
  try {
    const collectionLimit = await getCollectionIpLimit(request);

    if (collectionLimit.blocked) {
      return withCorsHeaders(tooManyRequests(collectionLimit.retryAfter));
    }

    const { body, error } = await parseRequest(request, schema, {
      skipAuth: true,
      maxBodyBytes: MAX_RECORD_REQUEST_BYTES,
      bodyPreflight: body => {
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return false;
        }

        const payload = (body as { payload?: unknown }).payload;

        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          return false;
        }

        const events = (payload as { events?: unknown }).events;

        if (!Array.isArray(events) || events.length > MAX_RECORD_EVENTS) {
          return false;
        }

        return (
          (body as { type?: unknown }).type !== 'heatmap' ||
          events.every(event => {
            if (!event || typeof event !== 'object' || Array.isArray(event)) {
              return false;
            }

            const keys = Object.keys(event);

            return keys.length <= 16 && keys.every(key => key.length <= 32);
          })
        );
      },
    });

    if (error) {
      return withCorsHeaders(error());
    }

    const { website: websiteId } = body.payload;
    const events = body.payload.events;
    const timestamp = body.payload.timestamp;
    if (!events?.length) {
      return withCorsHeaders(json({ ok: true }));
    }

    // Parse cache token to get session info
    const cacheHeader = request.headers.get('x-umami-cache');

    if (!cacheHeader) {
      return withCorsHeaders(badRequest({ message: 'Missing session token.' }));
    }

    const cache: CacheToken | null = parseCacheToken(cacheHeader, secret());

    if (
      cache?.type !== CACHE_TOKEN_TYPE ||
      typeof cache.websiteId !== 'string' ||
      cache.websiteId.toLowerCase() !== websiteId ||
      !cache.sessionId ||
      !cache.visitId
    ) {
      return withCorsHeaders(badRequest({ message: 'Invalid session token.' }));
    }

    const sourceStatus = await getCollectionSourceStatus(websiteId);

    if (sourceStatus.blocked) {
      return tooManyRequests(sourceStatus.retryAfter);
    }

    const { sessionId, visitId } = cache;

    // Query directly to avoid stale Redis cache for recorderEnabled
    const website = await getWebsite(websiteId);

    if (!website || website.deletedAt) {
      return withCorsHeaders(badRequest({ message: 'Website not found.' }));
    }

    if (!website.recorderEnabled) {
      return withCorsHeaders(json({ ok: false, reason: 'recorder_disabled' }));
    }

    if (isEnvEnabled('CLOUD_MODE')) {
      const account = website.teamId
        ? await fetchTeam(website.teamId)
        : website.userId
          ? await fetchAccount(website.userId)
          : null;

      if (!account?.isBusiness && !account?.isNoBilling) {
        return withCorsHeaders(forbidden({ message: 'Business subscription required.' }));
      }
    }

    // Client info for IP checks
    const { ip } = await getClientInfo(request, {});

    if (hasBlockedIp(ip)) {
      return withCorsHeaders(new Response(null, { status: 204 }));
    }

    const sourceLimit = await getCollectionSourceLimit(websiteId);

    if (sourceLimit.blocked) {
      return tooManyRequests(sourceLimit.retryAfter);
    }

    try {
      const externalWrite = await withActiveCollectionSource(
        'website',
        websiteId,
        async transaction => {
          const currentWebsite = await transaction.website.findFirst({
            where: {
              id: websiteId,
              deletedAt: null,
            },
            select: {
              recorderEnabled: true,
              replayConfig: true,
              userId: true,
              teamId: true,
            },
          });

          if (!currentWebsite?.recorderEnabled) {
            throw new Error('RECORDER_DISABLED');
          }

          const accountId = currentWebsite.teamId || currentWebsite.userId;

          if (!accountId) {
            throw new Error('COLLECTION_SOURCE_OWNER_MISSING');
          }

          const accountType = currentWebsite.teamId ? 'team' : 'user';

          const recorderConfig = getRecorderConfig(currentWebsite.replayConfig);
          if (body.type === 'record') {
            if (recorderConfig.replayEnabled !== true) {
              throw new Error('REPLAY_DISABLED');
            }

            const structureUnits = countReplayStructureUnits(events, undefined, 257);

            if (structureUnits === null) {
              throw new ReplayBudgetExceededError();
            }

            const eventTimestamps = events
              .map((event: any) => Number(event?.timestamp))
              .filter((value: number) => Number.isFinite(value) && value > 0);
            const fallbackMs = (timestamp || Math.floor(Date.now() / 1000)) * 1000;
            const minTimestamp = eventTimestamps.length ? Math.min(...eventTimestamps) : fallbackMs;
            const maxTimestamp = eventTimestamps.length ? Math.max(...eventTimestamps) : fallbackMs;

            const chunkIndex = timestamp || Math.floor(Date.now() / 1000);
            const isNewChunk = await reserveReplayBudget(transaction, {
              websiteId,
              visitId,
              accountType,
              accountId,
              chunkIndex,
              idempotent: timestamp !== undefined,
              bytes: Buffer.byteLength(JSON.stringify(events), 'utf8'),
              events: events.length,
              structureUnits,
            });

            if (!isNewChunk) {
              return null;
            }

            const recording = {
              websiteId,
              sessionId,
              visitId,
              chunkIndex,
              events,
              eventCount: getReplayEventCount(events),
              startedAt: new Date(minTimestamp),
              endedAt: new Date(maxTimestamp),
            };

            if (clickhouse.enabled) {
              return { kind: 'replay' as const, recording, accountType, accountId };
            }

            await saveRecording(recording, transaction);
            return null;
          }

          if (recorderConfig.heatmapEnabled !== true) {
            throw new Error('HEATMAP_DISABLED');
          }

          const fallbackMs = (timestamp || Math.floor(Date.now() / 1000)) * 1000;
          const heatmapRows = events.map(event => ({
            websiteId,
            sessionId,
            visitId,
            eventType:
              event.type === 'click' ? HEATMAP_EVENT_TYPE.click : HEATMAP_EVENT_TYPE.scroll,
            x: event.type === 'click' ? (event.x ?? null) : null,
            y: event.type === 'click' ? (event.y ?? null) : null,
            pageX: event.type === 'click' ? (event.pageX ?? null) : null,
            pageY: event.type === 'click' ? (event.pageY ?? null) : null,
            pageW: event.pageW ?? null,
            viewportW: event.viewportW ?? null,
            viewportH: event.viewportH ?? null,
            pageH: event.pageH ?? null,
            scrollPct: event.type === 'scroll' ? (event.scrollPct ?? null) : null,
            urlPath: getHeatmapUrlPath(event.url),
            createdAt: new Date(event.timestamp ?? fallbackMs),
          }));

          await reserveHeatmapBudget(transaction, {
            websiteId,
            visitId,
            accountType,
            accountId,
            bytes: Buffer.byteLength(JSON.stringify(events), 'utf8'),
            events: events.length,
          });

          if (clickhouse.enabled) {
            return { kind: 'heatmap' as const, heatmapRows, accountType, accountId };
          }

          await saveHeatmapEvents(heatmapRows, transaction);
          return null;
        },
      );

      if (externalWrite) {
        await withActiveCollectionSource('website', websiteId, async transaction => {
          const currentWebsite = await transaction.website.findFirst({
            where: { id: websiteId, deletedAt: null },
            select: { recorderEnabled: true, replayConfig: true, userId: true, teamId: true },
          });

          if (!currentWebsite?.recorderEnabled) {
            throw new Error('RECORDER_DISABLED');
          }

          if (
            (currentWebsite.teamId ? 'team' : 'user') !== externalWrite.accountType ||
            (currentWebsite.teamId || currentWebsite.userId) !== externalWrite.accountId
          ) {
            throw new Error('COLLECTION_SOURCE_OWNER_CHANGED');
          }

          const currentConfig = getRecorderConfig(currentWebsite.replayConfig);

          if (externalWrite.kind === 'replay') {
            if (currentConfig.replayEnabled !== true) {
              throw new Error('REPLAY_DISABLED');
            }

            await saveRecording(externalWrite.recording);
          } else {
            if (currentConfig.heatmapEnabled !== true) {
              throw new Error('HEATMAP_DISABLED');
            }

            await saveHeatmapEvents(externalWrite.heatmapRows);
          }
        });
      }
    } catch (error: any) {
      if (error?.message === 'RECORDER_DISABLED') {
        return withCorsHeaders(json({ ok: false, reason: 'recorder_disabled' }));
      }

      if (error?.message === 'REPLAY_DISABLED') {
        return withCorsHeaders(json({ ok: false, reason: 'replay_disabled' }));
      }

      if (error?.message === 'HEATMAP_DISABLED') {
        return withCorsHeaders(json({ ok: false, reason: 'heatmap_disabled' }));
      }

      if (error?.message === 'COLLECTION_SOURCE_NOT_FOUND') {
        return withCorsHeaders(badRequest({ message: 'Website not found.' }));
      }

      if (error?.message === 'COLLECTION_SOURCE_OWNER_CHANGED') {
        return withCorsHeaders(
          conflict({ message: 'Website ownership changed. Retry collection.' }),
        );
      }

      if (error instanceof ReplayBudgetExceededError) {
        return withCorsHeaders(
          error.retryAfter
            ? tooManyRequests(error.retryAfter)
            : payloadTooLarge({ message: 'Replay budget exceeded.' }),
        );
      }

      if (error instanceof HeatmapBudgetExceededError) {
        return withCorsHeaders(
          error.retryAfter
            ? tooManyRequests(error.retryAfter)
            : payloadTooLarge({ message: 'Heatmap budget exceeded.' }),
        );
      }

      if (error instanceof CollectionBudgetExceededError) {
        return withCorsHeaders(tooManyRequests(error.retryAfter));
      }

      throw error;
    }

    return withCorsHeaders(json({ ok: true }));
  } catch (e) {
    return withCorsHeaders(serverError(e));
  }
}
