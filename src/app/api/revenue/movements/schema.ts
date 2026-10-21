import { z } from 'zod';

const uuid = z.uuid().transform(value => value.toLowerCase());

export const attestedRevenueMovementSchema = z
  .object({
    website: uuid,
    source: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
    sourceMovementId: uuid,
    orderId: uuid,
    customerId: uuid.nullable(),
    kind: z.literal('capture'),
    amount: z
      .string()
      .regex(/^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,4})?$/)
      .refine(value => /[1-9]/.test(value)),
    currency: z.string().regex(/^[A-Z]{3}$/),
    occurredAt: z.iso
      .datetime()
      .refine(value => !/\.\d{4}/.test(value))
      .describe('UTC timestamp with at most millisecond precision.'),
  })
  .strict();
