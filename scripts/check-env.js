/* eslint-disable no-console */
import 'dotenv/config';
import ipaddr from 'ipaddr.js';
import { parseCollectionServerKeys } from './collection-key-config.mjs';
import { isPrivateDatabaseHost } from './database-host-policy.mjs';
import { assertDatabaseTransport, DatabaseTransportError } from './database-transport.mjs';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);
const PLACEHOLDER_SECRETS = new Set([
  'app-secret',
  'changeme',
  'change-me',
  'password',
  'postgres',
  'secret',
  'umami',
]);
const SAFE_SCHEMA = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_HEADER = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const EXPECTED_NODE_VERSION = '24.18.1';
const FORBIDDEN_CLIENT_IP_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
  'proxy-authorization',
  'x-umami-cache',
  'x-umami-permit',
  'x-umami-client-info-key',
  'x-umami-share-token',
]);
const LOCATION_HEADER_PROVIDERS = new Set([
  'umami',
  'cloudflare',
  'vercel',
  'cloudfront',
  'edgeone',
]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function getValue(name) {
  return process.env[name]?.trim() || '';
}

function isEnabled(value) {
  return TRUE_VALUES.has(value?.trim().toLowerCase() ?? '');
}

function checkMissing(names) {
  const missing = names.filter(name => !getValue(name));

  if (missing.length > 0) {
    fail(
      `The following environment variables are not defined:\n${missing.map(name => ` - ${name}`).join('\n')}`,
    );
  }
}

function checkBoolean(name) {
  const value = getValue(name).toLowerCase();

  if (value && !TRUE_VALUES.has(value) && !FALSE_VALUES.has(value)) {
    fail(`${name} must be one of 0, 1, false, true, no, yes, off, or on.`);
  }
}

function checkBinaryFlag(name) {
  const value = process.env[name] ?? '';

  if (value && !['0', '1'].includes(value)) {
    fail(`${name} must be 0 or 1.`);
  }
}

function checkBoundedInteger(name, minimum, maximum) {
  const value = getValue(name);

  if (!value) {
    return;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
}

function checkMinimumBytes(name, minimum) {
  const value = getValue(name);

  if (Buffer.byteLength(value, 'utf8') < minimum) {
    fail(`${name} must contain at least ${minimum} UTF-8 bytes.`);
  }

  if (PLACEHOLDER_SECRETS.has(value.toLowerCase())) {
    fail(`${name} must not use a known placeholder value.`);
  }
}

function parsePostgresUrl(name, { production = false } = {}) {
  const value = getValue(name);

  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const schema = url.searchParams.get('schema');

    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !username ||
      !database ||
      database.includes('/') ||
      url.hash ||
      (schema && !SAFE_SCHEMA.test(schema))
    ) {
      throw new Error();
    }

    if (
      production &&
      (!password ||
        Buffer.byteLength(password, 'utf8') < 16 ||
        PLACEHOLDER_SECRETS.has(password.toLowerCase()))
    ) {
      throw new Error();
    }

    assertDatabaseTransport(name, value, { requireVerifiedTlsForPublicHost: production });

    return {
      password: password || null,
      schema: schema || null,
    };
  } catch (error) {
    if (error instanceof DatabaseTransportError) {
      fail(error.message);
    }

    fail(
      `${name} must be a valid PostgreSQL URL with a host, username, database name, optional simple schema identifier, and${
        production ? ' a non-placeholder password of at least 16 UTF-8 bytes' : ' valid credentials'
      }.`,
    );
  }
}

function checkDatabaseUrls({ production = false } = {}) {
  const primary = parsePostgresUrl('DATABASE_URL', { production });
  const direct = parsePostgresUrl('DIRECT_DATABASE_URL', { production });
  const replica = parsePostgresUrl('DATABASE_REPLICA_URL', { production });
  const schemas = [primary?.schema, direct?.schema, replica?.schema].filter(
    value => value !== undefined,
  );

  if (new Set(schemas).size > 1) {
    fail(
      'DATABASE_URL, DIRECT_DATABASE_URL, and DATABASE_REPLICA_URL must select the same schema.',
    );
  }

  return { primary, direct, replica };
}

function checkAbsoluteUrl(name, protocols, { requireTlsForPublicHost = false } = {}) {
  const value = getValue(name);

  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);

    if (!protocols.includes(url.protocol) || !url.hostname || url.hash) {
      throw new Error();
    }

    if (
      requireTlsForPublicHost &&
      !isPrivateDatabaseHost(url.hostname) &&
      !['https:', 'rediss:', 'kafkas:'].includes(url.protocol)
    ) {
      fail(`${name} must use an encrypted protocol when it targets a non-private host.`);
    }

    return url;
  } catch {
    fail(`${name} must be a valid absolute ${protocols.join(' or ')} URL.`);
  }
}

function checkHttpsUrl(name) {
  const url = checkAbsoluteUrl(name, ['https:']);

  if (url && (url.username || url.password)) {
    fail(`${name} must not contain embedded credentials.`);
  }

  return url;
}

function checkUrlOrPath(name, { allowRoot = false } = {}) {
  const value = getValue(name);

  if (!value) {
    return;
  }

  if (/^https?:\/\//i.test(value)) {
    checkHttpsUrl(name);
    return;
  }

  checkPath(name, { allowRoot });
}

function checkPath(name, { allowCommaList = false, allowRoot = false } = {}) {
  const value = getValue(name);

  if (!value) {
    return;
  }

  const paths = allowCommaList ? value.split(',').map(item => item.trim()) : [value];

  if (
    paths.some(item => {
      const normalized = item.startsWith('/') ? item : `/${item}`;

      return (
        !item ||
        (!allowRoot && normalized === '/') ||
        !/^\/[A-Za-z0-9._~!$&'()+,;=@%/-]*$/.test(normalized) ||
        normalized.split('/').includes('..') ||
        normalized.includes('//')
      );
    })
  ) {
    fail(`${name} must contain only safe application path names without traversal.`);
  }
}

function checkFrameOrigins() {
  const value = getValue('ALLOWED_FRAME_URLS');

  for (const item of value.split(/[\s,]+/).filter(Boolean)) {
    try {
      const url = new URL(item);

      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      ) {
        throw new Error();
      }
    } catch {
      fail('ALLOWED_FRAME_URLS must contain only exact HTTPS origins.');
    }
  }
}

function checkHeaderName(name, { required = false } = {}) {
  const value = getValue(name);

  if ((required && !value) || (value && !SAFE_HEADER.test(value))) {
    fail(`${name} must be a single valid HTTP request-header name.`);
  }

  if (name === 'CLIENT_IP_HEADER' && FORBIDDEN_CLIENT_IP_HEADERS.has(value.toLowerCase())) {
    fail(`${name} must not reuse an authentication, routing, or framing header.`);
  }
}

function checkIgnoredIps() {
  const value = getValue('IGNORE_IP');

  if (!value) {
    return;
  }

  for (const item of value.split(',').map(entry => entry.trim())) {
    try {
      if (item.includes('/')) {
        ipaddr.parseCIDR(item);
      } else {
        ipaddr.parse(item);
      }
    } catch {
      fail('IGNORE_IP must be a comma-separated list of IP addresses or CIDR ranges.');
    }
  }
}

function checkUuid(name) {
  const value = getValue(name);

  if (
    value &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    fail(`${name} must be a valid UUID.`);
  }
}

function checkServiceConfiguration({ production = false } = {}) {
  const publicUrl = checkHttpsUrl('PUBLIC_URL');

  if (!!getValue('TURNSTILE_SITE_KEY') !== !!getValue('TURNSTILE_SECRET_KEY')) {
    fail('TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY must be configured together.');
  }

  if (getValue('TURNSTILE_SECRET_KEY')) {
    checkMinimumBytes('TURNSTILE_SECRET_KEY', 16);
  }

  if (
    production &&
    (/^[123]x0{20}(?:AA|AB|BB|FF)$/.test(getValue('TURNSTILE_SITE_KEY')) ||
      /^[123]x0{31}AA$/.test(getValue('TURNSTILE_SECRET_KEY')))
  ) {
    fail('Production login verification must use real Turnstile credentials.');
  }

  if (publicUrl && (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash)) {
    fail('PUBLIC_URL must be an HTTPS origin without a path, query, or fragment.');
  }

  checkHttpsUrl('CLOUD_URL');
  checkHttpsUrl('FAVICON_URL');
  checkHttpsUrl('LINKS_URL');
  checkHttpsUrl('PIXELS_URL');
  const trackerScriptUrl = checkHttpsUrl('TRACKER_SCRIPT_URL');
  const trackerScriptDigest = getValue('TRACKER_SCRIPT_SHA256');

  if (trackerScriptDigest && !/^[a-f0-9]{64}$/.test(trackerScriptDigest)) {
    fail('TRACKER_SCRIPT_SHA256 must be a lowercase SHA-256 digest.');
  }

  if (
    (trackerScriptUrl || (production && isEnabled(process.env.CLOUD_MODE))) &&
    !trackerScriptDigest
  ) {
    fail('External tracker scripts require TRACKER_SCRIPT_SHA256.');
  }
  checkHttpsUrl('GEO_DATABASE_URL');
  checkAbsoluteUrl('CLICKHOUSE_URL', ['http:', 'https:'], {
    requireTlsForPublicHost: production,
  });
  checkAbsoluteUrl('REDIS_URL', ['redis:', 'rediss:'], {
    requireTlsForPublicHost: production,
  });

  const kafkaUrl = checkAbsoluteUrl('KAFKA_URL', ['kafka:', 'kafkas:']);
  const kafkaBroker = getValue('KAFKA_BROKER');

  if (!!kafkaUrl !== !!kafkaBroker) {
    fail('KAFKA_URL and KAFKA_BROKER must be configured together.');
  }

  if (
    kafkaUrl &&
    ((kafkaUrl.username && !kafkaUrl.password) || (!kafkaUrl.username && kafkaUrl.password))
  ) {
    fail('KAFKA_URL must provide both a username and password when SASL authentication is used.');
  }

  if (
    production &&
    kafkaUrl?.password &&
    Buffer.byteLength(decodeURIComponent(kafkaUrl.password), 'utf8') < 16
  ) {
    fail('KAFKA_URL must use a password of at least 16 UTF-8 bytes in production.');
  }

  const brokers = [];

  for (const item of kafkaBroker
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)) {
    try {
      const broker = new URL(`tcp://${item}`);
      const port = Number(broker.port);

      if (
        broker.protocol !== 'tcp:' ||
        !broker.hostname ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65_535 ||
        broker.username ||
        broker.password ||
        broker.pathname ||
        broker.search ||
        broker.hash
      ) {
        throw new Error();
      }

      brokers.push(broker);
    } catch {
      fail('KAFKA_BROKER must be a comma-separated list of host:port entries.');
    }
  }

  const kafkaUsesTls =
    kafkaUrl?.protocol === 'kafkas:' ||
    isEnabled(process.env.KAFKA_SSL) ||
    Boolean(kafkaUrl?.username && kafkaUrl?.password);

  if (
    production &&
    brokers.some(broker => !isPrivateDatabaseHost(broker.hostname)) &&
    !kafkaUsesTls
  ) {
    fail('KAFKA_SSL must be enabled when a Kafka broker is outside a private network.');
  }

  const mechanism = getValue('KAFKA_SASL_MECHANISM');

  if (mechanism && !['plain', 'scram-sha-256', 'scram-sha-512'].includes(mechanism)) {
    fail('KAFKA_SASL_MECHANISM must be plain, scram-sha-256, or scram-sha-512.');
  }

  if (production && (process.env.KAFKA_URL || process.env.KAFKA_BROKER)) {
    fail('Kafka collection requires a reviewed consumer and backlog transition for this release.');
  }
}

const booleanVariables = [
  'BUILD_GEO',
  'CLOUD_MODE',
  'DISABLE_LOGIN',
  'DISABLE_PUBLIC_SHARES',
  'DISABLE_TELEMETRY',
  'DISABLE_UI',
  'DISABLE_UPDATES',
  'ENABLE_TEST_CONSOLE',
  'ENABLE_UPDATE_CHECKS',
  'FORCE_SSL',
  'KAFKA_SSL',
  'KAFKA_SSL_ALLOW_UNAUTHORIZED',
  'LOG_QUERY',
  'PRIVATE_MODE',
  'REVENUE_ATTESTED_INTAKE_ENABLED',
  'REMOVE_TRAILING_SLASH',
  'SKIP_BUILD_GEO',
  'SKIP_DB_CHECK',
  'SKIP_DB_MIGRATION',
  'SKIP_LOCATION_HEADERS',
  'TRUST_CLIENT_INFO_PAYLOAD',
  'TRUST_LOCATION_HEADERS',
  'USE_UUIDV7',
];

for (const name of booleanVariables) {
  checkBoolean(name);
}

const kafkaHistoryAttestation = process.env.KAFKA_HISTORY_ATTESTED_CLEAN;

if (kafkaHistoryAttestation && !['true', 'false'].includes(kafkaHistoryAttestation)) {
  fail('KAFKA_HISTORY_ATTESTED_CLEAN must be true or false.');
}

if (kafkaHistoryAttestation === 'true' && (process.env.KAFKA_URL || process.env.KAFKA_BROKER)) {
  fail('KAFKA_HISTORY_ATTESTED_CLEAN cannot be enabled while Kafka is configured.');
}

// The MCP route deliberately enables only on the exact value `1`. Validate the
// same contract here so accepted configuration and runtime behavior cannot
// diverge.
checkBinaryFlag('MCP_ENABLED');

for (const [name, minimum, maximum] of [
  ['AUTH_SESSION_TTL_SECONDS', 15 * 60, 24 * 60 * 60],
  ['CACHE_TOKEN_TTL_SECONDS', 30 * 60, 7 * 24 * 60 * 60],
  ['SHARE_TOKEN_TTL_SECONDS', 5 * 60, 24 * 60 * 60],
  ['MAX_API_BODY_BYTES', 16 * 1024, 10 * 1024 * 1024],
  ['LOGIN_RATE_LIMIT_WINDOW_SECONDS', 60, 60 * 60],
  ['LOGIN_RATE_LIMIT_ACCOUNT_FAILURES', 3, 100],
  ['LOGIN_RATE_LIMIT_IP_FAILURES', 5, 500],
  ['COLLECTION_RATE_LIMIT_WINDOW_SECONDS', 10, 300],
  ['COLLECTION_RATE_LIMIT_PER_IP', 10, 100_000],
  ['COLLECTION_RATE_LIMIT_PER_SOURCE', 100, 1_000_000],
  ['KAFKA_MAX_MESSAGE_BYTES', 16 * 1024, 10 * 1024 * 1024],
  ['CORS_MAX_AGE', 0, 604_800],
  ['PORT', 1, 65_535],
]) {
  checkBoundedInteger(name, minimum, maximum);
}

checkPath('BASE_PATH', { allowRoot: true });
checkPath('COLLECT_API_ENDPOINT');
checkPath('TRACKER_SCRIPT_NAME', { allowCommaList: true });
checkUrlOrPath('API_URL', { allowRoot: true });
checkFrameOrigins();
checkHeaderName('CLIENT_IP_HEADER');
checkIgnoredIps();
checkUuid('UMAMI_SELF_TRACK');
checkUuid('UMAMI_SELF_RECORD');
if (
  process.env.COLLECTION_SERVER_KEYS_JSON &&
  !parseCollectionServerKeys(process.env.COLLECTION_SERVER_KEYS_JSON)
) {
  fail('COLLECTION_SERVER_KEYS_JSON must contain valid, bounded website-scoped key records.');
}
checkServiceConfiguration({ production: process.env.NODE_ENV === 'production' });
checkMissing(['APP_SECRET']);
checkMinimumBytes('APP_SECRET', 32);

if (getValue('DATABASE_TYPE') && getValue('DATABASE_TYPE') !== 'postgresql') {
  fail('DATABASE_TYPE must be postgresql.');
}

if (getValue('SALT_ROTATION') && !['day', 'week', 'month'].includes(getValue('SALT_ROTATION'))) {
  fail('SALT_ROTATION must be day, week, or month.');
}

if (getValue('DEFAULT_CURRENCY') && !/^[A-Za-z]{3}$/.test(getValue('DEFAULT_CURRENCY'))) {
  fail('DEFAULT_CURRENCY must be a three-letter currency code.');
}

if (!isEnabled(process.env.SKIP_DB_CHECK) && !getValue('DATABASE_TYPE')) {
  checkMissing(['DATABASE_URL']);
}

if (getValue('CLOUD_URL') || isEnabled(process.env.CLOUD_MODE)) {
  checkMissing(['CLOUD_URL', 'CLICKHOUSE_URL', 'REDIS_URL']);
}

if (isEnabled(process.env.TRUST_CLIENT_INFO_PAYLOAD) && !isEnabled(process.env.CLOUD_MODE)) {
  fail('TRUST_CLIENT_INFO_PAYLOAD is only permitted when CLOUD_MODE is enabled.');
}

if (isEnabled(process.env.TRUST_CLIENT_INFO_PAYLOAD)) {
  checkMissing(['CLIENT_INFO_TRUST_KEY']);
  checkMinimumBytes('CLIENT_INFO_TRUST_KEY', 32);
} else if (getValue('CLIENT_INFO_TRUST_KEY')) {
  checkMinimumBytes('CLIENT_INFO_TRUST_KEY', 32);
}

if (isEnabled(process.env.TRUST_LOCATION_HEADERS) && isEnabled(process.env.SKIP_LOCATION_HEADERS)) {
  fail('TRUST_LOCATION_HEADERS and SKIP_LOCATION_HEADERS cannot both be enabled.');
}

const locationHeaderProvider = getValue('LOCATION_HEADER_PROVIDER');
if (locationHeaderProvider && !LOCATION_HEADER_PROVIDERS.has(locationHeaderProvider)) {
  fail('LOCATION_HEADER_PROVIDER must be umami, cloudflare, vercel, cloudfront, or edgeone.');
}

if (isEnabled(process.env.TRUST_LOCATION_HEADERS)) {
  if (!locationHeaderProvider) {
    fail('TRUST_LOCATION_HEADERS requires LOCATION_HEADER_PROVIDER.');
  }
  if (!isEnabled(process.env.TRUST_CLIENT_INFO_PAYLOAD)) {
    fail('TRUST_LOCATION_HEADERS requires TRUST_CLIENT_INFO_PAYLOAD.');
  }
}

if (process.env.NODE_ENV === 'production') {
  if (process.versions.node !== EXPECTED_NODE_VERSION) {
    fail(`Production requires Node ${EXPECTED_NODE_VERSION}; found ${process.versions.node}.`);
  }

  checkMissing(['DATABASE_URL', 'APP_SECRET', 'PUBLIC_URL', 'CLIENT_IP_HEADER']);
  checkHeaderName('CLIENT_IP_HEADER', { required: true });

  const bindAddress = getValue('UMAMI_BIND_ADDRESS') || '127.0.0.1';

  if (!['127.0.0.1', '::1'].includes(bindAddress)) {
    fail('UMAMI_BIND_ADDRESS must be a loopback address in production.');
  }

  if (getValue('INTERNAL_DIAGNOSTICS_KEY')) {
    checkMinimumBytes('INTERNAL_DIAGNOSTICS_KEY', 32);
  }

  const { primary, direct, replica } = checkDatabaseUrls({ production: true });
  const secrets = [
    getValue('APP_SECRET'),
    getValue('INTERNAL_DIAGNOSTICS_KEY'),
    getValue('CLIENT_INFO_TRUST_KEY'),
    getValue('TURNSTILE_SECRET_KEY'),
    primary?.password,
    direct?.password,
    replica?.password,
  ].filter(Boolean);

  if (new Set(secrets).size !== secrets.length) {
    fail('Application, diagnostics, and database secrets must be independent values.');
  }

  if (isEnabled(process.env.SKIP_DB_CHECK)) {
    fail('SKIP_DB_CHECK is not permitted in production.');
  }

  if (isEnabled(process.env.SKIP_DB_MIGRATION)) {
    fail('SKIP_DB_MIGRATION is not permitted in production.');
  }

  if (isEnabled(process.env.LOG_QUERY) || getValue('DEBUG')) {
    fail('LOG_QUERY and DEBUG must not be enabled in production.');
  }

  if (isEnabled(process.env.ENABLE_TEST_CONSOLE)) {
    fail('ENABLE_TEST_CONSOLE must not be enabled in production.');
  }

  if (isEnabled(process.env.KAFKA_SSL_ALLOW_UNAUTHORIZED)) {
    fail('KAFKA_SSL_ALLOW_UNAUTHORIZED must not be enabled in production.');
  }

  if (getValue('NODE_TLS_REJECT_UNAUTHORIZED') === '0') {
    fail('NODE_TLS_REJECT_UNAUTHORIZED=0 is not permitted in production.');
  }
} else {
  checkDatabaseUrls();
}
