import { z } from 'zod';
import { defineOperation } from '@/openapi/operation';
import {
  apiErrorSchema,
  badRequestResponse,
  jsonResponse,
  notFoundResponse,
  payloadTooLargeResponse,
  serviceUnavailableResponse,
  unauthorizedResponse,
} from '@/openapi/schemas';
import { createApiKeySchema } from './schema';

const apiKeyMetadataSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  keyPrefix: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
});

const listApiKeysOperation = defineOperation({
  method: 'get',
  path: '/api/me/api-keys',
  audience: 'public',
  auth: 'bearer',
  operation: {
    operationId: 'getMyApiKeys',
    summary: 'List my API keys',
    description:
      "Returns metadata for the current user's API keys. Available on self-hosted installations.",
    tags: ['Account'],
    responses: {
      '200': jsonResponse(z.array(apiKeyMetadataSchema)),
      '401': unauthorizedResponse,
      '404': notFoundResponse,
    },
  },
});

const createApiKeyOperation = defineOperation({
  method: 'post',
  path: '/api/me/api-keys',
  audience: 'public',
  auth: 'bearer',
  operation: {
    operationId: 'createMyApiKey',
    summary: 'Create an API key',
    description:
      'Verifies the current password, then creates a named API key for the current user and returns its secret value once. Password verification shares a five-attempt, 15-minute account limit with other sensitive account changes. Available on self-hosted installations.',
    tags: ['Account'],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: createApiKeySchema } },
    },
    responses: {
      '200': jsonResponse(
        apiKeyMetadataSchema.omit({ lastUsedAt: true }).extend({ key: z.string() }),
        'API key created; its secret is returned only once.',
      ),
      '400': badRequestResponse,
      '401': unauthorizedResponse,
      '404': notFoundResponse,
      '413': payloadTooLargeResponse,
      '429': jsonResponse(apiErrorSchema, 'Too many password attempts.'),
      '503': serviceUnavailableResponse,
    },
  },
});

export const operations = [listApiKeysOperation, createApiKeyOperation] as const;
