import { afterEach, describe, expect, test, vi } from 'vitest';
import { CLIENT_INFO_TRUST_HEADER, canTrustClientInfoPayload } from './client-info-trust';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('trusted collector metadata', () => {
  test('requires both the explicit feature flag and matching shared key', () => {
    vi.stubEnv('TRUST_CLIENT_INFO_PAYLOAD', '1');
    vi.stubEnv('CLIENT_INFO_TRUST_KEY', 'trusted-collector-key-0000000000000000');

    expect(canTrustClientInfoPayload(new Request('https://analytics.example/api/send'))).toBe(
      false,
    );
    expect(
      canTrustClientInfoPayload(
        new Request('https://analytics.example/api/send', {
          headers: {
            [CLIENT_INFO_TRUST_HEADER]: 'incorrect-key-000000000000000000000',
          },
        }),
      ),
    ).toBe(false);
    expect(
      canTrustClientInfoPayload(
        new Request('https://analytics.example/api/send', {
          headers: {
            [CLIENT_INFO_TRUST_HEADER]: 'trusted-collector-key-0000000000000000',
          },
        }),
      ),
    ).toBe(true);
  });

  test('does not trust a matching key while the feature is disabled', () => {
    vi.stubEnv('TRUST_CLIENT_INFO_PAYLOAD', '0');
    vi.stubEnv('CLIENT_INFO_TRUST_KEY', 'trusted-collector-key-0000000000000000');

    expect(
      canTrustClientInfoPayload(
        new Request('https://analytics.example/api/send', {
          headers: {
            [CLIENT_INFO_TRUST_HEADER]: 'trusted-collector-key-0000000000000000',
          },
        }),
      ),
    ).toBe(false);
  });
});
