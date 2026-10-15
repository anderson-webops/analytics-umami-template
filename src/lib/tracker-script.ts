export const VERIFIED_TRACKER_PATH = '/verified-tracker-script';

function isEnabled(value?: string) {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

export function getExternalTrackerUrl(environment = process.env) {
  const configuredUrl = environment.TRACKER_SCRIPT_URL?.trim();

  if (configuredUrl) {
    try {
      const url = new URL(configuredUrl);

      if (url.protocol === 'https:' && !url.username && !url.password) {
        return url;
      }
    } catch {
      return null;
    }

    return null;
  }

  return environment.NODE_ENV === 'production' && isEnabled(environment.CLOUD_MODE)
    ? new URL('https://cloud.umami.is/script.js')
    : null;
}

export function getTrackerScriptSha256(environment = process.env) {
  const digest = environment.TRACKER_SCRIPT_SHA256?.trim();

  return digest && /^[a-f0-9]{64}$/.test(digest) ? digest : null;
}
