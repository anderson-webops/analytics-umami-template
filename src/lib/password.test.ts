import { afterEach, describe, expect, test, vi } from 'vitest';
import { checkPassword, hasDefaultPassword, hashPassword } from './password';

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

describe('hasDefaultPassword', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('recognizes only the unchanged system user from the initial migration', () => {
    vi.stubEnv('CLOUD_MODE', 'false');

    expect(
      hasDefaultPassword({
        id: '41e2b680-648e-4b09-bcd7-3e2b10c06264',
        password: '$2b$10$BUli0c.muyCW1ErNJc3jL.vFRFtFJWrT8/GcR4A.sUdCznaXiqFXa',
      }),
    ).toBe(true);

    expect(
      hasDefaultPassword({
        id: '41e2b680-648e-4b09-bcd7-3e2b10c06264',
        password: '$2b$10$different-system-user-password-hashxxxxxxxxxxxxxxxxxxxx',
      }),
    ).toBe(false);

    expect(
      hasDefaultPassword({
        id: 'another-user',
        password: '$2b$10$BUli0c.muyCW1ErNJc3jL.vFRFtFJWrT8/GcR4A.sUdCznaXiqFXa',
      }),
    ).toBe(false);
  });

  test('never flags accounts in cloud mode', () => {
    // Cloud accounts are not created by the seed migration; flagging one would lock it out of
    // every API route behind a password dialog that cloud mode does not show.
    vi.stubEnv('CLOUD_MODE', '1');

    expect(
      hasDefaultPassword({
        id: '41e2b680-648e-4b09-bcd7-3e2b10c06264',
        password: '$2b$10$BUli0c.muyCW1ErNJc3jL.vFRFtFJWrT8/GcR4A.sUdCznaXiqFXa',
      }),
    ).toBe(false);
  });
});
