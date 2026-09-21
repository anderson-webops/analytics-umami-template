import { UmamiClient } from '@umami/api-client';
import type { McpLogger } from '@umami/mcp';
import { createUmamiMcpHttpHandler } from '@umami/mcp';
import debug from 'debug';
import { uuid } from '@/lib/crypto';
import { getBaseUrl } from '@/lib/get-base-url';
import { authenticateMcpRequest, mcpAuthErrorResponse } from '@/lib/mcp/auth';
import { createInProcessFetch } from '@/lib/mcp/dispatch';
import { RequestBodyTooLargeError, readRequestBodyBytes } from '@/lib/request-body';
import { payloadTooLarge } from '@/lib/response';

export const dynamic = 'force-dynamic';

const log = debug('umami:mcp');
const MAX_MCP_BODY_BYTES = 256 * 1024;

const logger: McpLogger = {
  info: event => log('%j', event),
  error: event => log('%j', event),
};

/**
 * Remote MCP endpoint (Streamable HTTP, protocol revision 2026-07-28, stateless).
 *
 * Request path: MCP client → bearer token → @umami/mcp → @umami/api-client → in-process API
 * route handlers → existing user/team authorization. MCP never touches storage directly.
 */
const handler = createUmamiMcpHttpHandler({
  logger,
  onerror: error => log('handler error: %s', error?.message),
  createClient: (authInfo, ctx) => {
    const baseUrl = getBaseUrl(ctx.requestInfo?.headers).toString().replace(/\/+$/, '');
    const basePath = (process.env.BASE_PATH ?? '').replace(/\/+$/, '');

    return new UmamiClient({
      baseUrl: `${baseUrl}${basePath}/api`,
      token: authInfo.token,
      fetch: createInProcessFetch(),
    });
  },
});

async function handle(request: Request) {
  if (process.env.MCP_ENABLED !== '1') {
    return new Response(null, { status: 404 });
  }

  const auth = await authenticateMcpRequest(request);

  if (!auth.ok) {
    return mcpAuthErrorResponse(auth);
  }

  let boundedRequest = request;

  if (!['GET', 'HEAD'].includes(request.method.toUpperCase()) && request.body) {
    try {
      const body = await readRequestBodyBytes(request, MAX_MCP_BODY_BYTES);

      boundedRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: body.byteLength ? body : undefined,
        signal: request.signal,
      });
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return payloadTooLarge();
      }

      throw error;
    }
  }

  const requestId = uuid();
  const authInfo = { ...auth.authInfo, extra: { ...auth.authInfo.extra, requestId } };

  return handler.fetch(boundedRequest, { authInfo });
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': '*',
      'access-control-max-age': '86400',
    },
  });
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}

export async function DELETE(request: Request) {
  return handle(request);
}
