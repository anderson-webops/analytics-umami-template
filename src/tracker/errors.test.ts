import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createErrorCollector } from './errors';

const WEBSITE = '11111111-1111-4111-8111-111111111111';
const SEED = '22222222-2222-4222-8222-222222222222';
const context = () => ({
  website: WEBSITE,
  hostname: 'example.com',
  sessionSeed: SEED,
  url: 'https://example.com/checkout?private=value',
  screen: '1280x720',
  language: 'en',
});

beforeEach(() => {
  vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(overrides: Partial<Parameters<typeof createErrorCollector>[0]> = {}) {
  const fetch = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ cache: 'next-cache' }) });
  vi.stubGlobal('fetch', fetch);
  const options = {
    endpoint: 'https://analytics.example/api/send',
    enabled: true,
    disabled: () => false,
    context,
    cache: () => undefined,
    updateCache: vi.fn(),
    release: 'synthetic',
    environment: 'test',
    beforeSend: vi.fn(async payload => payload),
    ...overrides,
  };
  return { collector: createErrorCollector(options), fetch, options };
}

test('collects scrubbed errors with the current browser seed and hostname', async () => {
  const { collector, fetch, options } = setup();
  await collector.captureException(new Error('Failed https://example.com/path?private=value'));
  await vi.waitFor(() => expect(options.updateCache).toHaveBeenCalledWith('next-cache'));
  const [url, init] = fetch.mock.calls[0];
  const body = JSON.parse(init.body);
  expect(url).toBe(options.endpoint);
  expect(init.credentials).toBe('omit');
  expect(body).toMatchObject({
    type: 'error',
    payload: {
      website: WEBSITE,
      hostname: 'example.com',
      sessionSeed: SEED,
      url: '/checkout',
      handled: true,
    },
  });
  expect(body.payload.message).not.toContain('?');
  expect(body.payload).not.toHaveProperty('id');
  expect(body.payload).not.toHaveProperty('generation');
});

test('keeps transport and session bindings stable across beforeSend hooks', async () => {
  const { collector, fetch } = setup({
    beforeSend: async payload => ({
      ...payload,
      website: 'other',
      hostname: 'other.example',
      sessionSeed: 'other',
      id: 'forged',
      salt: 'forged',
      timestamp: 1,
      eventId: 'other',
    }),
  });
  await collector.captureException(new Error('Synthetic failure'));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  const payload = JSON.parse(fetch.mock.calls[0][1].body).payload;
  expect(payload).toMatchObject({ website: WEBSITE, hostname: 'example.com', sessionSeed: SEED });
  expect(payload).not.toHaveProperty('id');
  expect(payload).not.toHaveProperty('salt');
  expect(payload.timestamp).toBeGreaterThan(1);
  expect(payload.eventId).toMatch(/^[a-f0-9-]{36}$/);
});

test.each(['disabled', 'filtered', 'opted-out'])(
  'sends nothing when collection is %s',
  async reason => {
    const { collector, fetch } = setup({
      enabled: reason !== 'disabled',
      disabled: () => reason === 'opted-out',
      beforeSend: async payload => (reason === 'filtered' ? null : payload),
    });
    await collector.captureException(new Error('Synthetic failure'));
    expect(fetch).not.toHaveBeenCalled();
  },
);

test.each(['generation', 'seed', 'salt', 'website', 'cache'])(
  'does not replace current cache after a %s transition',
  async transition => {
    let generation = 0;
    let current = { ...context(), salt: 'first' };
    let cache: string | undefined;
    const { collector, fetch, options } = setup({
      generation: () => generation,
      context: () => current,
      cache: () => cache,
    });
    let accept: (value: { ok: boolean; json: () => Promise<{ cache: string }> }) => void;
    fetch.mockReturnValueOnce(
      new Promise(resolve => {
        accept = resolve;
      }),
    );
    await collector.captureException(new Error('Synthetic failure'));
    expect(fetch).toHaveBeenCalledTimes(1);
    if (transition === 'generation') generation++;
    if (transition === 'seed') current = { ...current, sessionSeed: 'other' };
    if (transition === 'salt') current = { ...current, salt: 'second' };
    if (transition === 'website') current = { ...current, website: 'other' };
    if (transition === 'cache') cache = 'current-cache';
    const json = vi.fn(async () => ({ cache: 'stale-cache' }));
    accept({ ok: true, json });
    await vi.waitFor(() => expect(json).toHaveBeenCalledTimes(1));
    expect(options.updateCache).not.toHaveBeenCalled();
  },
);

test('honors opt-out while an asynchronous hook is preparing the event', async () => {
  let disabled = false;
  const { collector, fetch } = setup({
    disabled: () => disabled,
    beforeSend: async payload => {
      disabled = true;
      return payload;
    },
  });
  await collector.captureException(new Error('Synthetic failure'));
  expect(fetch).not.toHaveBeenCalled();
});

test('bounds the encoded event size before starting a request', async () => {
  const { collector, fetch } = setup({
    beforeSend: async payload => ({ ...payload, stack: 'x'.repeat(48001) }),
  });
  await collector.captureException(new Error('Synthetic failure'));
  expect(fetch).not.toHaveBeenCalled();
});

test('applies server throttling without retrying an error storm', async () => {
  const { collector, fetch } = setup();
  const headers = new Headers({ 'Retry-After': '60' });
  fetch.mockResolvedValue({ ok: false, status: 429, headers });
  await collector.captureException(new Error('First synthetic failure'));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await collector.captureException(new Error('Second synthetic failure'));
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('bounds automatic capture volume per minute', async () => {
  const { collector, fetch } = setup();
  for (let index = 0; index < 21; index++)
    await collector.captureException(new Error(`Synthetic failure ${index}`));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(20));
});

test('registers automatic capture with handled=false for browser errors', async () => {
  const { fetch } = setup();
  const handlers = vi.mocked(window.addEventListener).mock.calls;
  const listener = handlers.find(([name]) => name === 'error')[1] as EventListener;
  listener(
    new ErrorEvent('error', {
      message: 'Synthetic browser failure',
      error: new Error('Synthetic browser failure'),
    }),
  );
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(JSON.parse(fetch.mock.calls[0][1].body).payload.handled).toBe(false);
});

test('contains exceptions from error-object getters', async () => {
  const { collector, fetch } = setup();
  const value = Object.defineProperty({}, 'message', {
    get() {
      throw new Error('Synthetic getter failure');
    },
  });
  await expect(collector.captureException(value)).resolves.toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});
