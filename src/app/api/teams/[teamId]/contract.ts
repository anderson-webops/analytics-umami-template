import type { ZodOpenApiOperationObject } from 'zod-openapi';
import { defineOperation } from '@/openapi/operation';

const operation1 = defineOperation({
  method: 'delete',
  path: '/api/teams/{teamId}',
  audience: 'public',
  auth: 'bearer',
  operation: {
    operationId: 'deleteTeam',
    summary: 'Delete a team',
    description: "Deletes the specified team after checking the caller's permission to remove it.",
    tags: ['Teams'],
    parameters: [
      {
        name: 'teamId',
        in: 'path',
        required: true,
        schema: {
          type: 'string',
        },
        description: 'ID of the associated team.',
      },
    ],
    responses: {
      '200': {
        description: 'The operation completed successfully.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                ok: {
                  const: true,
                  description: 'Whether the operation succeeded.',
                },
              },
              required: ['ok'],
            },
          },
        },
      },
      '401': {
        description: 'Unauthorized.',
        content: {
          'application/json': {
            example: {
              error: {
                message: 'Unauthorized.',
                code: 'unauthorized',
                status: 401,
              },
            },
            schema: {
              $ref: '#/components/schemas/ApiError',
            },
          },
        },
      },
      '404': {
        description: 'Not found.',
        content: {
          'application/json': {
            example: {
              error: {
                message: 'Not found.',
                code: 'not-found',
                status: 404,
              },
            },
            schema: {
              $ref: '#/components/schemas/ApiError',
            },
          },
        },
      },
    },
  } as ZodOpenApiOperationObject,
});

const operation2 = defineOperation({
  method: 'get',
  path: '/api/teams/{teamId}',
  audience: 'public',
  auth: 'bearer',
  operation: {
    operationId: 'getTeam',
    summary: 'Get a team',
    description:
      "Returns the specified team's details, including its members. Current team managers, owners and administrators receive the invitation code through an interactive session.",
    tags: ['Teams'],
    parameters: [
      {
        name: 'teamId',
        in: 'path',
        required: true,
        schema: {
          type: 'string',
        },
        description: 'ID of the associated team.',
      },
    ],
    responses: {
      '200': {
        description: 'The operation completed successfully.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                accessCode: {
                  type: ['string', 'null'],
                  description:
                    'Invitation code returned only to current authorized interactive managers, owners, and administrators.',
                },
                id: {
                  type: 'string',
                  description: 'Unique identifier of the resource.',
                },
                createdAt: {
                  type: ['string', 'null'],
                  format: 'date-time',
                  description: 'Date and time the record was created.',
                },
                updatedAt: {
                  type: ['string', 'null'],
                  format: 'date-time',
                  description: 'Date and time the record was last updated.',
                },
                logoUrl: {
                  type: ['string', 'null'],
                  description: 'URL of the logo image.',
                },
                twoFactorRequired: {
                  type: 'boolean',
                  description: 'Whether two-factor authentication is required.',
                },
                deletedAt: {
                  type: ['string', 'null'],
                  format: 'date-time',
                  description: 'Date and time the record was deleted, if applicable.',
                },
                name: {
                  type: 'string',
                  description: 'Display name of the resource.',
                },
              },
              required: [
                'id',
                'createdAt',
                'updatedAt',
                'logoUrl',
                'twoFactorRequired',
                'deletedAt',
                'name',
              ],
            },
          },
        },
      },
      '401': {
        description: 'Unauthorized.',
        content: {
          'application/json': {
            example: {
              error: {
                message: 'Unauthorized.',
                code: 'unauthorized',
                status: 401,
              },
            },
            schema: {
              $ref: '#/components/schemas/ApiError',
            },
          },
        },
      },
      '404': {
        description: 'Not found.',
        content: {
          'application/json': {
            example: {
              error: {
                message: 'Not found.',
                code: 'not-found',
                status: 404,
              },
            },
            schema: {
              $ref: '#/components/schemas/ApiError',
            },
          },
        },
      },
    },
  } as ZodOpenApiOperationObject,
});

const operation3 = defineOperation({
  method: 'post',
  path: '/api/teams/{teamId}',
  audience: 'public',
  auth: 'bearer',
  operation: {
    operationId: 'updateTeam',
    summary: 'Update a team',
    description: "Updates the specified team's name or access code.",
    tags: ['Teams'],
    parameters: [
      {
        name: 'teamId',
        in: 'path',
        required: true,
        schema: {
          type: 'string',
        },
        description: 'ID of the associated team.',
      },
    ],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                minLength: 1,
                maxLength: 50,
                description: 'Display name of the resource.',
              },
              accessCode: {
                type: 'string',
                pattern: '^team_[A-Za-z0-9]{16}$',
                description: 'Code used to join the team.',
              },
            },
          },
        },
      },
    },
    responses: {
      '200': {
        description:
          'Team details with an invitation code only for an authorized interactive session.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                createdAt: { type: ['string', 'null'], format: 'date-time' },
                updatedAt: { type: ['string', 'null'], format: 'date-time' },
                logoUrl: { type: ['string', 'null'] },
                twoFactorRequired: { type: 'boolean' },
                deletedAt: { type: ['string', 'null'], format: 'date-time' },
                accessCode: {
                  type: ['string', 'null'],
                  description:
                    'Invitation code returned only to an authorized interactive manager, owner or administrator.',
                },
              },
              required: [
                'id',
                'name',
                'createdAt',
                'updatedAt',
                'logoUrl',
                'twoFactorRequired',
                'deletedAt',
              ],
            },
          },
        },
      },
      '400': {
        description: 'Bad request.',
        content: {
          'application/json': {
            example: {
              error: {
                message: 'Bad request.',
                code: 'bad-request',
                status: 400,
              },
            },
            schema: {
              $ref: '#/components/schemas/ApiError',
            },
          },
        },
      },
      '401': {
        description: 'Unauthorized.',
        content: {
          'application/json': {
            example: {
              error: {
                message: 'Unauthorized.',
                code: 'unauthorized',
                status: 401,
              },
            },
            schema: {
              $ref: '#/components/schemas/ApiError',
            },
          },
        },
      },
      '404': {
        description: 'Not found.',
        content: {
          'application/json': {
            example: {
              error: {
                message: 'Not found.',
                code: 'not-found',
                status: 404,
              },
            },
            schema: {
              $ref: '#/components/schemas/ApiError',
            },
          },
        },
      },
    },
  } as ZodOpenApiOperationObject,
});

export const operations = [operation1, operation2, operation3] as const;
