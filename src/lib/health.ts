import crypto from 'node:crypto';
import clickhouse from '@/lib/clickhouse';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';

const noStoreHeaders = {
  'Cache-Control': 'no-store',
};

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

export async function getReadiness() {
  let ready = true;

  try {
    await prisma.client.$queryRaw`SELECT 1`;
  } catch {
    ready = false;
  }

  if (redis.enabled) {
    try {
      await redis.client.connect();
      await redis.client.client.ping();
    } catch {
      ready = false;
    }
  }

  if (clickhouse.enabled) {
    try {
      const client = await clickhouse.connect();

      if (!client) {
        throw new Error('ClickHouse client unavailable');
      }

      await client.ping();
    } catch {
      ready = false;
    }
  }

  return ready;
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
