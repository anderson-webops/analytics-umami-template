import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { authenticateMcpRequest } from '@/lib/mcp/auth';
import { DELETE, GET, POST } from './route';

const mcpFetch = vi.hoisted(() => vi.fn());

vi.mock('@umami/mcp', () => ({
  createUmamiMcpHttpHandler: () => ({ fetch: mcpFetch }),
}));
vi.mock('@/lib/mcp/auth', () => ({
  authenticateMcpRequest: vi.fn(),
  mcpAuthErrorResponse: () => new Response(null, { status: 401 }),
}));

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
