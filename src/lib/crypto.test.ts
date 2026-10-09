import crypto from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { decrypt, encrypt, hash, md5, uuid } from './crypto';

function createLegacyEnvelope(value: string, secret: string): string {
  const salt = Buffer.alloc(64, 1);
  const iv = Buffer.alloc(16, 2);
  const key = crypto.pbkdf2Sync(secret, salt, 10000, 32, 'sha512');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);

  return Buffer.concat([salt, iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

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

  test('produces different ciphertext on each call (random iv)', async () => {
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

    const buf = Buffer.from(encrypted.slice(3), 'base64');
    buf[buf.length - 1] ^= 0xff;
    const tampered = `v2.${buf.toString('base64')}`;

    await expect(decrypt(tampered, secret)).rejects.toThrow();
  });

  test('rejects malformed and oversized envelopes before deriving a key', async () => {
    const deriveKey = vi.spyOn(crypto, 'pbkdf2');

    try {
      await expect(decrypt('garbage', 'secret')).rejects.toThrow('Invalid encrypted value');
      await expect(decrypt('A'.repeat(8196), 'secret')).rejects.toThrow('Invalid encrypted value');
      await expect(decrypt('v2.invalid', 'secret')).rejects.toThrow('Invalid encrypted value');
      await expect(decrypt(Buffer.alloc(97).toString('base64').slice(1), 'secret')).rejects.toThrow(
        'Invalid encrypted value',
      );
      expect(deriveKey).not.toHaveBeenCalled();
    } finally {
      deriveKey.mockRestore();
    }
  });

  test('new envelopes reject forged tags without password-style derivation', async () => {
    const deriveKey = vi.spyOn(crypto, 'pbkdf2');

    try {
      const token = await encrypt('value', 'secret');
      const bytes = Buffer.from(token.slice(3), 'base64');
      bytes[12] ^= 0xff;
      const forged = `v2.${bytes.toString('base64')}`;

      expect(token.startsWith('v2.')).toBe(true);
      await expect(decrypt(token, 'secret')).resolves.toBe('value');
      await Promise.allSettled(Array.from({ length: 128 }, () => decrypt(forged, 'secret')));
      expect(deriveKey).not.toHaveBeenCalled();
    } finally {
      deriveKey.mockRestore();
    }
  });

  test('retains the previous encrypted-token format during rollout', async () => {
    await expect(decrypt(createLegacyEnvelope('value', 'secret'), 'secret')).resolves.toBe('value');
  });

  test('bounds concurrent derivations without retaining a waiting queue', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);

    try {
      vi.resetModules();
      const isolated = await import('./crypto');
      const token = createLegacyEnvelope('value', 'secret');
      const pending = Array.from({ length: 64 }, () => isolated.decrypt(token, 'wrong-secret'));

      await expect(isolated.decrypt(token, 'secret')).rejects.toThrow(
        'Too many concurrent decryptions',
      );
      await Promise.allSettled(pending);
      now.mockReturnValue(2000);
      await expect(isolated.decrypt(token, 'secret')).resolves.toBe('value');
    } finally {
      now.mockRestore();
    }
  });

  test('admits only bounded decryptions before deriving attacker-selected salts', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const deriveKey = vi.spyOn(crypto, 'pbkdf2');

    try {
      vi.resetModules();
      const isolated = await import('./crypto');
      const token = createLegacyEnvelope('value', 'secret');
      const bytes = Buffer.from(token, 'base64');
      bytes[bytes.length - 1] ^= 0xff;
      const forged = bytes.toString('base64');
      deriveKey.mockClear();

      await Promise.allSettled(
        Array.from({ length: 64 }, () => isolated.decrypt(forged, 'secret')),
      );
      expect(deriveKey).toHaveBeenCalledTimes(64);

      await expect(isolated.decrypt(forged, 'secret')).rejects.toThrow(
        'Too many decryption attempts',
      );
      expect(deriveKey).toHaveBeenCalledTimes(64);

      now.mockReturnValue(2000);
      await expect(isolated.decrypt(token, 'secret')).resolves.toBe('value');
      expect(deriveKey).toHaveBeenCalledTimes(65);
    } finally {
      deriveKey.mockRestore();
      now.mockRestore();
    }
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
