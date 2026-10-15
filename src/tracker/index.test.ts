import { afterEach, expect, test, vi } from 'vitest';

const originalPushState = history.pushState;
const originalReplaceState = history.replaceState;

afterEach(() => {
  history.pushState = originalPushState;
  history.replaceState = originalReplaceState;
  delete (window as Window & { umami?: unknown }).umami;
  delete (document as Document & { currentScript?: HTMLScriptElement }).currentScript;
  delete (document as Document & { readyState?: DocumentReadyState }).readyState;
  vi.unstubAllGlobals();
  vi.resetModules();
});

test('identifies data-distinct-id before the initial page view', async () => {
  const script = document.createElement('script');
  script.src = 'https://analytics.example.com/script.js';
  script.dataset.websiteId = 'website-id';
  script.dataset.distinctId = 'visitor-id';

  Object.defineProperties(document, {
    currentScript: { configurable: true, value: script },
    readyState: { configurable: true, value: 'complete' },
  });

  const fetchMock = vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) });
  vi.stubGlobal('fetch', fetchMock);

  await import('./index');

  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  const requests = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));

  expect(requests[0]).toMatchObject({
    type: 'identify',
    payload: { id: 'visitor-id', website: 'website-id' },
  });
  expect(requests[1]).toMatchObject({
    type: 'event',
    payload: { id: 'visitor-id', website: 'website-id' },
  });
});

test('manual mode defers identification and preserves explicit tracking', async () => {
  const script = document.createElement('script');
  script.src = 'https://analytics.example.com/script.js';
  script.dataset.websiteId = 'website-id';
  script.dataset.distinctId = 'visitor-id';
  script.dataset.autoTrack = 'false';

  Object.defineProperties(document, {
    currentScript: { configurable: true, value: script },
    readyState: { configurable: true, value: 'complete' },
  });

  const fetchMock = vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) });
  vi.stubGlobal('fetch', fetchMock);

  await import('./index');

  expect(fetchMock).not.toHaveBeenCalled();

  const tracker = (
    window as Window & {
      umami?: { track: () => Promise<void>; identify: (id: string) => Promise<void> };
    }
  ).umami;

  await tracker?.track();
  await tracker?.identify('new-visitor-id');

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body))).toMatchObject([
    { type: 'event', payload: { id: 'visitor-id', website: 'website-id' } },
    { type: 'identify', payload: { id: 'new-visitor-id', website: 'website-id' } },
  ]);
});

test('removes private URL components from automatic and explicit tracking', async () => {
  const originalUrl = location.href;
  history.replaceState(null, '', '/reset?code=SYNTHETIC-PAGE&utm_source=news#private-page');

  const script = document.createElement('script');
  script.src = 'https://analytics.example.com/script.js';
  script.dataset.websiteId = 'website-id';

  Object.defineProperties(document, {
    currentScript: { configurable: true, value: script },
    referrer: {
      configurable: true,
      value: 'https://search.example/results?q=SYNTHETIC-REFERRER#private-referrer',
    },
    readyState: { configurable: true, value: 'complete' },
  });

  const fetchMock = vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) });
  vi.stubGlobal('fetch', fetchMock);

  try {
    await import('./index');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const tracker = (window as Window & { umami?: { track: (payload: object) => Promise<void> } })
      .umami;
    await tracker?.track({
      website: 'website-id',
      url: '/override?token=SYNTHETIC-MANUAL&utm_medium=email#private-manual',
      referrer: 'https://other.example/path?session=SYNTHETIC-SESSION',
    });
    await tracker?.track({
      website: 'website-id',
      url: new URL('https://user:password@example.com/page?code=SYNTHETIC-OBJECT#secret'),
      referrer: new URL('https://other.example/path?key=SYNTHETIC-OBJECT-REFERRER'),
    });

    const payloads = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).payload);
    expect(payloads[0]).toMatchObject({
      url: `${location.origin}/reset?utm_source=news`,
      referrer: 'https://search.example/results',
    });
    expect(payloads[1]).toMatchObject({
      url: `${location.origin}/override?utm_medium=email`,
      referrer: 'https://other.example/path',
    });
    expect(payloads[2]).toMatchObject({
      url: 'https://example.com/page',
      referrer: 'https://other.example/path',
    });
    expect(JSON.stringify(payloads)).not.toContain('SYNTHETIC-');
    expect(JSON.stringify(payloads)).not.toContain('private-');
  } finally {
    history.replaceState(null, '', originalUrl);
    delete (document as Document & { referrer?: string }).referrer;
  }
});

test('sanitizes URLs added by a before-send callback', async () => {
  const script = document.createElement('script');
  script.src = 'https://analytics.example.com/script.js';
  script.dataset.websiteId = 'website-id';
  script.dataset.beforeSend = 'addPrivateUrl';

  Object.defineProperties(document, {
    currentScript: { configurable: true, value: script },
    readyState: { configurable: true, value: 'complete' },
  });

  vi.stubGlobal('addPrivateUrl', (_type: string, payload: object) => ({
    ...payload,
    url: '/callback?code=SYNTHETIC-CALLBACK&utm_campaign=fall#private-callback',
  }));
  const fetchMock = vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) });
  vi.stubGlobal('fetch', fetchMock);

  await import('./index');
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

  const payload = JSON.parse(fetchMock.mock.calls[0][1].body).payload;
  expect(payload.url).toBe(`${location.origin}/callback?utm_campaign=fall`);
  expect(JSON.stringify(payload)).not.toContain('SYNTHETIC-CALLBACK');
});

test('does not serialize unsupported URL objects from explicit tracking', async () => {
  const script = document.createElement('script');
  script.src = 'https://analytics.example.com/script.js';
  script.dataset.websiteId = 'website-id';
  script.dataset.autoTrack = 'false';

  Object.defineProperty(document, 'currentScript', { configurable: true, value: script });
  const fetchMock = vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) });
  vi.stubGlobal('fetch', fetchMock);

  await import('./index');

  const tracker = (window as Window & { umami?: { track: (payload: object) => Promise<void> } })
    .umami;
  await tracker?.track({
    website: 'website-id',
    url: { toJSON: () => 'https://example.com/?token=SYNTHETIC-OBJECT' },
  });
  await tracker?.track({ website: 'website-id', url: 'mailto:help@example.com?token=private' });

  expect(fetchMock).not.toHaveBeenCalled();
});

test('counts hash-only history transitions without sending fragments', async () => {
  const originalUrl = location.href;
  history.replaceState(null, '', '/app#/home');
  const script = document.createElement('script');
  script.src = 'https://analytics.example.com/script.js';
  script.dataset.websiteId = 'website-id';
  Object.defineProperties(document, {
    currentScript: { configurable: true, value: script },
    readyState: { configurable: true, value: 'complete' },
  });

  const fetchMock = vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) });
  vi.stubGlobal('fetch', fetchMock);

  try {
    await import('./index');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    history.pushState(null, '', '/app#/billing');
    await vi.advanceTimersByTimeAsync(300);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const payloads = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).payload);
    expect(payloads[0].url).toBe(`${location.origin}/app`);
    expect(payloads[1].url).toBe(`${location.origin}/app`);
    expect(JSON.stringify(payloads)).not.toContain('#/home');
    expect(JSON.stringify(payloads)).not.toContain('#/billing');
  } finally {
    vi.useRealTimers();
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    history.replaceState(null, '', originalUrl);
  }
});
