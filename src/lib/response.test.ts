import { afterEach, describe, expect, test, vi } from 'vitest';
import { classifyServerError, serverError } from './response';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('serverError', () => {
  test('does not expose internal error details in the response body', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = serverError(new Error('database exploded'));

    expect(await response.json()).toEqual({
      error: {
        message: 'Server error',
        code: 'server-error',
        status: 500,
      },
    });
  });

  test('does not expose string error details in the response body', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = serverError('Redis is disabled');

    expect(await response.json()).toEqual({
      error: {
        message: 'Server error',
        code: 'server-error',
        status: 500,
      },
    });
  });

  test('logs bounded Prisma model and classic unique-target diagnostics', () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = Object.assign(new Error('private row value'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      meta: {
        modelName: 'Website',
        target: ['websiteId', 'domain'],
      },
    });

    serverError(error);

    expect(logSpy).toHaveBeenCalledWith('Unhandled request error', {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      model: 'Website',
      constraint: 'websiteId,domain',
    });
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain('private row value');
  });

  test('logs the bounded Prisma adapter constraint without query details', () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      message: 'duplicate secret@example.com',
      stack: 'private stack',
      meta: {
        modelName: 'SessionData',
        driverAdapterError: {
          cause: {
            constraint: { index: 'session_data_session_id_data_key_key' },
            originalCode: '23505',
            originalMessage: 'duplicate secret@example.com',
          },
        },
      },
    };

    serverError(error);

    expect(logSpy).toHaveBeenCalledWith('Unhandled request error', {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      model: 'SessionData',
      constraint: 'session_data_session_id_data_key_key',
    });
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain('secret@example.com');
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain('private stack');
  });

  test('drops attacker-controlled diagnostic fields that are not identifiers', () => {
    expect(
      classifyServerError({
        name: 'PrismaClientKnownRequestError\nsecret-name',
        code: 'P2002',
        meta: {
          modelName: 'Website secret-model',
          target: ['domain', 'secret value'],
          driverAdapterError: {
            cause: {
              constraint: { index: 'secret index' },
            },
          },
        },
      }),
    ).toEqual({
      name: 'object',
      code: 'P2002',
    });
  });
});
