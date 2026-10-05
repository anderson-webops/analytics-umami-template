import crypto from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { decrypt, encrypt, hash, md5, uuid } from './crypto';

describe('encrypt/decrypt', () => {
  test('round-trips a value with the same secret', async () => {
    const secret = 'my-secret';
    const value = 'hello world';

    const encrypted = await encrypt(value, secret);

    expect(encrypted).not.toBe(value);
    expect(await decrypt(encrypted, secret)).toBe(value);
  });

  test('round-trips an empty value', async () => {
    expect(await decrypt(await encrypt('', 'my-secret'), 'my-secret')).toBe('');
  });

  test('produces different ciphertext on each call (random iv/salt)', async () => {
    const secret = 'my-secret';

    expect(await encrypt('same', secret)).not.toBe(await encrypt('same', secret));
  });

  test('fails to decrypt with the wrong secret', async () => {
    const encrypted = await encrypt('secret data', 'right-secret');

    await expect(decrypt(encrypted, 'wrong-secret')).rejects.toThrow();
  });

  test('fails to decrypt tampered ciphertext', async () => {
    const secret = 'my-secret';
    const encrypted = await encrypt('secret data', secret);

    const buf = Buffer.from(encrypted, 'base64');
    buf[buf.length - 1] ^= 0xff;
    const tampered = buf.toString('base64');

    await expect(decrypt(tampered, secret)).rejects.toThrow();
  });

  test('rejects malformed and oversized envelopes before deriving a key', async () => {
    const deriveKey = vi.spyOn(crypto, 'pbkdf2');

    try {
      await expect(decrypt('garbage', 'secret')).rejects.toThrow('Invalid encrypted value');
      await expect(decrypt('A'.repeat(8196), 'secret')).rejects.toThrow('Invalid encrypted value');
      await expect(decrypt(Buffer.alloc(97).toString('base64').slice(1), 'secret')).rejects.toThrow(
        'Invalid encrypted value',
      );
      expect(deriveKey).not.toHaveBeenCalled();
    } finally {
      deriveKey.mockRestore();
    }
  });

  test('bounds concurrent derivations without retaining a waiting queue', async () => {
    const token = await encrypt('value', 'secret');
    const pending = Array.from({ length: 64 }, () => decrypt(token, 'wrong-secret'));

    await expect(decrypt(token, 'secret')).rejects.toThrow('Too many concurrent decryptions');
    await Promise.allSettled(pending);
    await expect(decrypt(token, 'secret')).resolves.toBe('value');
  });
});

describe('hash', () => {
  test('is deterministic for the same input', () => {
    expect(hash('a', 'b', 'c')).toBe(hash('a', 'b', 'c'));
  });

  test('returns a 128-char sha512 hex string', () => {
    expect(hash('umami')).toMatch(/^[0-9a-f]{128}$/);
  });

  test('changes when input changes', () => {
    expect(hash('a')).not.toBe(hash('b'));
  });
});

describe('md5', () => {
  test('is deterministic for the same input', () => {
    expect(md5('a', 'b')).toBe(md5('a', 'b'));
  });

  test('returns a 32-char hex string', () => {
    expect(md5('umami')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('uuid', () => {
  test('returns a v4 uuid with no args', () => {
    vi.stubEnv('USE_UUIDV7', '');

    expect(uuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    vi.unstubAllEnvs();
  });

  test('is deterministic (v5) for the same args', () => {
    vi.stubEnv('APP_SECRET', 'test-secret-that-is-at-least-32-bytes');

    expect(uuid('a', 'b')).toBe(uuid('a', 'b'));

    vi.unstubAllEnvs();
  });

  test('differs for different args', () => {
    vi.stubEnv('APP_SECRET', 'test-secret-that-is-at-least-32-bytes');

    expect(uuid('a')).not.toBe(uuid('b'));

    vi.unstubAllEnvs();
  });
});
