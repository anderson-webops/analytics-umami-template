import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  newContext: vi.fn(),
  login: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('@playwright/test', () => ({
  test: { extend: (definitions: Record<string, unknown>) => definitions },
  request: { newContext: mocks.newContext },
  expect: () => undefined,
}));
vi.mock('../helpers/auth', () => ({ login: mocks.login }));
vi.mock('../client', () => ({
  ApiClient: class {
    bearer() {
      return this;
    }
    post(...argumentsList: unknown[]) {
      return mocks.post(...argumentsList);
    }
    del(...argumentsList: unknown[]) {
      return mocks.del(...argumentsList);
    }
  },
}));

import { test as fixtureDefinitions } from '../fixtures';

type FixtureFactory = (
  inputs: Record<string, unknown>,
  use: (value: unknown) => Promise<void>,
  worker: { project: { use: { baseURL: string } }; workerIndex: number },
) => Promise<void>;

const definitions = fixtureDefinitions as unknown as Record<string, [FixtureFactory, unknown]>;
const worker = { project: { use: { baseURL: 'http://localhost:53100' } }, workerIndex: 1 };
const seed = {
  admin: { username: 'admin', password: 'synthetic-admin-password' },
  user: { username: 'user' },
  viewer: { username: 'viewer' },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.newContext.mockResolvedValue({ dispose: mocks.dispose });
  mocks.login.mockImplementation(
    async (_client, credentials) => `synthetic-${credentials.username}`,
  );
  mocks.post.mockResolvedValue({ status: 200, body: { id: 'fixture-key', key: 'synthetic-key' } });
  mocks.del.mockResolvedValue({ status: 200 });
});

describe('lazy API-key worker fixture', () => {
  test('ordinary authenticated workers create no privileged API keys', async () => {
    const use = vi.fn(async () => undefined);
    await definitions.tokens[0]({ seed }, use, worker);
    expect(mocks.login).toHaveBeenCalledTimes(3);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(use).toHaveBeenCalledWith({
      admin: 'synthetic-admin',
      user: 'synthetic-user',
      viewer: 'synthetic-viewer',
    });
  });

  test('an explicitly requested key is removed even when its consumer fails', async () => {
    await expect(
      definitions.apiKeyCredentials[0](
        { seed, tokens: { admin: 'synthetic-admin' } },
        async () => {
          throw new Error('synthetic consumer failure');
        },
        worker,
      ),
    ).rejects.toThrow('synthetic consumer failure');
    expect(mocks.post).toHaveBeenCalledOnce();
    expect(mocks.del).toHaveBeenCalledWith('/api/me/api-keys/fixture-key');
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  test('a real issuance limit remains a failed fixture without a retry', async () => {
    mocks.post.mockResolvedValue({ status: 429, body: {}, text: 'Too many password attempts' });
    const use = vi.fn(async () => undefined);
    await expect(
      definitions.apiKeyCredentials[0]({ seed, tokens: { admin: 'synthetic-admin' } }, use, worker),
    ).rejects.toThrow('Failed to create API key (429)');
    expect(mocks.post).toHaveBeenCalledOnce();
    expect(mocks.del).not.toHaveBeenCalled();
    expect(use).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
