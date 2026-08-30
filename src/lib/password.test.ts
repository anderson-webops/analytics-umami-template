import { describe, expect, test } from 'vitest';
import { checkPassword, hashPassword } from './password';

const BCRYPT_TEST_TIMEOUT = 15_000;

describe('hashPassword', () => {
  test(
    'returns a bcrypt hash distinct from the plaintext',
    async () => {
      const hash = await hashPassword('correct horse');

      expect(hash).not.toBe('correct horse');
      expect(hash).toMatch(/^\$2[aby]\$/);
    },
    BCRYPT_TEST_TIMEOUT,
  );

  test(
    'produces different hashes for the same password (random salt)',
    async () => {
      const [first, second] = await Promise.all([hashPassword('same'), hashPassword('same')]);

      expect(first).not.toBe(second);
    },
    BCRYPT_TEST_TIMEOUT,
  );
});

describe('checkPassword', () => {
  test(
    'accepts the correct password',
    async () => {
      const hash = await hashPassword('correct horse');

      await expect(checkPassword('correct horse', hash)).resolves.toBe(true);
    },
    BCRYPT_TEST_TIMEOUT,
  );

  test(
    'rejects the wrong password',
    async () => {
      const hash = await hashPassword('correct horse');

      await expect(checkPassword('wrong horse', hash)).resolves.toBe(false);
    },
    BCRYPT_TEST_TIMEOUT,
  );
});
