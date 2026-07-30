import { startOfHour } from 'date-fns';
import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import clickhouse from '@/lib/clickhouse';
import { getCollectionLimit } from '@/lib/collection-rate-limit';
import { CACHE_TOKEN_TYPE, COLLECTION_TYPE, EVENT_TYPE } from '@/lib/constants';
import { getSalt, hash, secret, uuid } from '@/lib/crypto';
import { getClientInfo, hasBlockedIp } from '@/lib/detect';
import { isEnvEnabled } from '@/lib/env';
import { createToken, parseToken } from '@/lib/jwt';
import { fetchWebsite } from '@/lib/load';
import { parseRequest } from '@/lib/request';
import { badRequest, json, serverError, tooManyRequests } from '@/lib/response';
import { analyticsDataParam, domainParam, urlOrPathParam } from '@/lib/schema';
import { getCacheTokenTtlSeconds, isAllowedTrackingHostname } from '@/lib/security';
import { safeDecodeURI, safeDecodeURIComponent } from '@/lib/url';
import { getLink, getPixel, withActiveCollectionSource } from '@/queries/prisma';
import { createSession, saveEvent, saveSessionData } from '@/queries/sql';

interface Cache {
  websiteId: string;
  sessionId: string;
  visitId: string;
  iat: number;
  type: string;
}

// Reject strings whose first character is a spreadsheet formula trigger to
// prevent CSV formula injection in analytics exports (defense-in-depth).
const FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/;
const MAX_ATTRIBUTION_VALUE_LENGTH = 255;
const truncateAttributionValue = (value?: string | null) =>
  value?.slice(0, MAX_ATTRIBUTION_VALUE_LENGTH);
const safeStringParam = (maxLength: number) =>
  z
    .string()
    .max(maxLength)
    .refine(val => !FORMULA_TRIGGER_RE.test(val), {
      message: 'Value must not start with =, +, -, @, tab, or carriage return',
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
        website: z.uuid().optional(),
        link: z.uuid().optional(),
        pixel: z.uuid().optional(),
        data: analyticsDataParam.optional(),
        hostname: domainParam.refine(value => value.length <= 253).optional(),
        language: z.string().max(35).optional(),
        referrer: urlOrPathParam.optional(),
        screen: z.string().max(11).optional(),
        title: z.string().max(500).optional(),
        url: urlOrPathParam.optional(),
        name: safeStringParam(50).optional(),
        tag: safeStringParam(50).optional(),
        ip: z.string().max(64).optional(),
        userAgent: z.string().max(512).optional(),
        timestamp: timestampParam.optional(),
        id: z.string().max(50).optional(),
        browser: z.string().max(20).optional(),
        os: z.string().max(20).optional(),
        device: z.string().max(20).optional(),
        lcp: z.number().nonnegative().max(60000).optional(),
        inp: z.number().nonnegative().max(60000).optional(),
        cls: z.number().nonnegative().max(100).optional(),
        fcp: z.number().nonnegative().max(60000).optional(),
        ttfb: z.number().nonnegative().max(60000).optional(),
      })
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

export async function POST(request: Request) {
  try {
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
      lcp,
      inp,
      cls,
      fcp,
      ttfb,
    } = payload;

    const sourceId = websiteId || pixelId || linkId;
    const sourceType = websiteId ? 'website' : linkId ? 'link' : 'pixel';
    const collectionLimit = await getCollectionLimit(request, sourceId);

    if (collectionLimit.blocked) {
      return tooManyRequests(collectionLimit.retryAfter);
    }

    // Cache check
    let cache: Cache | null = null;

    if (websiteId) {
      const cacheHeader = request.headers.get('x-umami-cache');

      if (cacheHeader) {
        const result = await parseToken(cacheHeader, secret());

        if (result?.type === CACHE_TOKEN_TYPE && result.websiteId === websiteId) {
          cache = result;
        }
      }

      const website = await fetchWebsite(websiteId);

      if (!website || !isAllowedTrackingHostname(website.domain, hostname, url)) {
        return badRequest({ message: 'Tracking source not found.' });
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

    const createdAt = timestamp ? new Date(timestamp * 1000) : new Date();
    const now = Math.floor(Date.now() / 1000);

    const saltRotation = process.env.SALT_ROTATION || 'month';
    const sessionSalt = getSalt(saltRotation, createdAt);
    const visitSalt = hash(startOfHour(createdAt).toUTCString());

    const sessionId = id ? uuid(sourceId, id) : uuid(sourceId, ip, userAgent, sessionSalt);

    // Visit info
    let visitId = cache?.visitId || uuid(sessionId, visitSalt);
    let iat = cache?.iat || now;

    // Expire visit after 30 minutes
    if (!timestamp && now - iat > 1800) {
      visitId = uuid(sessionId, visitSalt);
      iat = now;
    }

    const persistCollection = async (transaction?: Prisma.TransactionClient) => {
      // Create a session if not found.
      if (!clickhouse.enabled && !cache?.sessionId) {
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
            distinctId: id,
            createdAt,
          },
          transaction,
        );
      }

      if (type === COLLECTION_TYPE.event) {
        const base = hostname ? `https://${hostname}` : 'https://localhost';
        const currentUrl = new URL(url, base);

        let urlPath =
          currentUrl.pathname === '/undefined' ? '' : currentUrl.pathname + currentUrl.hash;
        const urlQuery = currentUrl.search.substring(1);
        const urlDomain = currentUrl.hostname.replace(/^www./, '');

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
          urlPath = urlPath.replace(/\/(?=(#.*)?$)/, '');
        }

        if (referrer) {
          const referrerUrl = new URL(referrer, base);

          referrerPath = referrerUrl.pathname;
          referrerQuery = referrerUrl.search.substring(1);
          referrerDomain = referrerUrl.hostname.replace(/^www\./, '');
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
            distinctId: id,
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
        if (data) {
          await saveSessionData(
            {
              websiteId,
              sessionId,
              sessionData: data,
              distinctId: id,
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
      await withActiveCollectionSource(sourceType, sourceId, async transaction => {
        if (websiteId) {
          const currentWebsite = await transaction.website.findFirst({
            where: {
              id: websiteId,
              deletedAt: null,
            },
            select: {
              domain: true,
            },
          });

          if (!isAllowedTrackingHostname(currentWebsite?.domain, hostname, url)) {
            throw new Error('COLLECTION_SOURCE_NOT_FOUND');
          }
        }

        await persistCollection(clickhouse.enabled ? undefined : transaction);
      });
    } catch (error: any) {
      if (error?.message === 'COLLECTION_SOURCE_NOT_FOUND') {
        return badRequest({ message: 'Tracking source not found.' });
      }

      throw error;
    }

    const token = createToken(
      { websiteId, sessionId, visitId, iat, type: CACHE_TOKEN_TYPE },
      secret(),
      { expiresIn: getCacheTokenTtlSeconds() },
    );

    return json({ cache: token, sessionId, visitId });
  } catch (e) {
    return serverError(e);
  }
}
