const ATTRIBUTION_QUERY_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'gclid',
  'fbclid',
  'msclkid',
  'ttclid',
  'li_fat_id',
  'twclid',
  'ad_id',
  'aid',
  'dclid',
  'epik',
  'ob_click_id',
  'pc_id',
  'rdt_cid',
  'scid',
] as const;

const MAX_ATTRIBUTION_VALUE_LENGTH = 255;
const MAX_ATTRIBUTION_QUERY_LENGTH = 500;
const SAFE_ATTRIBUTION_VALUE = /^[\p{L}\p{N}][\p{L}\p{N} ._~+!-]*$/u;

export function sanitizeTrackingUrl(url: URL, includeAttribution = true): URL {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Unsupported tracking URL.');
  }

  const sanitized = new URL(url.href);
  sanitized.username = '';
  sanitized.password = '';
  sanitized.hash = '';
  sanitized.search = '';

  if (includeAttribution) {
    const query = new URLSearchParams();

    for (const key of ATTRIBUTION_QUERY_KEYS) {
      const value = url.searchParams.get(key);

      if (
        value &&
        value.length <= MAX_ATTRIBUTION_VALUE_LENGTH &&
        SAFE_ATTRIBUTION_VALUE.test(value)
      ) {
        const candidate = new URLSearchParams(query);
        candidate.set(key, value);

        if (candidate.toString().length <= MAX_ATTRIBUTION_QUERY_LENGTH) {
          query.set(key, value);
        }
      }
    }

    sanitized.search = query.toString();
  }

  return sanitized;
}
