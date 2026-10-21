import { randomUUID } from 'node:crypto';
import { startOfHour } from 'date-fns';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import {
  type CacheToken,
  createCacheToken,
  hasCurrentCacheGeneration,
  parseCacheToken,
} from '@/lib/cache-token';
import clickhouse from '@/lib/clickhouse';
import { CollectionBudgetExceededError } from '@/lib/collection-budget';
import {
  CollectionRequestReplayError,
  type CollectionScope,
  getBackendCollectionRequest,
} from '@/lib/collection-proof';
import { getCollectionIpLimit, getCollectionSourceStatus } from '@/lib/collection-rate-limit';
import {
  CACHE_TOKEN_TYPE,
  COLLECTION_TRUST_TIER,
  COLLECTION_TYPE,
  EVENT_TYPE,
  FIELD_LENGTH,
} from '@/lib/constants';
import { corsPreflight, withTrackingOrigin } from '@/lib/cors';
import { getSalt, hash, secret, uuid } from '@/lib/crypto';
import { isUnsafeSpreadsheetValue } from '@/lib/csv';
import { getClientInfo, hasBlockedIp } from '@/lib/detect';
import { isEnvEnabled } from '@/lib/env';
import { truncateString } from '@/lib/format';
import { getIpAddress } from '@/lib/ip';
import { fetchWebsite } from '@/lib/load';
import { parseRequest } from '@/lib/request';
import {
  badRequest,
  conflict,
  forbidden,
  json,
  serverError,
  serviceUnavailable,
  tooManyRequests,
} from '@/lib/response';
import { hasRevenueField, isFinancialEventName } from '@/lib/revenue-provenance';
import { analyticsDataParam, domainParam, urlOrPathParam } from '@/lib/schema';
import { getCacheTokenTtlSeconds, isAllowedTrackingHostname } from '@/lib/security';
import { getAllowedTrackingOrigin } from '@/lib/tracking-origin';
import { safeDecodeURI, safeDecodeURIComponent } from '@/lib/url';
import {
  getLink,
  getPixel,
  reserveActiveCollectionBudget,
  reserveBackendCollectionRequest,
  withActiveCollectionSource,
} from '@/queries/prisma';
import {
  createSession,
  publishSessionLink,
  saveEvent,
  saveSessionData,
  saveSessionLink,
  updateSession,
} from '@/queries/sql';
import { sanitizeTrackingUrl } from '@/tracker/url-privacy';

const MAX_ATTRIBUTION_VALUE_LENGTH = 255;
function logSessionLinkError(error: unknown) {
  const name = error instanceof Error ? error.name : typeof error;
  const rawCode = typeof error === 'object' && error && 'code' in error ? error.code : undefined;
  const code =
    typeof rawCode === 'string' && /^[A-Za-z0-9_-]{1,50}$/.test(rawCode) ? rawCode : undefined;

  console.error('Failed to save session link', { name, ...(code ? { code } : {}) });
}
const truncateAttributionValue = (value?: string | null) =>
  value?.slice(0, MAX_ATTRIBUTION_VALUE_LENGTH);
const safeStringParam = (maxLength: number) =>
  z
    .string()
    .max(maxLength)
    .refine((value: string): boolean => !isUnsafeSpreadsheetValue(value), {
      message: 'Value must not start with a spreadsheet formula or control character',
    });

const timestampParam = z.coerce
  .number()
  .int()
  .refine(
    value => {
      const now = Math.floor(Date.now() / 1000);

      return value >= now - 30 * 24 * 60 * 60 && value <= now + 5 * 60;
    },
    { message: 'Timestamp is outside the accepted collection window.' },
  );

const schema = z
  .object({
    type: z.enum(['event', 'identify', 'performance']),
    payload: z
      .object({
        website: z
          .uuid()
          .transform(value => value.toLowerCase())
          .optional(),
        link: z
          .uuid()
          .transform(value => value.toLowerCase())
          .optional(),
        pixel: z
          .uuid()
          .transform(value => value.toLowerCase())
          .optional(),
        data: analyticsDataParam.optional(),
        hostname: domainParam.refine(value => value.length <= 253).optional(),
        language: z.string().max(35).optional(),
        referrer: urlOrPathParam.optional(),
        screen: z.string().max(11).optional(),
        title: z.string().max(500).optional(),
        url: urlOrPathParam.optional(),
        name: safeStringParam(50)
          .refine(value => /[\p{L}\p{N}\p{P}\p{S}]/u.test(value), {
            message: 'Event name must contain a visible character.',
          })
          .optional(),
        tag: safeStringParam(50).optional(),
        ip: z.string().max(64).optional(),
        userAgent: z.string().max(512).optional(),
        timestamp: timestampParam.optional(),
        id: z.string().max(50).optional(),
        sessionSeed: z.uuid().optional(),
        browser: z.string().max(20).optional(),
        os: z.string().max(20).optional(),
        device: z.string().max(20).optional(),
        lcp: z.number().nonnegative().max(60000).optional(),
        inp: z.number().nonnegative().max(60000).optional(),
        cls: z.number().nonnegative().max(100).optional(),
        fcp: z.number().nonnegative().max(60000).optional(),
        ttfb: z.number().nonnegative().max(60000).optional(),
      })
      .strict()
      .refine(
        data => {
          const keys = [data.website, data.link, data.pixel];
          const count = keys.filter(Boolean).length;
          return count === 1;
        },
        {
          message: 'Exactly one of website, link, or pixel must be provided',
          path: ['website'],
        },
      ),
  })
  .strict()
  .refine(data => data.type === 'event' || !!data.payload.website, {
    message: 'Identify and performance events require a website.',
    path: ['payload', 'website'],
  })
  .superRefine((data, ctx) => {
    if (data.payload.website && !data.payload.hostname) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Website events require a hostname.',
        path: ['payload', 'hostname'],
      });
    }

    if (data.type === COLLECTION_TYPE.event && data.payload.data && !data.payload.name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Event properties require a named custom event.',
        path: ['payload', 'name'],
      });
    }

    if (
      data.type === COLLECTION_TYPE.event &&
      !data.payload.name &&
      data.payload.id !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Pageviews cannot carry an identity; use identify instead.',
        path: ['payload', 'id'],
      });
    }

    if (
      (data.type === COLLECTION_TYPE.performance &&
        (data.payload.id !== undefined ||
          data.payload.name !== undefined ||
          data.payload.data !== undefined)) ||
      (data.type === COLLECTION_TYPE.identify && data.payload.name !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'This collection type does not accept unrelated tracking fields.',
        path: ['payload'],
      });
    }

    const { currency, revenue } = data.payload.data || {};

    if (currency !== undefined || revenue !== undefined) {
      if (!data.payload.name) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Revenue data requires a named custom event.',
          path: ['payload', 'name'],
        });
      }

      if (
        typeof currency !== 'string' ||
        !/^[A-Za-z]{3}$/.test(currency) ||
        typeof revenue !== 'number' ||
        revenue <= 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Revenue data requires a positive amount and a three-letter currency code.',
          path: ['payload', 'data'],
        });
      }
    }
  });

export function OPTIONS() {
  return corsPreflight({
    'Access-Control-Allow-Headers':
      'Content-Type, X-Umami-Cache, X-Umami-Hostname, X-Umami-Website-Id',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  });
}

export async function POST(request: Request) {
  try {
    const collectionLimit = await getCollectionIpLimit(request);

    if (collectionLimit.blocked) {
      return tooManyRequests(collectionLimit.retryAfter);
    }

    const { body, error } = await parseRequest(request, schema, {
      skipAuth: true,
      maxBodyBytes: 128 * 1024,
    });

    if (error) {
      return error();
    }

    const { type, payload } = body;

    const {
      website: websiteId,
      pixel: pixelId,
      link: linkId,
      hostname,
      screen,
      language,
      url,
      referrer,
      name,
      data,
      title,
      tag,
      timestamp,
      id,
      sessionSeed,
      lcp,
      inp,
      cls,
      fcp,
      ttfb,
    } = payload;

    const sourceId = websiteId || pixelId || linkId;
    const sourceType = websiteId ? 'website' : linkId ? 'link' : 'pixel';
    const sourceStatus = await getCollectionSourceStatus(sourceId);

    if (sourceStatus.blocked) {
      return tooManyRequests(sourceStatus.retryAfter);
    }

    const requiredScopes: CollectionScope[] = [];

    if (type === COLLECTION_TYPE.identify || id !== undefined) {
      requiredScopes.push('identity');
    }

    if (type === COLLECTION_TYPE.event && (name !== undefined || data !== undefined)) {
      requiredScopes.push('event');
    }

    if (timestamp !== undefined && requiredScopes.length === 0) {
      requiredScopes.push('event');
    }

    if (data && hasRevenueField(data, isFinancialEventName(name))) {
      requiredScopes.push('revenue');
    }

    if (requiredScopes.includes('revenue')) {
      return forbidden({ message: 'Verified revenue integration is not enabled.' });
    }

    const backendRequest =
      requiredScopes.length && websiteId
        ? getBackendCollectionRequest(request, websiteId, requiredScopes)
        : null;
    const backendKeyDigest = backendRequest?.keyDigest;

    if (requiredScopes.length && !backendKeyDigest) {
      return forbidden({ message: 'Backend collection authorization required.' });
    }

    // Cache check
    let cache: CacheToken | null = null;
    let allowedOrigin: string | null = null;

    if (websiteId) {
      const cacheHeader = request.headers.get('x-umami-cache');

      if (cacheHeader && !backendKeyDigest) {
        const result = parseCacheToken(cacheHeader, secret());

        if (
          result?.type === CACHE_TOKEN_TYPE &&
          typeof result.websiteId === 'string' &&
          result.websiteId.toLowerCase() === websiteId
        ) {
          cache = result;
        }
      }

      const website = await fetchWebsite(websiteId);

      if (!website || !isAllowedTrackingHostname(website.domain, hostname, url)) {
        return badRequest({ message: 'Tracking source not found.' });
      }

      const requestOrigin = request.headers.get('origin');

      if (requestOrigin) {
        allowedOrigin = getAllowedTrackingOrigin(requestOrigin, website.domain);

        if (!allowedOrigin) {
          return badRequest({ message: 'Tracking source not found.' });
        }
      }
    } else if (linkId) {
      const link = await getLink(linkId);

      if (!link || link.deletedAt) {
        return badRequest({ message: 'Tracking source not found.' });
      }
    } else if (pixelId) {
      const pixel = await getPixel(pixelId);

      if (!pixel || pixel.deletedAt) {
        return badRequest({ message: 'Tracking source not found.' });
      }
    }

    // Carried forward in the cache token so repeat identify calls skip identity writes.
    let sessionLinkId = cache?.sessionLinkId;

    // Client info
    const {
      ip,
      userAgent,
      device,
      browser,
      os,
      country,
      region,
      city,
      isBot,
      botName,
      botCategory,
    } = await getClientInfo(request, payload);

    // IP block
    if (hasBlockedIp(ip)) {
      return new Response(null, { status: 204 });
    }

    let collectionGeneration: number | undefined;
    let reservedSource: Awaited<ReturnType<typeof reserveActiveCollectionBudget>>;

    try {
      reservedSource = await reserveActiveCollectionBudget(
        sourceType,
        sourceId,
        body,
        getIpAddress(request.headers) || 'unknown',
        backendKeyDigest ? 'backend' : 'anonymous',
        ...(backendRequest ? [backendRequest] : []),
        ...(backendRequest ? [!clickhouse.enabled] : []),
      );

      if (websiteId) {
        if (
          typeof reservedSource.collectionGeneration !== 'number' ||
          !Number.isSafeInteger(reservedSource.collectionGeneration) ||
          reservedSource.collectionGeneration < 0
        ) {
          throw new Error('COLLECTION_SOURCE_GENERATION_MISSING');
        }

        collectionGeneration = reservedSource.collectionGeneration;

        if (cache && !hasCurrentCacheGeneration(cache, collectionGeneration)) {
          cache = null;
          sessionLinkId = undefined;
        }
      }
    } catch (error: any) {
      if (error instanceof CollectionRequestReplayError) {
        return conflict({ message: 'Backend collection request already accepted.' });
      }
      if (error instanceof CollectionBudgetExceededError) {
        return tooManyRequests(error.retryAfter);
      }

      if (error?.message === 'COLLECTION_SOURCE_NOT_FOUND') {
        return badRequest({ message: 'Tracking source not found.' });
      }

      if (error?.message === 'COLLECTION_KEY_OWNER_CHANGED') {
        return forbidden({ message: 'Backend collection authorization required.' });
      }

      throw error;
    }

    const createdAt = timestamp ? new Date(timestamp * 1000) : new Date();
    const now = Math.floor(Date.now() / 1000);
    const distinctId = truncateString(id, FIELD_LENGTH.distinctId);

    const saltRotation = process.env.SALT_ROTATION || 'month';
    const sessionSalt = getSalt(saltRotation, createdAt);
    const visitSalt = hash(startOfHour(createdAt).toUTCString());

    const identityHash = hash(distinctId ?? '');
    const sessionSourceId =
      websiteId && collectionGeneration
        ? `${sourceId}:generation:${collectionGeneration}`
        : sourceId;
    const sessionId = backendKeyDigest
      ? sessionSeed || distinctId
        ? uuid(
            'verified-collection-v2',
            sessionSourceId,
            sessionSeed ?? '',
            distinctId ?? '',
            sessionSalt,
          )
        : randomUUID()
      : !websiteId
        ? uuid(sourceId, ip, userAgent, sessionSalt, distinctId ?? '')
        : sessionSeed
          ? uuid(sessionSourceId, sessionSeed, sessionSalt, distinctId ?? '')
          : cache?.identityHash === identityHash && cache.sessionSalt === sessionSalt
            ? cache.sessionId
            : randomUUID();
    const sessionDrift = !!websiteId && !!cache?.sessionId && cache.sessionId !== sessionId;
    const shouldEnsureSession = !clickhouse.enabled && sessionDrift;

    if (sessionDrift) {
      sessionLinkId = undefined;
    }

    // Visit info
    let visitId = cache?.visitId || uuid(sessionId, visitSalt);
    let iat = cache?.iat || now;

    // A drifted cache session starts a fresh visit on the recomputed session.
    if (sessionDrift) {
      visitId = uuid(sessionId, visitSalt);
      iat = now;
    }

    // Expire visit after 30 minutes
    if (!timestamp && now - iat > 1800) {
      visitId = uuid(sessionId, visitSalt);
      iat = now;
    }

    let pendingClickhouseLink: Parameters<typeof saveSessionLink>[0] | undefined;
    const persistCollection = async (
      sourceTransaction: Prisma.TransactionClient,
      transaction?: Prisma.TransactionClient,
    ) => {
      // Create a session if not found.
      if ((!clickhouse.enabled && !cache?.sessionId) || shouldEnsureSession) {
        await createSession(
          {
            id: sessionId,
            websiteId: sourceId,
            browser,
            os,
            device,
            screen,
            language,
            country,
            region,
            city,
            isBot,
            botName,
            botCategory,
            distinctId,
            createdAt,
          },
          transaction,
        );
      }

      if (type === COLLECTION_TYPE.event) {
        const base = hostname ? `https://${hostname}` : 'https://localhost';
        const currentUrl = sanitizeTrackingUrl(new URL(url, base));

        let urlPath = currentUrl.pathname === '/undefined' ? '' : currentUrl.pathname;
        const urlQuery = currentUrl.search.substring(1);
        const urlDomain = currentUrl.hostname.replace(/^www\./, '');

        let referrerPath: string;
        let referrerQuery: string;
        let referrerDomain: string;

        // UTM Params
        const utmSource = truncateAttributionValue(currentUrl.searchParams.get('utm_source'));
        const utmMedium = truncateAttributionValue(currentUrl.searchParams.get('utm_medium'));
        const utmCampaign = truncateAttributionValue(currentUrl.searchParams.get('utm_campaign'));
        const utmContent = truncateAttributionValue(currentUrl.searchParams.get('utm_content'));
        const utmTerm = truncateAttributionValue(currentUrl.searchParams.get('utm_term'));

        // Click IDs
        const gclid = truncateAttributionValue(currentUrl.searchParams.get('gclid'));
        const fbclid = truncateAttributionValue(currentUrl.searchParams.get('fbclid'));
        const msclkid = truncateAttributionValue(currentUrl.searchParams.get('msclkid'));
        const ttclid = truncateAttributionValue(currentUrl.searchParams.get('ttclid'));
        const lifatid = truncateAttributionValue(currentUrl.searchParams.get('li_fat_id'));
        const twclid = truncateAttributionValue(currentUrl.searchParams.get('twclid'));

        if (isEnvEnabled('REMOVE_TRAILING_SLASH')) {
          // Never strip the root slash, otherwise the home page is saved with an empty path.
          urlPath = urlPath.replace(/(?!^)\/(?=(#.*)?$)/, '');
        }

        if (referrer) {
          let eventDomain = urlDomain;
          if (hostname) {
            try {
              eventDomain = new URL(`https://${hostname}`).hostname.replace(/^www\./, '');
            } catch {
              eventDomain = hostname.replace(/^www\./, '');
            }
          }
          const referrerUrl = sanitizeTrackingUrl(
            new URL(referrer, eventDomain ? `https://${eventDomain}` : base),
            false,
          );

          referrerPath = referrerUrl.pathname;
          referrerQuery = referrerUrl.search.substring(1);
          referrerDomain = referrerUrl.hostname.replace(/^www\./, '');

          if (referrerDomain === eventDomain) {
            referrerDomain = undefined;
          }
        }

        const eventType = linkId
          ? EVENT_TYPE.linkEvent
          : pixelId
            ? EVENT_TYPE.pixelEvent
            : name
              ? EVENT_TYPE.customEvent
              : EVENT_TYPE.pageView;

        await saveEvent(
          {
            websiteId: sourceId,
            sessionId,
            visitId,
            eventType,
            trustTier:
              eventType === EVENT_TYPE.customEvent && backendKeyDigest
                ? COLLECTION_TRUST_TIER.backendAuthorized
                : COLLECTION_TRUST_TIER.unverified,
            createdAt,

            // Page
            pageTitle: safeDecodeURIComponent(title),
            hostname: hostname || urlDomain,
            urlPath: safeDecodeURI(urlPath),
            urlQuery,
            referrerPath: safeDecodeURI(referrerPath),
            referrerQuery,
            referrerDomain,

            // Session
            distinctId,
            browser,
            os,
            device,
            screen,
            language,
            country,
            region,
            city,
            isBot,
            botName,
            botCategory,

            // Events
            eventName: name,
            eventData: data,
            tag,

            // UTM
            utmSource,
            utmMedium,
            utmCampaign,
            utmContent,
            utmTerm,

            // Click IDs
            gclid,
            fbclid,
            msclkid,
            ttclid,
            lifatid,
            twclid,
          },
          transaction,
        );
      } else if (type === COLLECTION_TYPE.identify) {
        if (websiteId && distinctId) {
          const newLinkId = hash(sessionId, distinctId);

          if (sessionLinkId !== newLinkId) {
            try {
              const linked = await saveSessionLink(
                {
                  websiteId,
                  sessionId,
                  distinctId,
                  createdAt,
                },
                sourceTransaction,
              );

              if (linked) {
                if (clickhouse.enabled) {
                  pendingClickhouseLink = { websiteId, sessionId, distinctId, createdAt };
                } else {
                  await updateSession(
                    {
                      websiteId,
                      sessionId,
                      distinctId,
                    },
                    transaction,
                  );
                  sessionLinkId = newLinkId;
                }
              }
            } catch (error) {
              logSessionLinkError(error);
              throw new Error('IDENTITY_LINK_WRITE_UNAVAILABLE');
            }
          }
        }

        if (data) {
          await saveSessionData(
            {
              websiteId,
              sessionId,
              sessionData: data,
              trustTier: COLLECTION_TRUST_TIER.backendAuthorized,
              distinctId,
              createdAt,
            },
            transaction,
          );
        }
      } else if (type === COLLECTION_TYPE.performance) {
        const base = hostname ? `https://${hostname}` : 'https://localhost';
        const currentUrl = new URL(url, base);
        const urlPath = currentUrl.pathname === '/undefined' ? '' : currentUrl.pathname;

        await saveEvent(
          {
            websiteId: sourceId,
            sessionId,
            visitId,
            urlPath,
            pageTitle: safeDecodeURIComponent(title),
            eventType: EVENT_TYPE.performance,
            trustTier: COLLECTION_TRUST_TIER.unverified,
            browser,
            os,
            device,
            screen,
            language,
            country,
            region,
            city,
            lcp,
            inp,
            cls,
            fcp,
            ttfb,
            createdAt,
          },
          transaction,
        );
      }
    };

    try {
      await withActiveCollectionSource(
        sourceType,
        sourceId,
        async transaction => {
          if (websiteId) {
            const currentWebsite = await transaction.website.findFirst({
              where: {
                id: websiteId,
                deletedAt: null,
              },
              select: {
                domain: true,
                collectionGeneration: true,
              },
            });

            if (!isAllowedTrackingHostname(currentWebsite?.domain, hostname, url)) {
              throw new Error('COLLECTION_SOURCE_NOT_FOUND');
            }

            if (currentWebsite?.collectionGeneration !== collectionGeneration) {
              throw new Error('COLLECTION_SOURCE_CHANGED');
            }

            if (backendRequest && !clickhouse.enabled) {
              await reserveBackendCollectionRequest(transaction, websiteId, backendRequest);
            }
          }

          await persistCollection(transaction, clickhouse.enabled ? undefined : transaction);
        },
        backendRequest || undefined,
        reservedSource,
      );
    } catch (error: any) {
      if (error instanceof CollectionRequestReplayError) {
        return conflict({ message: 'Backend collection request already accepted.' });
      }
      if (error?.message === 'COLLECTION_SOURCE_NOT_FOUND') {
        return badRequest({ message: 'Tracking source not found.' });
      }
      if (error?.message === 'COLLECTION_SOURCE_CHANGED') {
        return conflict({ message: 'Tracking source changed; retry.' });
      }
      if (error?.message === 'COLLECTION_KEY_OWNER_CHANGED') {
        return forbidden({ message: 'Backend collection authorization required.' });
      }

      if (error?.message === 'IDENTITY_LINK_WRITE_UNAVAILABLE') {
        return serviceUnavailable({ code: 'identity-link-unavailable' });
      }

      throw error;
    }

    if (pendingClickhouseLink) {
      try {
        await withActiveCollectionSource(
          'website',
          pendingClickhouseLink.websiteId,
          async () => publishSessionLink(pendingClickhouseLink),
          backendRequest || undefined,
        );
        sessionLinkId = hash(pendingClickhouseLink.sessionId, pendingClickhouseLink.distinctId);
      } catch (error) {
        if (error instanceof Error && error.message === 'COLLECTION_KEY_OWNER_CHANGED') {
          return forbidden({ message: 'Backend collection authorization required.' });
        }
        if (error instanceof Error && error.message === 'COLLECTION_SOURCE_NOT_FOUND') {
          return badRequest({ message: 'Tracking source not found.' });
        }
        logSessionLinkError(error);
        return serviceUnavailable({ code: 'identity-link-unavailable' });
      }
    }

    const token =
      websiteId && !backendKeyDigest
        ? createCacheToken(
            {
              websiteId,
              sessionId,
              visitId,
              collectionGeneration,
              iat,
              identityHash,
              sessionSalt,
              sessionLinkId,
            },
            secret(),
            getCacheTokenTtlSeconds(),
          )
        : null;
    return withTrackingOrigin(json({ cache: token }), websiteId ? allowedOrigin : '*');
  } catch (e) {
    return serverError(e);
  }
}
