import { createHash } from 'node:crypto';
import { getExternalTrackerUrl, getTrackerScriptSha256 } from '@/lib/tracker-script';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_SCRIPT_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 5000;

let cachedScript: { key: string; bytes: Uint8Array } | undefined;
let pendingScript: { key: string; promise: Promise<Uint8Array> } | undefined;

async function fetchVerifiedScript(url: URL, expectedDigest: string) {
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'omit',
    headers: { Accept: 'text/javascript' },
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok || !response.body) {
    throw new Error('Tracker source unavailable');
  }

  const declaredLength = response.headers.get('content-length');

  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_SCRIPT_BYTES)
  ) {
    await response.body.cancel();
    throw new Error('Tracker source exceeds limit');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      size += value.byteLength;
      if (size > MAX_SCRIPT_BYTES) {
        throw new Error('Tracker source exceeds limit');
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  const bytes = Buffer.concat(chunks);

  if (createHash('sha256').update(bytes).digest('hex') !== expectedDigest) {
    throw new Error('Tracker source digest mismatch');
  }

  return new Uint8Array(bytes);
}

async function getVerifiedScript(url: URL, expectedDigest: string) {
  const key = `${url.href}\0${expectedDigest}`;

  if (cachedScript?.key === key) {
    return cachedScript.bytes;
  }

  if (pendingScript?.key === key) {
    return pendingScript.promise;
  }

  const promise = fetchVerifiedScript(url, expectedDigest).then(bytes => {
    cachedScript = { key, bytes };
    return bytes;
  });
  pendingScript = { key, promise };

  try {
    return await promise;
  } finally {
    if (pendingScript?.promise === promise) {
      pendingScript = undefined;
    }
  }
}

async function respond(includeBody: boolean) {
  const url = getExternalTrackerUrl();
  const digest = getTrackerScriptSha256();

  if (!url || !digest) {
    return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const bytes = await getVerifiedScript(url, digest);
    return new Response(includeBody ? new Uint8Array(bytes).buffer : null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400, must-revalidate',
        'Content-Length': String(bytes.byteLength),
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}

export async function GET() {
  return respond(true);
}

export async function HEAD() {
  return respond(false);
}
