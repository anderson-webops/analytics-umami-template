import path from 'node:path';
import { browserName, detectOS } from 'detect-browser';
import ipaddr from 'ipaddr.js';
import isLocalhost from 'is-localhost-ip';
import { isbot } from 'isbot';
import maxmind from 'maxmind';
import { UAParser } from 'ua-parser-js';
import { getIpAddress, stripPort } from '@/lib/ip';
import { safeDecodeURIComponent } from '@/lib/url';

const MAXMIND = 'maxmind';

const PROVIDER_HEADERS = [
  // Umami custom headers (cloud mode only)
  ...(process.env.CLOUD_MODE
    ? [
        {
          countryHeader: 'x-umami-client-country',
          regionHeader: 'x-umami-client-region',
          cityHeader: 'x-umami-client-city',
        },
      ]
    : []),
  // Cloudflare headers
  {
    countryHeader: 'cf-ipcountry',
    regionHeader: 'cf-region-code',
    cityHeader: 'cf-ipcity',
  },
  // Vercel headers
  {
    countryHeader: 'x-vercel-ip-country',
    regionHeader: 'x-vercel-ip-country-region',
    cityHeader: 'x-vercel-ip-city',
  },
  // CloudFront headers
  {
    countryHeader: 'cloudfront-viewer-country',
    regionHeader: 'cloudfront-viewer-country-region',
    cityHeader: 'cloudfront-viewer-city',
  },
  // EdgeOne headers (requires custom request headers in Rule Priorities, see: https://edgeone.ai/document/46151)
  {
    countryHeader: 'eo-ipcountry',
    regionHeader: 'eo-region-code',
    cityHeader: 'eo-ipcity',
  },
];

const BOT_SIGNATURES = [
  { pattern: /\bGPTBot\b/i, name: 'GPTBot', category: 'ai-crawler' },
  { pattern: /\bChatGPT-User\b/i, name: 'ChatGPT-User', category: 'ai-crawler' },
  { pattern: /\bOAI-SearchBot\b/i, name: 'OAI-SearchBot', category: 'ai-crawler' },
  { pattern: /\bClaudeBot\b/i, name: 'ClaudeBot', category: 'ai-crawler' },
  { pattern: /\bClaude-SearchBot\b/i, name: 'Claude-SearchBot', category: 'ai-crawler' },
  { pattern: /\bAnthropic[- ]?AI\b/i, name: 'Anthropic-AI', category: 'ai-crawler' },
  { pattern: /\bPerplexityBot\b/i, name: 'PerplexityBot', category: 'ai-crawler' },
  { pattern: /\bGoogle-Extended\b/i, name: 'Google-Extended', category: 'ai-crawler' },
  { pattern: /\bGoogleOther\b/i, name: 'GoogleOther', category: 'search-crawler' },
  { pattern: /\bGooglebot\b/i, name: 'Googlebot', category: 'search-crawler' },
  { pattern: /\bBytespider\b/i, name: 'Bytespider', category: 'ai-crawler' },
  { pattern: /\bCCBot\b/i, name: 'CCBot', category: 'ai-crawler' },
  { pattern: /\bfacebookexternalhit\b/i, name: 'facebookexternalhit', category: 'generic-bot' },
];

function getBotCategory(name: string) {
  if (/gpt|openai|oai-|claude|anthropic|perplexity|bytespider|ccbot|google-extended/i.test(name)) {
    return 'ai-crawler';
  }

  if (/googlebot|googleother|bingbot|duckduckbot|slurp|yandex|baiduspider/i.test(name)) {
    return 'search-crawler';
  }

  return 'generic-bot';
}

export function getBotInfo(userAgent: string | undefined | null) {
  const value = userAgent || '';

  if (!value || !isbot(value)) {
    return { isBot: false, botName: null, botCategory: null };
  }

  const matchedBot = BOT_SIGNATURES.find(({ pattern }) => pattern.test(value));

  if (matchedBot) {
    return {
      isBot: true,
      botName: matchedBot.name,
      botCategory: matchedBot.category,
    };
  }

  const fallback =
    value.match(
      /\b([A-Za-z][A-Za-z0-9._-]*(?:bot|crawler|spider|fetcher|preview|slurp))\b/i,
    )?.[1] || 'UnknownBot';

  return {
    isBot: true,
    botName: fallback,
    botCategory: getBotCategory(fallback),
  };
}

export function getDevice(userAgent: string, screen: string = '') {
  const { device } = UAParser(userAgent);

  const [width] = screen.split('x');

  const type = device?.type || 'desktop';

  if (type === 'desktop' && screen && +width <= 1920) {
    return 'laptop';
  }

  return type;
}

function getRegionCode(country: string, region: string) {
  if (!country || !region) {
    return undefined;
  }

  return region.includes('-') ? region : `${country}-${region}`;
}

function decodeHeader(s: string | undefined | null): string | undefined | null {
  if (s === undefined || s === null) {
    return s;
  }

  return Buffer.from(s, 'latin1').toString('utf-8');
}

async function isLocalIp(ip: string) {
  try {
    return await isLocalhost(ip);
  } catch {
    return false;
  }
}

export async function getLocation(ip: string = '', headers: Headers, skipHeaders: boolean) {
  const cleanIp = stripPort(ip);

  // Ignore local or invalid ips
  if (!cleanIp || !ipaddr.isValid(cleanIp) || (await isLocalIp(cleanIp))) {
    return null;
  }

  if (!skipHeaders && !process.env.SKIP_LOCATION_HEADERS) {
    for (const provider of PROVIDER_HEADERS) {
      const countryHeader = headers.get(provider.countryHeader);
      if (countryHeader) {
        const country = decodeHeader(countryHeader);
        const region = decodeHeader(headers.get(provider.regionHeader));
        const city = decodeHeader(headers.get(provider.cityHeader));

        return {
          country,
          region: getRegionCode(country, region),
          city,
        };
      }
    }
  }

  // Database lookup
  if (!globalThis[MAXMIND]) {
    const dir = path.join(process.cwd(), 'geo');

    globalThis[MAXMIND] = await maxmind.open(
      process.env.GEOLITE_DB_PATH || path.resolve(dir, 'GeoLite2-City.mmdb'),
    );
  }

  const result = globalThis[MAXMIND]?.get(cleanIp);

  if (result) {
    const country = result.country?.iso_code ?? result?.registered_country?.iso_code;
    const region = result.subdivisions?.[0]?.iso_code;
    const city = result.city?.names?.en;

    return {
      country,
      region: getRegionCode(country, region),
      city,
    };
  }
}

export async function getClientInfo(request: Request, payload: Record<string, any>) {
  const userAgent = payload?.userAgent || request.headers.get('user-agent') || '';
  const ip = payload?.ip || getIpAddress(request.headers);
  const location = await getLocation(ip, request.headers, !!payload?.ip);
  const country = safeDecodeURIComponent(location?.country);
  const region = safeDecodeURIComponent(location?.region);
  const city = safeDecodeURIComponent(location?.city);
  const { isBot, botName, botCategory } = getBotInfo(userAgent);
  const browser = payload?.browser ?? browserName(userAgent);
  const os = payload?.os ?? (detectOS(userAgent) as string);
  const device = payload?.device ?? getDevice(userAgent, payload?.screen);

  return { userAgent, browser, os, ip, country, region, city, device, isBot, botName, botCategory };
}

export function hasBlockedIp(clientIp: string) {
  const ignoreIps = process.env.IGNORE_IP;

  if (!clientIp || !ignoreIps) {
    return false;
  }

  const ips = ignoreIps.split(',').map(n => n.trim());

  return ips.some(ip => {
    if (ip === clientIp) {
      return true;
    }

    // CIDR notation
    if (ip.indexOf('/') > 0) {
      try {
        const addr = ipaddr.parse(clientIp);
        const range = ipaddr.parseCIDR(ip);

        if (addr.kind() === range[0].kind() && addr.match(range)) {
          return true;
        }
      } catch {
        // Ignore parsing errors
      }
    }

    return false;
  });
}
