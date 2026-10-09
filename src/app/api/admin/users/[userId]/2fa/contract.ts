import { z } from 'zod';
import { defineOperation } from '@/openapi/operation';
import {
  badRequestResponse,
  jsonResponse,
  notFoundResponse,
  serviceUnavailableResponse,
  unauthorizedResponse,
} from '@/openapi/schemas';

const userIdParameter = {
  name: 'userId',
  in: 'path',
  required: true,
  schema: z.string(),
  description: 'ID of the associated user.',
} as const;

const resetTwoFactorOperation = defineOperation({
  method: 'delete',
  path: '/api/admin/users/{userId}/2fa',
  audience: 'internal',
  auth: 'bearer',
  operation: {
    operationId: 'deleteAdminUsersUserId2fa',
    summary: "Reset a user's two-factor authentication",
    description:
      "Removes the specified user's authenticator setup, backup codes, used-code history, and failed-attempt limits. All prior sessions are revoked; the user must sign in again before setting up authentication.",
    tags: ['Administration'],
    parameters: [userIdParameter],
    responses: {
      '200': jsonResponse(
        z.object({
          ok: z.literal(true),
          userId: z.string(),
          reset: z.object({
            twoFactorAuth: z.number().int().nonnegative(),
            backupCodes: z.number().int().nonnegative(),
            otpUsed: z.number().int().nonnegative(),
            rateLimit: z.number().int().nonnegative(),
          }),
        }),
      ),
      '401': unauthorizedResponse,
      '404': notFoundResponse,
    },
  },
});

const getTwoFactorOperation = defineOperation({
  method: 'get',
  path: '/api/admin/users/{userId}/2fa',
  audience: 'internal',
  auth: 'bearer',
  operation: {
    operationId: 'getAdminUsersUserId2fa',
    summary: "Get a user's two-factor status",
    description: 'Returns whether two-factor authentication is enabled for the specified user.',
    tags: ['Administration'],
    parameters: [userIdParameter],
    responses: {
      '200': jsonResponse(z.object({ isEnabled: z.boolean() })),
      '401': unauthorizedResponse,
      '404': notFoundResponse,
    },
  },
});

const setTwoFactorRequirementOperation = defineOperation({
  method: 'post',
  path: '/api/admin/users/{userId}/2fa',
  audience: 'internal',
  auth: 'bearer',
  operation: {
    operationId: 'postAdminUsersUserId2fa',
    summary: "Set a user's two-factor requirement",
    description:
      'Requires or removes a two-factor authentication requirement for the specified user.',
    tags: ['Administration'],
    parameters: [userIdParameter],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: z.object({ required: z.boolean() }) } },
    },
    responses: {
      '200': jsonResponse(
        z.object({ ok: z.literal(true), userId: z.string(), twoFactorRequired: z.boolean() }),
      ),
      '400': badRequestResponse,
      '401': unauthorizedResponse,
      '404': notFoundResponse,
      '503': serviceUnavailableResponse,
    },
  },
});

export const operations = [
  resetTwoFactorOperation,
  getTwoFactorOperation,
  setTwoFactorRequirementOperation,
] as const;
