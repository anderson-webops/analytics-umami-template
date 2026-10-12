import pg from 'pg';
import { isPrivateDatabaseHost } from './database-host-policy.mjs';

const CONNECTION_OVERRIDES = new Set(['host', 'hostaddr', 'port', 'user', 'password', 'database']);
const SECURITY_PARAMETERS = new Set([
  ...CONNECTION_OVERRIDES,
  'ssl',
  'sslmode',
  'sslcert',
  'sslkey',
  'sslrootcert',
  'uselibpqcompat',
]);

export class DatabaseTransportError extends Error {}

export function assertDatabaseTransport(
  name,
  value,
  { requireVerifiedTlsForPublicHost = false } = {},
) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new DatabaseTransportError(`${name} has invalid PostgreSQL transport settings.`);
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new DatabaseTransportError(`${name} has invalid PostgreSQL transport settings.`);
  }

  const seen = new Set();

  for (const [key] of url.searchParams) {
    if (CONNECTION_OVERRIDES.has(key) || (SECURITY_PARAMETERS.has(key) && seen.has(key))) {
      throw new DatabaseTransportError(
        `${name} must not override or repeat PostgreSQL connection settings in its query string.`,
      );
    }

    seen.add(key);
  }

  let connection;

  try {
    connection = new pg.Client({ connectionString: value }).connectionParameters;
  } catch {
    throw new DatabaseTransportError(`${name} has invalid PostgreSQL transport settings.`);
  }

  if (connection.host.replace(/^\[|\]$/g, '') !== url.hostname.replace(/^\[|\]$/g, '')) {
    throw new DatabaseTransportError(`${name} has a conflicting PostgreSQL client host.`);
  }

  if (!requireVerifiedTlsForPublicHost || isPrivateDatabaseHost(connection.host)) {
    return;
  }

  if (
    url.searchParams.get('sslmode') !== 'verify-full' ||
    url.searchParams.has('ssl') ||
    url.searchParams.has('uselibpqcompat') ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
  ) {
    throw new DatabaseTransportError(
      `${name} targets a non-private host and must use sslmode=verify-full without conflicting TLS options.`,
    );
  }

  const ssl = connection.ssl;

  if (
    !ssl ||
    (typeof ssl === 'object' &&
      (ssl.rejectUnauthorized === false || typeof ssl.checkServerIdentity === 'function'))
  ) {
    throw new DatabaseTransportError(
      `${name} must verify the PostgreSQL server certificate and hostname.`,
    );
  }
}
