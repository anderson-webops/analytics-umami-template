import crypto from 'node:crypto';
import clickhouse from '@/lib/clickhouse';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';

const noStoreHeaders = {
  'Cache-Control': 'no-store',
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'check-failed';
}

function secretsMatch(left: string, right: string): boolean {
  const leftDigest = crypto.createHash('sha256').update(left).digest();
  const rightDigest = crypto.createHash('sha256').update(right).digest();

  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

export function healthResponse() {
  return Response.json({ ok: true }, { headers: noStoreHeaders });
}

export async function getReadiness() {
  const components: Record<string, { ok: boolean; error?: string }> = {};

  try {
    await prisma.client.$queryRaw`SELECT 1`;
    components.db = { ok: true };
  } catch (error) {
    components.db = { ok: false, error: getErrorMessage(error) };
  }

  if (redis.enabled) {
    try {
      await redis.client.connect();
      await redis.client.client.ping();
      components.redis = { ok: true };
    } catch (error) {
      components.redis = { ok: false, error: getErrorMessage(error) };
    }
  }

  if (clickhouse.enabled) {
    try {
      const client = await clickhouse.connect();

      if (!client) {
        throw new Error('ClickHouse client unavailable');
      }

      await client.ping();
      components.clickhouse = { ok: true };
    } catch (error) {
      components.clickhouse = { ok: false, error: getErrorMessage(error) };
    }
  }

  const ready = Object.values(components).every(component => component.ok);

  return {
    ready,
    components,
  };
}

export function readyResponse(
  status: number,
  body: { ready: boolean; components?: Record<string, unknown> },
) {
  return Response.json(body, { headers: noStoreHeaders, status });
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
