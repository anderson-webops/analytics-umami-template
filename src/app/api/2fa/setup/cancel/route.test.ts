import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SessionRevokedError } from '@/queries/prisma/authorization';
import { POST } from './route';

const mocks = vi.hoisted(() => ({
  parseRequest: vi.fn(),
  runActiveSessionMutation: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock('@/lib/request', () => ({
  parseRequest: mocks.parseRequest,
}));

vi.mock('@/queries/prisma/authorization', () => ({
  SessionRevokedError: class SessionRevokedError extends Error {},
  runActiveSessionMutation: mocks.runActiveSessionMutation,
}));

beforeEach(() => {
  vi.stubEnv('CLOUD_MODE', '0');
  mocks.parseRequest.mockReset().mockResolvedValue({
    auth: { authType: 'session', user: { id: 'user-1' } },
    error: undefined,
  });
  mocks.deleteMany.mockReset().mockResolvedValue({ count: 1 });
  mocks.runActiveSessionMutation
    .mockReset()
    .mockImplementation((_, operation) =>
      operation({ twoFactorAuth: { deleteMany: mocks.deleteMany } }),
    );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test('POST cancels only the current user pending setup inside the session mutation', async () => {
  const response = await POST(
    new Request('http://localhost/api/2fa/setup/cancel', { method: 'POST' }),
  );

  expect(response.status).toBe(200);
  expect(mocks.runActiveSessionMutation).toHaveBeenCalledTimes(1);
  expect(mocks.deleteMany).toHaveBeenCalledWith({
    where: { userId: 'user-1', isEnabled: false },
  });
});

test('POST rejects a revoked session without deleting the setup', async () => {
  mocks.runActiveSessionMutation.mockRejectedValue(new SessionRevokedError());

  const response = await POST(
    new Request('http://localhost/api/2fa/setup/cancel', { method: 'POST' }),
  );

  expect(response.status).toBe(401);
  expect(mocks.deleteMany).not.toHaveBeenCalled();
});

test('POST rejects non-session credentials before any mutation', async () => {
  mocks.parseRequest.mockResolvedValue({ auth: { authType: 'api-key', user: { id: 'user-1' } } });

  const response = await POST(
    new Request('http://localhost/api/2fa/setup/cancel', { method: 'POST' }),
  );

  expect(response.status).toBe(401);
  expect(mocks.runActiveSessionMutation).not.toHaveBeenCalled();
});

test('POST remains unavailable in cloud mode', async () => {
  vi.stubEnv('CLOUD_MODE', '1');

  const response = await POST(
    new Request('http://localhost/api/2fa/setup/cancel', { method: 'POST' }),
  );

  expect(response.status).toBe(404);
  expect(mocks.parseRequest).not.toHaveBeenCalled();
});
