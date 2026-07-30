import crypto from 'node:crypto';
import { isEnvEnabled } from '@/lib/env';

export const CLIENT_INFO_TRUST_HEADER = 'x-umami-client-info-key';

function secretsMatch(left: string, right: string): boolean {
  const leftDigest = crypto.createHash('sha256').update(left).digest();
  const rightDigest = crypto.createHash('sha256').update(right).digest();

  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

export function canTrustClientInfoPayload(request: Request): boolean {
  if (!isEnvEnabled('TRUST_CLIENT_INFO_PAYLOAD')) {
    return false;
  }

  const providedKey = request.headers.get(CLIENT_INFO_TRUST_HEADER);
  const expectedKey = process.env.CLIENT_INFO_TRUST_KEY;

  return !!providedKey && !!expectedKey && secretsMatch(providedKey, expectedKey);
}
