import { z } from 'zod';
import { defineOperation } from '@/openapi/operation';
import {
  apiErrorSchema,
  badRequestResponse,
  forbiddenResponse,
  jsonResponse,
  notFoundResponse,
  payloadTooLargeResponse,
  serviceUnavailableResponse,
  unauthorizedResponse,
} from '@/openapi/schemas';
import { confirmTwoFactorSetupSchema } from './schema';

const confirmTwoFactorSetupOperation = defineOperation({
  method: 'post',
  path: '/api/2fa/setup/confirm',
  audience: 'public',
  auth: 'bearer',
  operation: {
    operationId: 'confirmTwoFactorSetup',
    summary: 'Confirm two-factor authentication setup',
    description:
      'Requires the current password and a code from the pending authenticator, enables two-factor authentication, returns new backup codes, and replaces the session cookie with a verified session. Password verification shares a five-attempt, 15-minute account limit with password changes.',
    tags: ['Two-factor authentication'],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: confirmTwoFactorSetupSchema } },
    },
    responses: {
      '200': jsonResponse(
        z.object({ backupCodes: z.array(z.string()) }),
        'Two-factor authentication enabled; save the single-use backup codes.',
      ),
      '400': badRequestResponse,
      '401': unauthorizedResponse,
      '403': forbiddenResponse,
      '404': notFoundResponse,
      '409': jsonResponse(apiErrorSchema, 'Pending setup changed.'),
      '413': payloadTooLargeResponse,
      '429': jsonResponse(
        z.union([
          apiErrorSchema,
          z.object({
            error: z.object({
              code: z.string(),
              message: z.string(),
              lockedUntil: z.iso.datetime().optional(),
            }),
          }),
        ]),
        'Too many verification attempts.',
      ),
      '503': serviceUnavailableResponse,
    },
  },
});

export const operations = [confirmTwoFactorSetupOperation] as const;
