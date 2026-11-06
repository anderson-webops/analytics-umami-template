import { describe, expect, test } from 'vitest';
import { redactRequestFailure } from '../helpers/request-error';

describe('API request diagnostic redaction', () => {
  for (const header of [
    'authorization',
    'Proxy-Authorization',
    'cookie',
    'Set-Cookie',
    'x-api-key',
    'x-umami-share-token',
    'x-umami-cache',
    'x-umami-collection-permit',
  ]) {
    test(`redacts ${header} while retaining the operation and transport failure`, () => {
      const failure = new Error(
        `socket hang up (ECONNRESET)\n- GET http://localhost:53100/api/example\n- ${header}: synthetic-sensitive-value\n- accept: application/json`,
      );
      const error = redactRequestFailure(failure);
      expect(error.message).not.toContain('synthetic-sensitive-value');
      expect(error.stack).not.toContain('synthetic-sensitive-value');
      expect(error.message).toContain('ECONNRESET');
      expect(error.message).toContain('GET http://localhost:53100/api/example');
      expect(error.message).toContain('accept: application/json');
      expect(error.cause).toBeUndefined();
    });
  }

  test('redacts URL credentials and sensitive query values', () => {
    const error = redactRequestFailure(
      new Error('GET https://user:synthetic-password@example.test/api?token=synthetic-token&x=1'),
    );
    expect(error.message).toBe('GET https://[redacted]@example.test/api?token=[redacted]&x=1');
  });

  test('redacts authentication JSON values and retains response error codes', () => {
    const error = redactRequestFailure(
      new Error(
        '{"currentPassword":"synthetic-password","token":"synthetic-token","code":"unauthorized"}',
      ),
    );
    expect(error.message).toBe(
      '{"currentPassword":"[redacted]","token":"[redacted]","code":"unauthorized"}',
    );
  });

  test('retains a timeout category without retaining an unredacted cause', () => {
    const failure = new Error('timeout\n- authorization: synthetic-sensitive-value');
    failure.name = 'TimeoutError';
    const error = redactRequestFailure(failure);
    expect(error.name).toBe('TimeoutError');
    expect(error.message).not.toContain('synthetic-sensitive-value');
    expect(error.cause).toBeUndefined();
  });

  test('handles a non-Error transport failure', () => {
    expect(redactRequestFailure('ECONNRESET').message).toBe('ECONNRESET');
  });
});
