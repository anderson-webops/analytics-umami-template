import crypto from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import {
  createSecureToken,
  createToken,
  parseAuthToken,
  parseSecureToken,
  parseToken,
} from './jwt';

const SECRET = 'test-secret';

describe('createToken/parseToken', () => {
  test('round-trips a payload with the correct secret', () => {
    const token = createToken({ userId: '123' }, SECRET);
    const parsed = parseToken(token, SECRET) as any;

    expect(parsed.userId).toBe('123');
  });

  test('returns null for an invalid token', () => {
    expect(parseToken('not-a-jwt', SECRET)).toBeNull();
  });

  test('returns null when verified with the wrong secret', () => {
    const token = createToken({ userId: '123' }, SECRET);

    expect(parseToken(token, 'wrong-secret')).toBeNull();
  });
});

describe('createSecureToken/parseSecureToken', () => {
  test('round-trips an encrypted token with the correct secret', async () => {
    const token = await createSecureToken({ userId: '456' }, SECRET);
    const parsed = (await parseSecureToken(token, SECRET)) as any;

    expect(token.startsWith('v2.')).toBe(true);
    expect(parsed.userId).toBe('456');
  });

  test('rejects previously issued legacy envelopes without deriving a key', async () => {
    const salt = Buffer.alloc(64, 1);
    const iv = Buffer.alloc(16, 2);
    const key = crypto.pbkdf2Sync(SECRET, salt, 10000, 32, 'sha512');
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(createToken({ userId: 'legacy' }, SECRET), 'utf8'),
      cipher.final(),
    ]);
    const token = Buffer.concat([salt, iv, cipher.getAuthTag(), encrypted]).toString('base64');

    const deriveKey = vi.spyOn(crypto, 'pbkdf2');

    try {
      expect(await parseSecureToken(token, SECRET)).toBeNull();
      expect(deriveKey).not.toHaveBeenCalled();
    } finally {
      deriveKey.mockRestore();
    }
  });

  test('produces an opaque (encrypted) token, not a raw jwt', async () => {
    const token = await createSecureToken({ userId: '456' }, SECRET);

    expect(token.split('.').length).not.toBe(3);
  });

  test('returns null when parsed with the wrong secret', async () => {
    const token = await createSecureToken({ userId: '456' }, SECRET);

    expect(await parseSecureToken(token, 'wrong-secret')).toBeNull();
  });

  test('returns null for a malformed secure token without deriving a key', async () => {
    const deriveKey = vi.spyOn(crypto, 'pbkdf2');
    const deriveKeySync = vi.spyOn(crypto, 'pbkdf2Sync');

    try {
      expect(await parseSecureToken('garbage', SECRET)).toBeNull();
      expect(deriveKey).not.toHaveBeenCalled();
      expect(deriveKeySync).not.toHaveBeenCalled();
    } finally {
      deriveKey.mockRestore();
      deriveKeySync.mockRestore();
    }
  });

  test('rejects a correctly shaped forged legacy envelope without key derivation', async () => {
    const deriveKey = vi.spyOn(crypto, 'pbkdf2');
    const deriveKeySync = vi.spyOn(crypto, 'pbkdf2Sync');

    try {
      expect(await parseSecureToken(Buffer.alloc(97).toString('base64'), SECRET)).toBeNull();
      expect(deriveKey).not.toHaveBeenCalled();
      expect(deriveKeySync).not.toHaveBeenCalled();
    } finally {
      deriveKey.mockRestore();
      deriveKeySync.mockRestore();
    }
  });

  test('rejects a forged legacy bearer before derivation while accepting a v2 bearer', async () => {
    const deriveKey = vi.spyOn(crypto, 'pbkdf2');
    const request = (token: string) =>
      new Request('https://analytics.example.test/api/me', {
        headers: { Authorization: `Bearer ${token}` },
      });

    try {
      expect(await parseAuthToken(request(Buffer.alloc(97).toString('base64')), SECRET)).toBeNull();
      expect(deriveKey).not.toHaveBeenCalled();

      const validToken = await createSecureToken({ userId: '456' }, SECRET);
      expect(await parseAuthToken(request(validToken), SECRET)).toMatchObject({ userId: '456' });
      expect(deriveKey).not.toHaveBeenCalled();
    } finally {
      deriveKey.mockRestore();
    }
  });
});
