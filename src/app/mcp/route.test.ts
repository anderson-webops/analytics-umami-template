import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { authenticateMcpRequest } from '@/lib/mcp/auth';
import { DELETE, GET, POST } from './route';

const mcpHandler = vi.hoisted(() => ({ fetch: vi.fn(), options: {} as any }));
const mcpFetch = mcpHandler.fetch;
const inProcessFetch = vi.hoisted(() =>
  vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
);

vi.mock('@umami/mcp', () => ({
  createUmamiMcpHttpHandler: (options: any) => {
    mcpHandler.options = options;
    return { fetch: mcpHandler.fetch };
  },
}));
vi.mock('@/lib/mcp/auth', () => ({
  authenticateMcpRequest: vi.fn(),
  mcpAuthErrorResponse: () => new Response(null, { status: 401 }),
}));
vi.mock('@/lib/mcp/dispatch', () => ({ createInProcessFetch: () => inProcessFetch }));

beforeEach(() => {
  mcpFetch.mockReset();
  vi.mocked(authenticateMcpRequest).mockReset();
  vi.mocked(authenticateMcpRequest).mockResolvedValue({
    ok: false,
    status: 401,
    error: 'invalid_request',
    description: 'Missing bearer API key.',
  });
});

afterEach(() => vi.unstubAllEnvs());

test.each([undefined, '', '0', 'true'])('MCP stays disabled for MCP_ENABLED=%s', async value => {
  vi.stubEnv('MCP_ENABLED', value);
  for (const handler of [GET, POST, DELETE]) {
    const response = await handler(new Request('http://localhost/mcp'));
    expect(response.status).toBe(404);
  }
  expect(authenticateMcpRequest).not.toHaveBeenCalled();
});

test('MCP_ENABLED=1 enables API-key authentication', async () => {
  vi.stubEnv('MCP_ENABLED', '1');
  const request = new Request('http://localhost/mcp');
  const response = await POST(request);
  expect(response.status).toBe(401);
  expect(authenticateMcpRequest).toHaveBeenCalledWith(request);
});

test('hosted MCP uses in-process API dispatch behind an HTTP LAN development proxy', async () => {
  vi.stubEnv('PUBLIC_URL', '');
  vi.stubEnv('BASE_PATH', '/analytics');
  inProcessFetch.mockClear();
  const client = mcpHandler.options.createClient(
    { token: 'synthetic-token' },
    {
      requestInfo: {
        headers: new Headers({
          'x-forwarded-host': '192.168.1.10:3000',
          'x-forwarded-proto': 'http',
        }),
      },
    },
  );

  expect(client.baseUrl).toBe('https://mcp-internal.invalid/analytics/api');
  await expect(client.listWebsites()).resolves.toBe('{"data":[]}');
  expect(inProcessFetch).toHaveBeenCalledWith(
    new URL('https://mcp-internal.invalid/analytics/api/websites'),
    expect.objectContaining({ redirect: 'error' }),
  );
});

test('an authenticated MCP request is cancelled before an oversized chunked body is buffered', async () => {
  vi.stubEnv('MCP_ENABLED', '1');
  vi.mocked(authenticateMcpRequest).mockResolvedValue({
    ok: true,
    userId: 'user-1',
    authInfo: {
      token: 'umami_key',
      clientId: 'api-key:key-1',
      scopes: [],
      extra: { userId: 'user-1' },
    },
  });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(160 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer umami_key',
      'content-length': '1',
      'content-type': 'application/json',
    },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

  const response = await POST(request);

  expect(response.status).toBe(413);
  expect(cancelled).toBe(true);
  expect(mcpFetch).not.toHaveBeenCalled();
});
