import { isSessionDeletionAvailable } from '@/lib/db';
import { isEnvEnabled } from '@/lib/env';
import { publicSharesDisabled } from '@/lib/security';

export type Config = {
  cloudMode: boolean;
  faviconUrl?: string;
  linksUrl?: string;
  pixelsUrl?: string;
  privateMode: boolean;
  publicSharesDisabled: boolean;
  sessionDeletionEnabled: boolean;
  telemetryDisabled: boolean;
  trackerScriptName?: string;
  updatesDisabled: boolean;
};

/**
 * Server-side only. Reads runtime environment values that the client needs.
 * Must be called at request time (not build time) so Docker/runtime env is honored.
 */
export function getConfig(): Config {
  return {
    cloudMode: isEnvEnabled('CLOUD_MODE'),
    faviconUrl: process.env.FAVICON_URL,
    linksUrl: process.env.LINKS_URL,
    pixelsUrl: process.env.PIXELS_URL,
    privateMode: isEnvEnabled('PRIVATE_MODE'),
    publicSharesDisabled: publicSharesDisabled(),
    sessionDeletionEnabled: isSessionDeletionAvailable(),
    telemetryDisabled: isEnvEnabled('DISABLE_TELEMETRY'),
    trackerScriptName: process.env.TRACKER_SCRIPT_NAME,
    updatesDisabled: isEnvEnabled('DISABLE_UPDATES') || !isEnvEnabled('ENABLE_UPDATE_CHECKS'),
  };
}
