import { z } from 'zod';
import clickhouse from '@/lib/clickhouse';
import { getCollectionLimit } from '@/lib/collection-rate-limit';
import { CACHE_TOKEN_TYPE, HEATMAP_EVENT_TYPE } from '@/lib/constants';
import { secret } from '@/lib/crypto';
import { getClientInfo, hasBlockedIp } from '@/lib/detect';
import { isEnvEnabled } from '@/lib/env';
import { getHeatmapUrlPath } from '@/lib/heatmap-url';
import { parseToken } from '@/lib/jwt';
import { fetchAccount, fetchTeam } from '@/lib/load';
import { getRecorderConfig } from '@/lib/recorder';
import { getReplayEventCount } from '@/lib/replay';
import { parseRequest } from '@/lib/request';
import { badRequest, forbidden, json, serverError, tooManyRequests } from '@/lib/response';
import { replayObjectParam, urlOrPathParam } from '@/lib/schema';
import { getWebsite, withActiveCollectionSource } from '@/queries/prisma';
import { saveRecording } from '@/queries/sql';
import { saveHeatmapEvents } from '@/queries/sql/heatmap/saveHeatmapEvents';

interface Cache {
  websiteId: string;
  sessionId: string;
  visitId: string;
  type: string;
}

const MAX_RECORD_REQUEST_BYTES = 1024 * 1024;
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
      website: z.uuid(),
      events: z.array(replayEventParam).max(200),
      timestamp: requestTimestampParam.optional(),
    }),
  }),
  z.object({
    type: z.literal('heatmap'),
    payload: z.object({
      website: z.uuid(),
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
        .max(200),
      timestamp: requestTimestampParam.optional(),
    }),
  }),
]);

export async function POST(request: Request) {
  try {
    const { body, error } = await parseRequest(request, schema, {
      skipAuth: true,
      maxBodyBytes: MAX_RECORD_REQUEST_BYTES,
    });

    if (error) {
      return error();
    }

    const { website: websiteId } = body.payload;
    const events = body.payload.events;
    const timestamp = body.payload.timestamp;
    const collectionLimit = await getCollectionLimit(request, websiteId);

    if (collectionLimit.blocked) {
      return tooManyRequests(collectionLimit.retryAfter);
    }

    if (!events?.length) {
      return json({ ok: true });
    }

    // Parse cache token to get session info
    const cacheHeader = request.headers.get('x-umami-cache');

    if (!cacheHeader) {
      return badRequest({ message: 'Missing session token.' });
    }

    const cache = (await parseToken(cacheHeader, secret())) as Cache | null;

    if (
      cache?.type !== CACHE_TOKEN_TYPE ||
      cache.websiteId !== websiteId ||
      !cache.sessionId ||
      !cache.visitId
    ) {
      return badRequest({ message: 'Invalid session token.' });
    }

    const { sessionId, visitId } = cache;

    // Query directly to avoid stale Redis cache for recorderEnabled
    const website = await getWebsite(websiteId);

    if (!website || website.deletedAt) {
      return badRequest({ message: 'Website not found.' });
    }

    if (!website.recorderEnabled) {
      return json({ ok: false, reason: 'recorder_disabled' });
    }

    if (isEnvEnabled('CLOUD_MODE')) {
      const account = website.teamId
        ? await fetchTeam(website.teamId)
        : website.userId
          ? await fetchAccount(website.userId)
          : null;

      if (!account?.isBusiness && !account?.isNoBilling) {
        return forbidden({ message: 'Business subscription required.' });
      }
    }

    // Client info for IP checks
    const { ip } = await getClientInfo(request, {});

    if (hasBlockedIp(ip)) {
      return new Response(null, { status: 204 });
    }

    try {
      await withActiveCollectionSource('website', websiteId, async transaction => {
        const currentWebsite = await transaction.website.findFirst({
          where: {
            id: websiteId,
            deletedAt: null,
          },
          select: {
            recorderEnabled: true,
            replayConfig: true,
          },
        });

        if (!currentWebsite?.recorderEnabled) {
          throw new Error('RECORDER_DISABLED');
        }

        const recorderConfig = getRecorderConfig(currentWebsite.replayConfig);
        const writeTransaction = clickhouse.enabled ? undefined : transaction;

        if (body.type === 'record') {
          if (recorderConfig.replayEnabled !== true) {
            throw new Error('REPLAY_DISABLED');
          }

          const eventTimestamps = events
            .map((event: any) => Number(event?.timestamp))
            .filter((value: number) => Number.isFinite(value) && value > 0);
          const fallbackMs = (timestamp || Math.floor(Date.now() / 1000)) * 1000;
          const minTimestamp = eventTimestamps.length ? Math.min(...eventTimestamps) : fallbackMs;
          const maxTimestamp = eventTimestamps.length ? Math.max(...eventTimestamps) : fallbackMs;

          await saveRecording(
            {
              websiteId,
              sessionId,
              visitId,
              chunkIndex: timestamp || Math.floor(Date.now() / 1000),
              events,
              eventCount: getReplayEventCount(events),
              startedAt: new Date(minTimestamp),
              endedAt: new Date(maxTimestamp),
            },
            writeTransaction,
          );
          return;
        }

        if (recorderConfig.heatmapEnabled !== true) {
          throw new Error('HEATMAP_DISABLED');
        }

        const fallbackMs = (timestamp || Math.floor(Date.now() / 1000)) * 1000;
        const heatmapRows = events.map(event => ({
          websiteId,
          sessionId,
          visitId,
          eventType: event.type === 'click' ? HEATMAP_EVENT_TYPE.click : HEATMAP_EVENT_TYPE.scroll,
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

        await saveHeatmapEvents(heatmapRows, writeTransaction);
      });
    } catch (error: any) {
      if (error?.message === 'RECORDER_DISABLED') {
        return json({ ok: false, reason: 'recorder_disabled' });
      }

      if (error?.message === 'REPLAY_DISABLED') {
        return json({ ok: false, reason: 'replay_disabled' });
      }

      if (error?.message === 'HEATMAP_DISABLED') {
        return json({ ok: false, reason: 'heatmap_disabled' });
      }

      if (error?.message === 'COLLECTION_SOURCE_NOT_FOUND') {
        return badRequest({ message: 'Website not found.' });
      }

      throw error;
    }

    return json({ ok: true });
  } catch (e) {
    return serverError(e);
  }
}
