import { isAllowedTrackingHostname } from '@/lib/security';

export function getAllowedTrackingOrigin(
  originHeader: string | null,
  configuredDomain: string | null | undefined,
): string | null {
  if (!originHeader || !configuredDomain) {
    return null;
  }

  try {
    const origin = new URL(originHeader);
    const configuredPort = new URL(`https://${configuredDomain}`).port;

    if (
      origin.origin !== originHeader ||
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.port !== configuredPort ||
      origin.username ||
      origin.password ||
      !isAllowedTrackingHostname(configuredDomain, origin.hostname)
    ) {
      return null;
    }

    return origin.origin;
  } catch {
    return null;
  }
}
