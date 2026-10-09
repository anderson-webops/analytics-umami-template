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
import { initiateTwoFactorSetupSchema } from './schema';

const initiateTwoFactorSetupOperation = defineOperation({
  method: 'post',
  path: '/api/2fa/setup/initiate',
  audience: 'public',
  auth: 'bearer',
  operation: {
    operationId: 'initiateTwoFactorSetup',
    summary: 'Set up two-factor authentication',
    description:
      "Verifies the current password, then starts or replaces only the current user's still-pending setup and returns a QR code and manual setup key for an authenticator app. Password verification shares a five-attempt, 15-minute account limit with password changes and 2FA disablement.",
    tags: ['Two-factor authentication'],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: initiateTwoFactorSetupSchema } },
    },
    responses: {
      '200': jsonResponse(
        z.object({ qrCodeDataUrl: z.string(), manualKey: z.string() }),
        'Pending setup created; store the secret only in the authenticator app.',
      ),
      '400': badRequestResponse,
      '401': unauthorizedResponse,
      '403': forbiddenResponse,
      '404': notFoundResponse,
      '409': jsonResponse(apiErrorSchema, 'Pending setup changed.'),
      '413': payloadTooLargeResponse,
      '429': jsonResponse(apiErrorSchema, 'Too many password attempts.'),
      '503': serviceUnavailableResponse,
    },
  },
});

export const operations = [initiateTwoFactorSetupOperation] as const;
