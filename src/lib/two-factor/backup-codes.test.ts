import { describe, expect, test } from 'vitest';
import { generateBackupCodes, verifyBackupCode } from './backup-codes';

const BCRYPT_TEST_TIMEOUT = 15_000;

describe('generateBackupCodes', () => {
  test(
    'generates 10 plaintext codes and 10 hashes',
    async () => {
      const { plaintext, hashed } = await generateBackupCodes();

      expect(plaintext).toHaveLength(10);
      expect(hashed).toHaveLength(10);
    },
    BCRYPT_TEST_TIMEOUT,
  );

  test(
    'formats codes as two uppercase 16-hex groups separated by a dash',
    async () => {
      const { plaintext } = await generateBackupCodes();

      for (const code of plaintext) {
        expect(code).toMatch(/^[0-9A-F]{16}-[0-9A-F]{16}$/);
      }
    },
    BCRYPT_TEST_TIMEOUT,
  );

  test(
    'hashes are bcrypt hashes distinct from the plaintext',
    async () => {
      const { plaintext, hashed } = await generateBackupCodes();

      for (let i = 0; i < plaintext.length; i++) {
        expect(hashed[i]).toMatch(/^\$2[aby]\$/);
        expect(hashed[i]).not.toBe(plaintext[i]);
      }
    },
    BCRYPT_TEST_TIMEOUT,
  );

  test(
    'generates unique codes',
    async () => {
      const { plaintext } = await generateBackupCodes();

      expect(new Set(plaintext).size).toBe(plaintext.length);
    },
    BCRYPT_TEST_TIMEOUT,
  );
});

describe('verifyBackupCode', () => {
  test(
    'returns the matching index for a valid code',
    async () => {
      const { plaintext, hashed } = await generateBackupCodes();

      expect(await verifyBackupCode(plaintext[3], hashed)).toBe(3);
    },
    BCRYPT_TEST_TIMEOUT,
  );

  test(
    'is case-insensitive on input',
    async () => {
      const { plaintext, hashed } = await generateBackupCodes();

      expect(await verifyBackupCode(plaintext[0].toLowerCase(), hashed)).toBe(0);
    },
    BCRYPT_TEST_TIMEOUT,
  );

  test(
    'returns null for an unknown code',
    async () => {
      const { hashed } = await generateBackupCodes();

      expect(await verifyBackupCode('DEADBEEFDEADBEEF-DEADBEEFDEADBEEF', hashed)).toBeNull();
    },
    BCRYPT_TEST_TIMEOUT,
  );
});
