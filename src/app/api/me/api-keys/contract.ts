import { z } from 'zod';
import { API_KEY_PAGE_SIZE, MAX_API_KEYS_PER_USER } from '@/lib/api-key-limits';
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
  expiresAt: z.iso.datetime(),
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
    description: `Returns metadata for the current user's API keys, ${API_KEY_PAGE_SIZE} at a time. Pass the last returned key ID as cursor to read older keys. Available on self-hosted installations.`,
    tags: ['Account'],
    requestParams: { query: z.object({ cursor: z.uuid().optional() }) },
    responses: {
      '200': jsonResponse(z.array(apiKeyMetadataSchema)),
      '400': badRequestResponse,
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
    description: `Verifies the current password and a fresh authenticator code when two-factor authentication is enabled, then creates a named API key for the current user and returns its secret value once. An account may hold at most ${MAX_API_KEYS_PER_USER} keys. New keys expire after 90 days; pre-existing keys receive a 30-day transition period after migration. Password verification shares a five-attempt, 15-minute account limit with other sensitive account changes. Available on self-hosted installations.`,
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
      '409': jsonResponse(apiErrorSchema, 'API key limit reached.'),
      '404': notFoundResponse,
      '413': payloadTooLargeResponse,
      '429': jsonResponse(apiErrorSchema, 'Too many password attempts.'),
      '503': serviceUnavailableResponse,
    },
  },
});

export const operations = [listApiKeysOperation, createApiKeyOperation] as const;
