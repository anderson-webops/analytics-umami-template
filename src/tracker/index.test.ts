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
  window.sessionStorage.clear();
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
  expect(requests[0].payload.sessionSeed).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(requests[1].payload.sessionSeed).toBe(requests[0].payload.sessionSeed);
});

test('keeps a browsing-session seed across reloads but separates independent tabs', async () => {
  const script = document.createElement('script');
  script.src = 'https://analytics.example.com/script.js';
  script.dataset.websiteId = 'website-id';
  script.dataset.autoTrack = 'false';
  Object.defineProperty(document, 'currentScript', { configurable: true, value: script });

  const fetchMock = vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) });
  vi.stubGlobal('fetch', fetchMock);

  const collectSeed = async () => {
    await import('./index');
    await (window.umami?.track() ?? Promise.resolve());
    const body = JSON.parse(fetchMock.mock.lastCall?.[1].body);
    return body.payload.sessionSeed as string;
  };

  const first = await collectSeed();
  delete (window as Window & { umami?: unknown }).umami;
  vi.resetModules();
  const reloaded = await collectSeed();
  window.sessionStorage.clear();
  delete (window as Window & { umami?: unknown }).umami;
  vi.resetModules();
  const freshTab = await collectSeed();

  expect(reloaded).toBe(first);
  expect(freshTab).not.toBe(first);
});

test('rotates an opener-copied session seed without rotating it again on reload', async () => {
  const script = document.createElement('script');
  script.src = 'https://analytics.example.com/script.js';
  script.dataset.websiteId = 'website-id';
  script.dataset.autoTrack = 'false';
  Object.defineProperty(document, 'currentScript', { configurable: true, value: script });
  const copiedSeed = '44444444-4444-4444-8444-444444444444';
  const storageKey = 'umami.session:https://analytics.example.com/api/send:website-id';
  window.sessionStorage.setItem(storageKey, copiedSeed);
  vi.stubGlobal('opener', {
    location: { origin: location.origin },
    sessionStorage: { getItem: () => copiedSeed },
  });
  const fetchMock = vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) });
  vi.stubGlobal('fetch', fetchMock);

  await import('./index');
  await window.umami?.track();
  const rotated = JSON.parse(fetchMock.mock.lastCall?.[1].body).payload.sessionSeed;
  expect(rotated).not.toBe(copiedSeed);

  delete (window as Window & { umami?: unknown }).umami;
  vi.resetModules();
  await import('./index');
  await window.umami?.track();
  const reloaded = JSON.parse(fetchMock.mock.lastCall?.[1].body).payload.sessionSeed;

  expect(reloaded).toBe(rotated);
});

test('does not create session state when tracking is disabled', async () => {
  const script = document.createElement('script');
  script.src = 'https://analytics.example.com/script.js';
  script.dataset.websiteId = 'website-id';
  Object.defineProperty(document, 'currentScript', { configurable: true, value: script });
  window.localStorage.setItem('umami.disabled', '1');
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  try {
    await import('./index');
    await (window.umami?.track() ?? Promise.resolve());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.sessionStorage.length).toBe(0);
  } finally {
    window.localStorage.removeItem('umami.disabled');
  }
});

test('withdrawn tracking permission clears the browser session seed', async () => {
  const script = document.createElement('script');
  script.src = 'https://analytics.example.com/script.js';
  script.dataset.websiteId = 'website-id';
  script.dataset.autoTrack = 'false';
  Object.defineProperty(document, 'currentScript', { configurable: true, value: script });
  const fetchMock = vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) });
  vi.stubGlobal('fetch', fetchMock);

  try {
    await import('./index');
    await window.umami?.track();
    expect(window.sessionStorage.length).toBe(1);

    window.localStorage.setItem('umami.disabled', '1');
    await window.umami?.track();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(window.sessionStorage.length).toBe(0);
  } finally {
    window.localStorage.removeItem('umami.disabled');
  }
});

test('keeps same-page continuity without browser storage', async () => {
  const script = document.createElement('script');
  script.src = 'https://analytics.example.com/script.js';
  script.dataset.websiteId = 'website-id';
  script.dataset.autoTrack = 'false';
  Object.defineProperty(document, 'currentScript', { configurable: true, value: script });
  const storageDescriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    get: () => {
      throw new Error('storage unavailable');
    },
  });
  const fetchMock = vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({}) });
  vi.stubGlobal('fetch', fetchMock);

  try {
    await import('./index');
    await window.umami?.track();
    await window.umami?.track();

    const seeds = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).payload.sessionSeed);
    expect(seeds[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(seeds[1]).toBe(seeds[0]);
  } finally {
    if (storageDescriptor) Object.defineProperty(window, 'sessionStorage', storageDescriptor);
  }
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
