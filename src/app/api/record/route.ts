import { z } from 'zod';
import { type CacheToken, parseCacheToken } from '@/lib/cache-token';
import clickhouse from '@/lib/clickhouse';
import {
  CollectionBudgetExceededError,
  reserveCollectionClientBudget,
} from '@/lib/collection-budget';
import { getCollectionClientKeys } from '@/lib/collection-client-key';
import { hasCollectionPermit } from '@/lib/collection-permit';
import {
  getCollectionIpLimit,
  getCollectionSourceStatus,
  reserveCollectionSourceLimit,
} from '@/lib/collection-rate-limit';
import { CACHE_TOKEN_TYPE, HEATMAP_EVENT_TYPE } from '@/lib/constants';
import { corsPreflight, withCorsHeaders } from '@/lib/cors';
import { secret } from '@/lib/crypto';
import { getClientInfo, hasBlockedIp } from '@/lib/detect';
import { isEnvEnabled } from '@/lib/env';
import { HeatmapBudgetExceededError, reserveHeatmapBudget } from '@/lib/heatmap-budget';
import { getHeatmapUrlPath } from '@/lib/heatmap-url';
import { getIpAddress } from '@/lib/ip';
import { fetchAccount, fetchTeam } from '@/lib/load';
import { getRecorderConfig } from '@/lib/recorder';
import {
  getReplayEventCount,
  isReplayEventFragment,
  REPLAY_EVENT_FRAGMENT_TYPE,
} from '@/lib/replay';
import {
  getReplayChargedBytes,
  MAX_REPLAY_BYTES,
  markAcknowledgedReplayChunk,
  markUnstoredReplayChunkRetryable,
  ReplayBudgetExceededError,
  ReplayWritePendingError,
  reserveReplayBudget,
} from '@/lib/replay-budget';
import {
  type CompletedReplayFragmentBatch,
  MAX_FRAGMENT_PARTS,
  reassembleReplayFragmentBatch,
} from '@/lib/replay-fragment-buffer';
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
import { saveReassembledRecordingFragments, saveRecording } from '@/queries/sql';
import { saveHeatmapEvents } from '@/queries/sql/heatmap/saveHeatmapEvents';

const MAX_RECORD_REQUEST_BYTES = MAX_REPLAY_BYTES + 2 * 1024 * 1024;
const MAX_RECORD_EVENTS = 200;
const MAX_CONCURRENT_REPLAY_BATCHES = 4;
const MAX_REPLAY_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
let activeReplayBatches = 0;

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
  return corsPreflight({
    'Access-Control-Allow-Headers':
      'Content-Type, x-umami-cache, x-umami-permit, x-umami-record-batch',
  });
}

export async function POST(request: Request) {
  let hasReplayBatchSlot = false;
  try {
    const collectionLimit = await getCollectionIpLimit(request);

    if (collectionLimit.blocked) {
      return withCorsHeaders(tooManyRequests(collectionLimit.retryAfter));
    }

    const cacheHeader = request.headers.get('x-umami-cache');
    const cache: CacheToken | null = cacheHeader ? parseCacheToken(cacheHeader, secret()) : null;
    const permit = request.headers.get('x-umami-permit');
    const batchVersion = request.headers.get('x-umami-record-batch');
    if (batchVersion && batchVersion !== '1') {
      return withCorsHeaders(badRequest({ message: 'Unsupported replay batch version.' }));
    }
    const hasLargeBodyPermit =
      batchVersion === '1' &&
      cache?.type === CACHE_TOKEN_TYPE &&
      !!cache.websiteId &&
      !!cache.sessionId &&
      !!cache.visitId &&
      hasCollectionPermit(permit, cache, 'record', request.headers.get('origin'));
    if (hasLargeBodyPermit) {
      if (activeReplayBatches >= MAX_CONCURRENT_REPLAY_BATCHES) {
        return withCorsHeaders(tooManyRequests(1));
      }
      activeReplayBatches += 1;
      hasReplayBatchSlot = true;
    }

    const { body, error } = await parseRequest(request, schema, {
      skipAuth: true,
      maxBodyBytes: hasLargeBodyPermit ? MAX_RECORD_REQUEST_BYTES : 1024 * 1024,
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

    if (batchVersion === '1' && body.type !== 'record') {
      return withCorsHeaders(badRequest({ message: 'Replay batch requires record events.' }));
    }

    if (!cacheHeader) {
      return withCorsHeaders(badRequest({ message: 'Missing session token.' }));
    }

    if (
      cache?.type !== CACHE_TOKEN_TYPE ||
      typeof cache.websiteId !== 'string' ||
      cache.websiteId.toLowerCase() !== websiteId ||
      !cache.sessionId ||
      !cache.visitId
    ) {
      return withCorsHeaders(badRequest({ message: 'Invalid session token.' }));
    }

    const feature = body.type === 'record' ? 'record' : 'heatmap';

    if (!hasCollectionPermit(permit, cache, feature, request.headers.get('origin'))) {
      return withCorsHeaders(forbidden({ message: 'Recording permission required.' }));
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

    const clientIp = getIpAddress(request.headers) || 'unknown';

    let pendingExternalReplayChunkIndex: number | null = null;
    let pendingExternalReplayGeneration: number | null = null;
    let pendingExternalReplayCharge: { bytes: number; events: number } | null = null;
    let externalSinkStarted = false;
    let completedReplayFragment: CompletedReplayFragmentBatch | null = null;
    let pendingFragmentGeneration: number | null = null;
    let fragmentSinkStarted = false;

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
              domain: true,
              userId: true,
              teamId: true,
              collectionGeneration: true,
            },
          });

          if (
            !currentWebsite ||
            !hasCollectionPermit(
              permit,
              cache,
              feature,
              request.headers.get('origin'),
              currentWebsite,
            )
          ) {
            throw new Error('COLLECTION_PERMIT_EXPIRED');
          }

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
            if (recorderConfig.replayEnabled !== true || recorderConfig.maskLevel !== 'strict') {
              throw new Error('REPLAY_DISABLED');
            }

            if (events.length === 0) {
              if (batchVersion === '1') throw new ReplayBudgetExceededError();
              return null;
            }

            const hasFragment = events.some(event => event?.type === REPLAY_EVENT_FRAGMENT_TYPE);

            if (
              (hasFragment &&
                (batchVersion !== '1' ||
                  timestamp === undefined ||
                  events.length > MAX_FRAGMENT_PARTS ||
                  events.some(event => !isReplayEventFragment(event)))) ||
              (!hasFragment && batchVersion === '1')
            ) {
              throw new ReplayBudgetExceededError();
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
            if (hasFragment) {
              completedReplayFragment = reassembleReplayFragmentBatch({
                websiteId,
                sessionId,
                visitId,
                accountType,
                accountId,
                collectionGeneration: currentWebsite.collectionGeneration,
                chunkIndex,
                events,
              });

              if (!replayEventParam.safeParse(completedReplayFragment.event).success) {
                throw new ReplayBudgetExceededError();
              }
            }

            let chargedBytes = 0;
            let reservedChunks = 0;
            const reservations = completedReplayFragment
              ? completedReplayFragment.reservations
              : [
                  {
                    chunkIndex,
                    bytes: Buffer.byteLength(JSON.stringify(events), 'utf8'),
                    structureUnits,
                  },
                ];
            for (const reservation of reservations) {
              const isNewChunk = await reserveReplayBudget(transaction, {
                websiteId,
                visitId,
                accountType,
                accountId,
                chunkIndex: reservation.chunkIndex,
                idempotent: timestamp !== undefined,
                pendingExternalWrite:
                  hasFragment || (clickhouse.enabled && timestamp !== undefined),
                bytes: reservation.bytes,
                events: hasFragment ? 1 : events.length,
                structureUnits: reservation.structureUnits,
              });

              if (isNewChunk) reservedChunks += 1;
              chargedBytes += getReplayChargedBytes(reservation.bytes, reservation.structureUnits);
            }

            if (hasFragment && reservedChunks !== events.length) {
              throw new ReplayWritePendingError();
            }
            if (!hasFragment && reservedChunks === 0) return null;

            await reserveCollectionClientBudget(
              transaction,
              {
                sourceType: 'website',
                sourceId: websiteId,
                accountType,
                accountId,
                ...getCollectionClientKeys('website', websiteId, accountType, accountId, clientIp),
              },
              'replay',
              {
                bytes: chargedBytes + events.length * 512,
                rows: events.length,
                requests: 1,
              },
            );
            await reserveCollectionSourceLimit(transaction, websiteId, 'recorder');

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

            if (hasFragment) {
              if (!completedReplayFragment) {
                throw new ReplayBudgetExceededError();
              }

              if (!clickhouse.enabled) {
                await saveReassembledRecordingFragments(
                  {
                    websiteId,
                    sessionId,
                    visitId,
                    event: completedReplayFragment.event,
                    parts: completedReplayFragment.parts,
                    startedAt: recording.startedAt,
                    endedAt: recording.endedAt,
                  },
                  transaction,
                );
                for (const part of completedReplayFragment.parts) {
                  await markAcknowledgedReplayChunk(
                    transaction,
                    websiteId,
                    visitId,
                    part.chunkIndex,
                  );
                }
                return null;
              }

              return {
                kind: 'replay-fragment' as const,
                startedAt: recording.startedAt,
                endedAt: recording.endedAt,
                accountType,
                accountId,
                collectionGeneration: currentWebsite.collectionGeneration,
              };
            }

            if (clickhouse.enabled) {
              return {
                kind: 'replay' as const,
                recording,
                accountType,
                accountId,
                collectionGeneration: currentWebsite.collectionGeneration,
                replayCharge: { bytes: chargedBytes, events: events.length },
              };
            }

            await saveRecording(recording, transaction);
            return null;
          }

          if (recorderConfig.heatmapEnabled !== true) {
            throw new Error('HEATMAP_DISABLED');
          }

          if (events.length === 0) {
            return null;
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

          const heatmapBytes = Buffer.byteLength(JSON.stringify(events), 'utf8');
          await reserveHeatmapBudget(transaction, {
            websiteId,
            visitId,
            accountType,
            accountId,
            bytes: heatmapBytes,
            events: events.length,
          });

          await reserveCollectionClientBudget(
            transaction,
            {
              sourceType: 'website',
              sourceId: websiteId,
              accountType,
              accountId,
              ...getCollectionClientKeys('website', websiteId, accountType, accountId, clientIp),
            },
            'heatmap',
            { bytes: heatmapBytes + events.length * 512, rows: events.length, requests: 1 },
          );
          await reserveCollectionSourceLimit(transaction, websiteId, 'recorder');

          if (clickhouse.enabled) {
            return { kind: 'heatmap' as const, heatmapRows, accountType, accountId };
          }

          await saveHeatmapEvents(heatmapRows, transaction);
          return null;
        },
      );

      if (externalWrite) {
        if (externalWrite.kind === 'replay' && timestamp !== undefined) {
          pendingExternalReplayChunkIndex = externalWrite.recording.chunkIndex;
          pendingExternalReplayGeneration = externalWrite.collectionGeneration;
          pendingExternalReplayCharge = externalWrite.replayCharge;
        }

        if (externalWrite.kind === 'replay-fragment') {
          pendingFragmentGeneration = externalWrite.collectionGeneration;
        }

        await withActiveCollectionSource('website', websiteId, async transaction => {
          const currentWebsite = await transaction.website.findFirst({
            where: { id: websiteId, deletedAt: null },
            select: {
              recorderEnabled: true,
              replayConfig: true,
              domain: true,
              userId: true,
              teamId: true,
              collectionGeneration: true,
            },
          });

          if (
            !currentWebsite ||
            !hasCollectionPermit(
              permit,
              cache,
              feature,
              request.headers.get('origin'),
              currentWebsite,
            )
          ) {
            throw new Error('COLLECTION_PERMIT_EXPIRED');
          }

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

          if (externalWrite.kind === 'replay-fragment') {
            if (currentConfig.replayEnabled !== true || currentConfig.maskLevel !== 'strict') {
              throw new Error('REPLAY_DISABLED');
            }

            if (!completedReplayFragment) {
              throw new ReplayBudgetExceededError();
            }

            fragmentSinkStarted = true;
            await saveReassembledRecordingFragments(
              {
                websiteId,
                sessionId,
                visitId,
                event: completedReplayFragment.event,
                parts: completedReplayFragment.parts,
                startedAt: externalWrite.startedAt,
                endedAt: externalWrite.endedAt,
              },
              clickhouse.enabled ? undefined : transaction,
            );
            for (const part of completedReplayFragment.parts) {
              await markAcknowledgedReplayChunk(transaction, websiteId, visitId, part.chunkIndex);
            }
          } else if (externalWrite.kind === 'replay') {
            if (currentConfig.replayEnabled !== true || currentConfig.maskLevel !== 'strict') {
              throw new Error('REPLAY_DISABLED');
            }

            externalSinkStarted = true;
            await saveRecording(externalWrite.recording);
            if (pendingExternalReplayChunkIndex !== null) {
              await markAcknowledgedReplayChunk(
                transaction,
                websiteId,
                visitId,
                pendingExternalReplayChunkIndex,
              );
            }
          } else {
            if (currentConfig.heatmapEnabled !== true) {
              throw new Error('HEATMAP_DISABLED');
            }

            await saveHeatmapEvents(externalWrite.heatmapRows);
          }
        });
      }
    } catch (error: any) {
      if (completedReplayFragment && pendingFragmentGeneration !== null && !fragmentSinkStarted) {
        try {
          await withActiveCollectionSource('website', websiteId, async transaction => {
            const currentWebsite = await transaction.website.findFirst({
              where: { id: websiteId, deletedAt: null },
              select: { collectionGeneration: true },
            });

            if (currentWebsite?.collectionGeneration === pendingFragmentGeneration) {
              for (const charge of completedReplayFragment.charges) {
                await markUnstoredReplayChunkRetryable(
                  transaction,
                  websiteId,
                  visitId,
                  charge.chunkIndex,
                  charge,
                );
              }
            }
          });
        } catch {
          return withCorsHeaders(serverError(new Error('Replay reservation recovery failed.')));
        }
      }

      if (
        pendingExternalReplayChunkIndex !== null &&
        pendingExternalReplayGeneration !== null &&
        pendingExternalReplayCharge !== null &&
        (!externalSinkStarted || error?.code === 'KAFKA_MESSAGE_TOO_LARGE') &&
        error?.message !== 'COLLECTION_SOURCE_NOT_FOUND'
      ) {
        const chunkIndex = pendingExternalReplayChunkIndex;
        const charge = pendingExternalReplayCharge;

        try {
          await withActiveCollectionSource('website', websiteId, async transaction => {
            const currentWebsite = await transaction.website.findFirst({
              where: { id: websiteId, deletedAt: null },
              select: { collectionGeneration: true },
            });

            if (currentWebsite?.collectionGeneration === pendingExternalReplayGeneration) {
              await markUnstoredReplayChunkRetryable(
                transaction,
                websiteId,
                visitId,
                chunkIndex,
                charge,
              );
            }
          });
        } catch {
          return withCorsHeaders(serverError(new Error('Replay reservation recovery failed.')));
        }
      }

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

      if (error?.message === 'COLLECTION_PERMIT_EXPIRED') {
        return withCorsHeaders(forbidden({ message: 'Recording permission required.' }));
      }

      if (error instanceof ReplayWritePendingError) {
        return withCorsHeaders(conflict({ message: 'Replay write is pending reconciliation.' }));
      }

      if (error?.code === 'KAFKA_MESSAGE_TOO_LARGE') {
        return withCorsHeaders(
          payloadTooLarge({ message: 'Replay payload exceeds transport limit.' }),
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
    } finally {
      completedReplayFragment?.release();
    }

    return withCorsHeaders(json({ ok: true }));
  } catch (e) {
    return withCorsHeaders(serverError(e));
  } finally {
    if (hasReplayBatchSlot) activeReplayBatches -= 1;
  }
}
