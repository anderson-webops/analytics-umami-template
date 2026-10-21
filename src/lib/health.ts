import crypto from 'node:crypto';
import clickhouse from '@/lib/clickhouse';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';

const noStoreHeaders = {
  'Cache-Control': 'no-store',
};
const READINESS_CACHE_TTL_MS = 2_000;
const READINESS_DEADLINE_MS = 1_500;
const READINESS_DEPENDENCY_TIMEOUT_MS = 1_000;

let cachedReadiness: { expiresAt: number; ready: boolean } | null = null;
let activeReadinessCheck: Promise<boolean> | null = null;
let activeReadinessResult: Promise<boolean> | null = null;
let activeReadinessTimer: ReturnType<typeof setTimeout> | null = null;

function secretsMatch(left: string, right: string): boolean {
  const leftDigest = crypto.createHash('sha256').update(left).digest();
  const rightDigest = crypto.createHash('sha256').update(right).digest();

  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

type ProbeMethod = 'GET' | 'HEAD';

function probeResponse(ok: boolean, status: number, method: ProbeMethod) {
  if (method === 'HEAD') {
    return new Response(null, { headers: noStoreHeaders, status });
  }

  return Response.json({ ok }, { headers: noStoreHeaders, status });
}

export function healthResponse(method: ProbeMethod = 'GET') {
  return probeResponse(true, 200, method);
}

async function checkDatabase() {
  try {
    await prisma.transaction(
      async transaction => {
        await transaction.$executeRawUnsafe(
          `SET LOCAL statement_timeout = '${READINESS_DEPENDENCY_TIMEOUT_MS}ms'`,
        );
        await transaction.$queryRaw`SELECT 1`;
      },
      {
        maxWait: READINESS_DEPENDENCY_TIMEOUT_MS,
        timeout: READINESS_DEPENDENCY_TIMEOUT_MS,
      },
    );
    return true;
  } catch {
    return false;
  }
}

async function checkRedis() {
  if (!redis.enabled) {
    return true;
  }

  try {
    await redis.client.connect(READINESS_DEPENDENCY_TIMEOUT_MS);
    await redis.client.client
      .withCommandOptions({ timeout: READINESS_DEPENDENCY_TIMEOUT_MS })
      .ping();
    return true;
  } catch {
    return false;
  }
}

async function checkClickhouse() {
  if (!clickhouse.enabled) {
    return true;
  }

  try {
    const client = await clickhouse.connect();

    if (!client) {
      return false;
    }

    const structureQueries = [
      'SELECT retention_policy, ingested_at FROM heatmap_event LIMIT 0',
      'SELECT retention_policy, ingested_at FROM session_replay LIMIT 0',
      ...['session_data', 'website_event', 'event_data'].map(
        table => `SELECT trust_tier FROM ${table} LIMIT 0`,
      ),
      'SELECT event_id FROM event_data_pivot_verified LIMIT 0',
    ];
    const structureChecks = Promise.all(
      structureQueries.map(async query => {
        const result = await client.query({
          query,
          format: 'JSONEachRow',
          abort_signal: AbortSignal.timeout(READINESS_DEPENDENCY_TIMEOUT_MS),
        });
        await result.json();
      }),
    );
    const viewCheck = client
      .query({
        query:
          "SELECT name, engine FROM system.tables WHERE database = currentDatabase() AND name IN ('event_data_pivot_verified_mv', 'website_revenue_mv')",
        format: 'JSONEachRow',
        abort_signal: AbortSignal.timeout(READINESS_DEPENDENCY_TIMEOUT_MS),
      })
      .then(result => result.json<{ name: string; engine: string }>());
    const [, views] = await Promise.all([structureChecks, viewCheck]);
    return (
      views.some(
        view => view.name === 'event_data_pivot_verified_mv' && view.engine === 'MaterializedView',
      ) && !views.some(view => view.name === 'website_revenue_mv')
    );
  } catch {
    return false;
  }
}

function beginReadinessCheck() {
  const check = Promise.all([checkDatabase(), checkRedis(), checkClickhouse()]).then(results =>
    results.every(Boolean),
  );
  const result = Promise.race([
    check,
    new Promise<boolean>(resolve => {
      activeReadinessTimer = setTimeout(() => resolve(false), READINESS_DEADLINE_MS);
    }),
  ]);

  activeReadinessCheck = check;
  activeReadinessResult = result;
  void result.then(ready => {
    if (activeReadinessResult === result) {
      cachedReadiness = { ready, expiresAt: Date.now() + READINESS_CACHE_TTL_MS };
    }
  });
  void check.then(ready => {
    if (activeReadinessCheck === check) {
      if (activeReadinessTimer) {
        clearTimeout(activeReadinessTimer);
      }
      cachedReadiness = { ready, expiresAt: Date.now() + READINESS_CACHE_TTL_MS };
      activeReadinessCheck = null;
      activeReadinessResult = null;
      activeReadinessTimer = null;
    }
  });

  return result;
}

export async function getReadiness() {
  if (cachedReadiness && cachedReadiness.expiresAt > Date.now()) {
    return cachedReadiness.ready;
  }

  return activeReadinessResult ?? beginReadinessCheck();
}

export function resetReadinessStateForTests() {
  if (activeReadinessTimer) {
    clearTimeout(activeReadinessTimer);
  }
  cachedReadiness = null;
  activeReadinessCheck = null;
  activeReadinessResult = null;
  activeReadinessTimer = null;
}

export function readyResponse(ready: boolean, method: ProbeMethod = 'GET') {
  return probeResponse(ready, ready ? 200 : 503, method);
}

export function canAccessInternalDiagnostics(request: Request): boolean {
  if (process.env.NODE_ENV !== 'production') {
    return true;
  }

  const requestKey = request.headers.get('x-internal-diagnostics-key');
  const expectedKey = process.env.INTERNAL_DIAGNOSTICS_KEY;

  return !!requestKey && !!expectedKey && secretsMatch(requestKey, expectedKey);
}

export function getDbInfo() {
  const databaseUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;

  return {
    databaseName: databaseUrl?.pathname.replace(/^\//, '') || null,
    host: databaseUrl?.hostname || null,
    schema: databaseUrl?.searchParams.get('schema') || null,
    redisEnabled: redis.enabled,
    clickhouseEnabled: clickhouse.enabled,
  };
}

export function forbiddenResponse() {
  return Response.json({ ok: false, error: 'forbidden' }, { headers: noStoreHeaders, status: 403 });
}
