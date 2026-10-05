import { expect, test, vi } from 'vitest';
import { uuid } from './crypto';
import { isSameOriginMutation } from './session';

const sourceId = '2e2fc91f-77a7-4e5d-a7b1-18a74c67b4e0';
const sessionSalt = 'monthly-session-salt';

test('keeps session IDs stable on the same device', () => {
  const args = [sourceId, '192.0.2.1', 'Desktop Browser', sessionSalt] as const;

  expect(uuid(...args)).toBe(uuid(...args));
});

test('creates separate sessions on different devices', () => {
  const desktopSessionId = uuid(sourceId, '192.0.2.1', 'Desktop Browser', sessionSalt);
  const mobileSessionId = uuid(sourceId, '198.51.100.2', 'Mobile Browser', sessionSalt);

  expect(desktopSessionId).not.toBe(mobileSessionId);
});

test('preserves anonymous session IDs', () => {
  expect(uuid(sourceId, '192.0.2.1', 'Desktop Browser', sessionSalt)).toBe(
    uuid(sourceId, '192.0.2.1', 'Desktop Browser', sessionSalt),
  );
});

test('rejects a different scheme on the same host without a configured public origin', () => {
  vi.stubEnv('PUBLIC_URL', '');

  try {
    const request = new Request('https://analytics.example/api/auth/logout', {
      method: 'POST',
      headers: { origin: 'http://analytics.example' },
    });

    expect(isSameOriginMutation(request)).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
});
