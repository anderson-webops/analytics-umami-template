import { z } from 'zod';
import { COLLECTION_TYPE } from '@/lib/constants';
import { isUnsafeSpreadsheetValue } from '@/lib/csv';
import { errorCollectionSchema } from '@/lib/errors/schema';
import { analyticsDataParam, domainParam, urlOrPathParam } from '@/lib/schema';

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

const trackingSchema = z
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
        salt: z.string().max(100).optional(),
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

export const collectionSchema = z.union([trackingSchema, errorCollectionSchema]);
