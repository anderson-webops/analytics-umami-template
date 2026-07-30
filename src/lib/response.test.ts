import { describe, expect, test, vi } from 'vitest';
import { serverError } from './response';

describe('serverError', () => {
  test('does not expose internal error details in the response body', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = serverError(new Error('database exploded'));

    expect(await response.json()).toEqual({
      error: {
        message: 'Server error',
        code: 'server-error',
        status: 500,
      },
    });

    logSpy.mockRestore();
  });

  test('does not expose string error details in the response body', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = serverError('Redis is disabled');

    expect(await response.json()).toEqual({
      error: {
        message: 'Server error',
        code: 'server-error',
        status: 500,
      },
    });

    logSpy.mockRestore();
  });
});
