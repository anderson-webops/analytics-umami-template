import { z } from 'zod';
import { defineOperation } from '@/openapi/operation';
import {
  apiErrorSchema,
  badRequestResponse,
  forbiddenResponse,
  jsonResponse,
  payloadTooLargeResponse,
  serverErrorResponse,
} from '@/openapi/schemas';
import { attestedRevenueMovementSchema } from './schema';

const resultSchema = z.object({
  movementId: z.uuid(),
  duplicate: z.boolean(),
  provenance: z.literal('backend_attested'),
});

const operation = defineOperation({
  method: 'post',
  path: '/api/revenue/movements',
  audience: 'collect',
  auth: 'backend-key',
  operation: {
    operationId: 'recordAttestedRevenueMovement',
    summary: 'Submit a website-attested financial movement',
    description:
      'Default-off, capture-only server-to-server intake. Refunds are unsupported pending a reviewed reference and limit contract; these records are not net revenue. A website backend must verify its order or payment before submitting. Requires a website-scoped revenue credential, a fresh request UUID and Unix timestamp in X-Umami-Request-Id and X-Umami-Request-Timestamp, and a stable sourceMovementId for durable idempotency. occurredAt accepts UTC timestamps through millisecond precision. The result is backend-attested, not independently payment-verified, and historical reports remain unverified.',
    tags: ['Collection'],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: attestedRevenueMovementSchema } },
    },
    responses: {
      '200': jsonResponse(resultSchema, 'Identical movement already accepted.'),
      '201': jsonResponse(resultSchema, 'New movement accepted.'),
      '400': badRequestResponse,
      '403': forbiddenResponse,
      '409': jsonResponse(apiErrorSchema, 'Conflicting or replayed movement request.'),
      '413': payloadTooLargeResponse,
      '429': jsonResponse(apiErrorSchema, 'Collection rate limit exceeded.'),
      '500': serverErrorResponse,
    },
  },
});

export const operations = [operation] as const;
