import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Dataset, getDistinctId, PERSONAS, UTM_QUERY } from './dataset';
import { SEED_IDS, SEED_WEBSITES } from './ids';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

interface HistoricalSession {
  sessionId: string;
  visitId: string;
  websiteId: string;
  hostname: string;
  browser: string;
  os: string;
  device: string;
  referrerDomain: string | null;
  urlQuery: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  createdAt: Date;
}

interface HistoricalRevenue {
  revenueId: string;
  eventId: string;
  websiteId: string;
  sessionId: string;
  currency: string;
  revenue: number;
  createdAt: Date;
}

export function buildHistoricalRevenueFixture(dataset: Dataset, makeId = randomUUID) {
  const sessions = new Map<string, HistoricalSession>();
  const revenue: HistoricalRevenue[] = [];

  for (const event of dataset.legacyRevenue) {
    const { website, id, hostname, timestamp, data } = event.payload;
    const persona = PERSONAS.find(candidate => getDistinctId(candidate) === id);

    if (
      event.type !== 'event' ||
      (website !== SEED_IDS.website && website !== SEED_IDS.website2) ||
      !persona ||
      hostname !==
        (website === SEED_IDS.website
          ? SEED_WEBSITES.primary.domain
          : SEED_WEBSITES.secondary.domain) ||
      typeof timestamp !== 'number' ||
      !Number.isSafeInteger(timestamp) ||
      !data ||
      typeof data !== 'object' ||
      !('revenue' in data) ||
      typeof data.revenue !== 'number' ||
      !Number.isFinite(data.revenue) ||
      data.revenue < 0 ||
      !('currency' in data) ||
      data.currency !== 'USD'
    ) {
      throw new Error('Invalid disposable historical revenue fixture.');
    }

    const websiteId = website;
    const key = `${websiteId}:${id}`;
    let session = sessions.get(key);
    const createdAt = new Date(timestamp * 1000);

    if (!session) {
      session = {
        sessionId: makeId(),
        visitId: makeId(),
        websiteId,
        hostname,
        browser: 'Chrome',
        os: 'Linux',
        device: 'desktop',
        referrerDomain: persona.referrer
          ? new URL(persona.referrer).hostname.replace(/^www\./, '')
          : null,
        urlQuery: persona.utm ? UTM_QUERY : null,
        utmSource: persona.utm ? 'newsletter' : null,
        utmMedium: persona.utm ? 'email' : null,
        createdAt,
      };
      sessions.set(key, session);
    } else if (createdAt < session.createdAt) {
      session.createdAt = createdAt;
    }

    revenue.push({
      revenueId: makeId(),
      eventId: makeId(),
      websiteId,
      sessionId: session.sessionId,
      currency: data.currency,
      revenue: data.revenue,
      createdAt,
    });
  }

  return {
    sessions: [...sessions.values()].map(session => ({
      ...session,
      createdAt: new Date(session.createdAt.getTime() - 60_000),
    })),
    revenue,
  };
}

function sqlValue(value: string | number | null) {
  return value === null
    ? 'NULL'
    : typeof value === 'number'
      ? String(value)
      : `'${value.replaceAll("'", "''")}'`;
}

function postgresStatement(fixture: ReturnType<typeof buildHistoricalRevenueFixture>) {
  const sessionValues = fixture.sessions
    .map(session =>
      [
        session.sessionId,
        session.websiteId,
        session.browser,
        session.os,
        session.device,
        session.createdAt.toISOString(),
      ]
        .map(sqlValue)
        .join(', '),
    )
    .map(values => `(${values})`)
    .join(',\n');
  const pageviewValues = fixture.sessions
    .map(session =>
      [
        randomUUID(),
        session.websiteId,
        session.sessionId,
        session.visitId,
        session.createdAt.toISOString(),
        '/',
        session.urlQuery,
        session.utmSource,
        session.utmMedium,
        session.referrerDomain,
        session.hostname,
        1,
        0,
      ]
        .map(sqlValue)
        .join(', '),
    )
    .map(values => `(${values})`)
    .join(',\n');
  const revenueValues = fixture.revenue
    .map(row =>
      [
        row.revenueId,
        row.websiteId,
        row.sessionId,
        row.eventId,
        'purchase',
        row.currency,
        row.revenue,
        row.createdAt.toISOString(),
      ]
        .map(sqlValue)
        .join(', '),
    )
    .map(values => `(${values})`)
    .join(',\n');

  return `BEGIN;
INSERT INTO session (session_id, website_id, browser, os, device, created_at)
VALUES ${sessionValues};
INSERT INTO website_event (event_id, website_id, session_id, visit_id, created_at, url_path, url_query, utm_source, utm_medium, referrer_domain, hostname, event_type, trust_tier)
VALUES ${pageviewValues};
INSERT INTO revenue (revenue_id, website_id, session_id, event_id, event_name, currency, revenue, created_at)
VALUES ${revenueValues};
COMMIT;`;
}

function clickhouseDate(date: Date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function runCompose(
  profile: 'postgres' | 'clickhouse',
  service: string,
  command: string[],
  input: string,
) {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      'docker-compose.test.yml',
      '-p',
      process.env.COMPOSE_PROJECT_NAME || 'umami-api-test',
      '--profile',
      profile,
      'exec',
      '-T',
      service,
      ...command,
    ],
    { cwd: ROOT_DIR, input, encoding: 'utf8', maxBuffer: 1024 * 1024 },
  );

  if (result.status !== 0) {
    throw new Error(
      `Disposable ${service} historical fixture failed (${result.status ?? 'spawn'}).`,
    );
  }
}

export function seedHistoricalRevenue(dataset: Dataset, db: 'postgres' | 'clickhouse') {
  if (process.env.UMAMI_TEST_LOCAL_COMPOSE !== '1') {
    throw new Error('Historical revenue fixture requires the disposable local Compose stack.');
  }

  const fixture = buildHistoricalRevenueFixture(dataset);

  if (!fixture.revenue.length) {
    return;
  }

  runCompose(
    db,
    'db',
    ['psql', '-X', '-U', 'umami', '-d', 'umami', '-v', 'ON_ERROR_STOP=1'],
    postgresStatement(fixture),
  );

  if (db === 'clickhouse') {
    const pageviews = fixture.sessions.map(session => ({
      website_id: session.websiteId,
      session_id: session.sessionId,
      visit_id: session.visitId,
      event_id: randomUUID(),
      hostname: session.hostname,
      browser: session.browser,
      os: session.os,
      device: session.device,
      url_path: '/',
      url_query: session.urlQuery ?? '',
      utm_source: session.utmSource ?? '',
      utm_medium: session.utmMedium ?? '',
      referrer_domain: session.referrerDomain ?? '',
      event_type: 1,
      trust_tier: 0,
      is_bot: 0,
      created_at: clickhouseDate(session.createdAt),
    }));
    const revenue = fixture.revenue.map(row => ({
      website_id: row.websiteId,
      session_id: row.sessionId,
      event_id: row.eventId,
      event_name: 'purchase',
      currency: row.currency,
      revenue: row.revenue,
      created_at: clickhouseDate(row.createdAt),
    }));

    runCompose(
      db,
      'clickhouse',
      [
        'clickhouse-client',
        '--user=umami',
        '--password=umami',
        '--query=INSERT INTO umami.website_event FORMAT JSONEachRow',
      ],
      pageviews.map(row => JSON.stringify(row)).join('\n'),
    );
    runCompose(
      db,
      'clickhouse',
      [
        'clickhouse-client',
        '--user=umami',
        '--password=umami',
        '--query=INSERT INTO umami.website_revenue FORMAT JSONEachRow',
      ],
      revenue.map(row => JSON.stringify(row)).join('\n'),
    );
  }
}
