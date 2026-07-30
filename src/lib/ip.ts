import ipaddr from 'ipaddr.js';
import { isEnvEnabled } from '@/lib/env';

export const IP_ADDRESS_HEADERS = [
  ...(isEnvEnabled('CLOUD_MODE') ? ['x-umami-client-ip'] : []), // Umami custom header (cloud mode only)
  'true-client-ip', // CDN
  'cf-connecting-ip', // Cloudflare
  'fastly-client-ip', // Fastly
  'x-nf-client-connection-ip', // Netlify
  'do-connecting-ip', // Digital Ocean
  'x-real-ip', // Reverse proxy
  'x-appengine-user-ip', // Google App Engine
  'x-forwarded-for',
  'forwarded',
  'x-client-ip',
  'x-cluster-client-ip',
  'x-forwarded',
];

function normalizeIp(ip?: string | null): string | undefined {
  if (!ip) {
    return undefined;
  }

  try {
    const parsed = ipaddr.parse(ip.trim());

    if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
      return (parsed as ipaddr.IPv6).toIPv4Address().toString();
    }

    return parsed.toString();
  } catch {
    return undefined;
  }
}

function resolveIp(ip?: string | null): string | undefined {
  if (!ip) {
    return undefined;
  }

  const value = ip.trim().replace(/^"|"$/g, '');
  const normalized = normalizeIp(value);

  if (normalized) {
    return normalized;
  }

  return normalizeIp(stripPort(value));
}

function resolveHeaderIp(name: string, value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  if (name.toLowerCase() === 'forwarded') {
    const match = value.match(/(?:^|[;,]\s*)for=(?:"?\[?)([0-9a-fA-F:.]+)(?:\]?"?)(?=[:;,]|$)/i);

    return match ? resolveIp(match[1]) : undefined;
  }

  return resolveIp(value.split(',')[0]?.trim());
}

export function getIpAddress(headers: Headers) {
  const customHeader = process.env.CLIENT_IP_HEADER?.trim();

  if (customHeader) {
    return resolveHeaderIp(customHeader, headers.get(customHeader));
  }

  // Production must explicitly identify the one header that a trusted edge or
  // reverse proxy overwrites. Falling through to arbitrary forwarding headers
  // lets direct clients choose their own rate-limit and session identity.
  if (process.env.NODE_ENV === 'production') {
    return undefined;
  }

  const header = IP_ADDRESS_HEADERS.find(name => headers.get(name));

  return header ? resolveHeaderIp(header, headers.get(header)) : undefined;
}

export function stripPort(ip?: string | null): string | undefined {
  if (!ip) {
    return undefined;
  }

  if (ip.startsWith('[')) {
    const endBracket = ip.indexOf(']');

    if (endBracket !== -1) {
      return ip.slice(1, endBracket);
    }
  }

  const idx = ip.lastIndexOf(':');

  if (idx !== -1 && (ip.includes('.') || /^[a-zA-Z0-9.-]+$/.test(ip.slice(0, idx)))) {
    return ip.slice(0, idx);
  }

  return ip;
}
