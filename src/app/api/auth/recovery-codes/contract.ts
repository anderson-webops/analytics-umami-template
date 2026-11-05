import { z } from 'zod';
import { defineOperation } from '@/openapi/operation';
import {
  apiErrorSchema,
  badRequestResponse,
  forbiddenResponse,
  jsonResponse,
  notFoundResponse,
  serviceUnavailableResponse,
  unauthorizedResponse,
} from '@/openapi/schemas';
import { rotateLoginRecoveryCodesSchema } from './schema';

const status = defineOperation({
  method: 'get',
  path: '/api/auth/recovery-codes',
  audience: 'public',
  auth: 'bearer',
  operation: {
    operationId: 'getLoginRecoveryCodeStatus',
    summary: 'Get login recovery code status',
    tags: ['Authentication'],
    responses: {
      '200': jsonResponse(
        z.object({ remaining: z.number().int().nonnegative() }),
        'Available codes.',
      ),
      '401': unauthorizedResponse,
      '404': notFoundResponse,
    },
  },
});

const rotate = defineOperation({
  method: 'post',
  path: '/api/auth/recovery-codes',
  audience: 'public',
  auth: 'bearer',
  operation: {
    operationId: 'rotateLoginRecoveryCodes',
    summary: 'Rotate login recovery codes',
    description:
      'Requires a current full session and password. Prepares replacement codes without revoking the active set. An administrator may prepare codes for another owner. Pending codes permit bounded password/CAPTCHA/MFA login, but only that owner can confirm possession. Confirming spends the proof code and atomically activates the remaining unused codes, at least one. Issuance and delivery acknowledgement alone do not confirm owner readiness.',
    tags: ['Authentication'],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: rotateLoginRecoveryCodesSchema } },
    },
    responses: {
      '200': jsonResponse(
        z.union([
          z.object({
            recoveryCodes: z.array(z.string()),
            requiresOwnerConfirmation: z.literal(true),
          }),
          z.object({ confirmed: z.literal(true) }),
        ]),
        'Prepared codes or durable owner confirmation.',
      ),
      '400': badRequestResponse,
      '401': unauthorizedResponse,
      '403': forbiddenResponse,
      '404': notFoundResponse,
      '429': jsonResponse(apiErrorSchema, 'Too many password attempts.'),
      '503': serviceUnavailableResponse,
    },
  },
});

export const operations = [status, rotate] as const;
