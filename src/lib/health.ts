import clickhouse from '@/lib/clickhouse';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';

const noStoreHeaders = {
  'Cache-Control': 'no-store',
};

const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'check-failed';
}

function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for');

  return forwardedFor?.split(',')[0]?.trim() || '';
}

export function healthResponse() {
  return Response.json({ ok: true }, { headers: noStoreHeaders });
}

export async function getReadiness() {
  const components: Record<string, { ok: boolean; error?: string }> = {};

  try {
    await prisma.client.$queryRawUnsafe('SELECT 1');
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
  body: { ready: boolean; components: Record<string, unknown> },
) {
  return Response.json(body, { headers: noStoreHeaders, status });
}

export function canAccessInternalDiagnostics(request: Request): boolean {
  if (process.env.NODE_ENV !== 'production') {
    return true;
  }

  const requestKey = request.headers.get('x-internal-diagnostics-key');

  if (process.env.INTERNAL_DIAGNOSTICS_KEY && requestKey === process.env.INTERNAL_DIAGNOSTICS_KEY) {
    return true;
  }

  return loopbackAddresses.has(getClientIp(request));
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
