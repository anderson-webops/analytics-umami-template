import { expect, test, vi } from 'vitest';

const { recordMock } = vi.hoisted(() => ({ recordMock: vi.fn((_options: unknown) => vi.fn()) }));

vi.mock('rrweb', () => ({ record: recordMock, addCustomEvent: vi.fn() }));

test('recorder blocks private elements and redacts navigation before sending', async () => {
  const script = document.createElement('script');
  script.setAttribute('data-website-id', 'synthetic-website');
  script.setAttribute('data-permit-endpoint', '/analytics-permit');
  const originalCurrentScript = Object.getOwnPropertyDescriptor(document, 'currentScript');
  Object.defineProperty(document, 'currentScript', { configurable: true, value: script });
  vi.stubGlobal('umami', { getSession: () => ({ cache: 'synthetic-session' }) });
  const fetchMock = vi.fn(async (url: RequestInfo | URL, _options?: RequestInit) => ({
    ok: true,
    json: async () =>
      String(url).endsWith('/analytics-permit')
        ? { permit: 'synthetic-permit' }
        : {
            enabled: true,
            replayEnabled: true,
            heatmapEnabled: false,
            maskLevel: 'strict',
            sampleRate: 1,
            blockSelector: '.custom-block',
          },
  }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(window, 'setInterval').mockReturnValue(1 as unknown as ReturnType<typeof setInterval>);

  try {
    await import('./index.js');
    await vi.waitFor(() => expect(recordMock).toHaveBeenCalled());
    expect(recordMock.mock.calls[0][0]).toMatchObject({
      blockClass: 'rr-block',
      blockSelector: '.custom-block',
    });

    const { emit } = recordMock.mock.calls[0][0] as { emit: (event: unknown) => void };
    emit({
      type: 4,
      timestamp: 1,
      data: { href: 'https://example.com/private?reset=secret#fragment', width: 800 },
    });
    emit({
      type: 5,
      timestamp: 2,
      data: { tag: 'url-change', payload: { url: 'https://example.com/next?code=secret' } },
    });
    emit({
      type: 3,
      timestamp: 3,
      data: { id: 4, isChecked: true, value: 'private-answer' },
    });
    emit({
      type: 2,
      timestamp: 4,
      data: {
        node: {
          type: 0,
          childNodes: [
            {
              type: 2,
              id: 3,
              tagName: 'img',
              attributes: {
                alt: 'private-alt',
                'aria-label': 'private-label',
                title: 'private-title',
                src: 'https://assets.example/photo?token=image-secret',
              },
              childNodes: [],
            },
          ],
        },
      },
    });

    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/record')),
      ).toHaveLength(2),
    );
    const replayPayloads = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/api/record'))
      .map(call => {
        const options = call[1];
        if (!options?.body) throw new Error('Missing replay request body.');
        return JSON.parse(String(options.body));
      });

    expect(replayPayloads).toHaveLength(2);
    expect(replayPayloads[0].payload.events[0].data.href).toBe('');
    expect(replayPayloads[0].payload.events[1].data.payload).toEqual({});
    expect(replayPayloads[0].payload.events[2].data).toEqual({ id: 4, value: '' });
    expect(replayPayloads[1].payload.events[0].data.node.childNodes[0].attributes).toEqual({});
    expect(JSON.stringify(replayPayloads)).not.toContain('private');
    expect(JSON.stringify(replayPayloads)).not.toContain('secret');
  } finally {
    if (originalCurrentScript) {
      Object.defineProperty(document, 'currentScript', originalCurrentScript);
    } else {
      delete (document as Document & { currentScript?: HTMLScriptElement }).currentScript;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

test('recorder sends a large masked snapshot as one complete fragment request', async () => {
  vi.resetModules();
  recordMock.mockClear();
  const script = document.createElement('script');
  script.setAttribute('data-website-id', 'synthetic-website');
  script.setAttribute('data-permit-endpoint', '/analytics-permit');
  const originalCurrentScript = Object.getOwnPropertyDescriptor(document, 'currentScript');
  Object.defineProperty(document, 'currentScript', { configurable: true, value: script });
  vi.stubGlobal('umami', { getSession: () => ({ cache: 'synthetic-session' }) });
  const fetchMock = vi.fn(async (url: RequestInfo | URL, _options?: RequestInit) => ({
    ok: true,
    json: async () =>
      String(url).endsWith('/analytics-permit')
        ? { permit: 'synthetic-permit' }
        : { enabled: true, replayEnabled: true, maskLevel: 'strict', sampleRate: 1 },
  }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(window, 'setInterval').mockReturnValue(1 as unknown as ReturnType<typeof setInterval>);

  try {
    await import('./index.js');
    await vi.waitFor(() => expect(recordMock).toHaveBeenCalledOnce());
    const { emit } = recordMock.mock.calls[0][0] as { emit: (event: unknown) => void };
    emit({
      type: 2,
      timestamp: Date.now(),
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: Array.from({ length: 7_500 }, (_, index) => ({
            type: 2,
            id: index + 2,
            tagName: 'div',
            attributes: {},
            childNodes: [],
          })),
        },
      },
    });

    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/record')),
      ).toHaveLength(1),
    );
    const request = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/record'));
    const body = JSON.parse(String(request?.[1]?.body));
    const fragments = body.payload.events;
    expect(fragments.length).toBeGreaterThan(1);
    expect(
      fragments.every(
        (fragment: any, index: number) =>
          fragment.data.index === index && fragment.data.total === fragments.length,
      ),
    ).toBe(true);
    expect(
      JSON.parse(fragments.map((fragment: any) => fragment.data.value).join('')).data.node
        .childNodes,
    ).toHaveLength(7_500);
    expect(request?.[1]?.keepalive).toBe(false);
    expect(request?.[1]?.headers).toMatchObject({ 'x-umami-record-batch': '1' });

    emit({
      type: 2,
      timestamp: Date.now(),
      data: { node: { type: 0, id: 20_000, childNodes: [] } },
    });
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/record')),
      ).toHaveLength(2),
    );
    const nextRequest = fetchMock.mock.calls.find(
      ([url, options]) =>
        String(url).endsWith('/api/record') &&
        !('x-umami-record-batch' in (options?.headers || {})),
    );
    const nextBody = JSON.parse(String(nextRequest?.[1]?.body));
    expect(nextBody.payload.timestamp).toBeGreaterThanOrEqual(
      body.payload.timestamp + fragments.length,
    );
  } finally {
    if (originalCurrentScript) {
      Object.defineProperty(document, 'currentScript', originalCurrentScript);
    } else {
      delete (document as Document & { currentScript?: HTMLScriptElement }).currentScript;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

test('recorder does not capture without a site-owned permit endpoint', async () => {
  vi.resetModules();
  recordMock.mockClear();
  const script = document.createElement('script');
  script.setAttribute('data-website-id', 'synthetic-website');
  const originalCurrentScript = Object.getOwnPropertyDescriptor(document, 'currentScript');
  Object.defineProperty(document, 'currentScript', { configurable: true, value: script });
  vi.stubGlobal('umami', { getSession: () => ({ cache: 'synthetic-session' }) });
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ enabled: true, replayEnabled: true, maskLevel: 'strict', sampleRate: 1 }),
  }));
  vi.stubGlobal('fetch', fetchMock);

  try {
    await import('./index.js');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(recordMock).not.toHaveBeenCalled();
  } finally {
    if (originalCurrentScript) {
      Object.defineProperty(document, 'currentScript', originalCurrentScript);
    } else {
      delete (document as Document & { currentScript?: HTMLScriptElement }).currentScript;
    }
    vi.unstubAllGlobals();
  }
});

test('recorder stops capturing when periodic consent renewal is denied', async () => {
  vi.resetModules();
  recordMock.mockClear();
  const script = document.createElement('script');
  script.setAttribute('data-website-id', 'synthetic-website');
  script.setAttribute('data-permit-endpoint', '/analytics-permit');
  const originalCurrentScript = Object.getOwnPropertyDescriptor(document, 'currentScript');
  Object.defineProperty(document, 'currentScript', { configurable: true, value: script });
  vi.stubGlobal('umami', { getSession: () => ({ cache: 'synthetic-session' }) });
  let permitAllowed = true;
  let now = 1_800_000_000_000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const intervals = vi
    .spyOn(window, 'setInterval')
    .mockReturnValue(1 as unknown as ReturnType<typeof setInterval>);
  const fetchMock = vi.fn(async (url: RequestInfo | URL) =>
    String(url).endsWith('/analytics-permit')
      ? { ok: permitAllowed, json: async () => ({ permit: 'synthetic-permit' }) }
      : {
          ok: true,
          json: async () => ({
            enabled: true,
            replayEnabled: true,
            heatmapEnabled: false,
            maskLevel: 'strict',
            sampleRate: 1,
          }),
        },
  );
  vi.stubGlobal('fetch', fetchMock);

  try {
    await import('./index.js');
    await vi.waitFor(() => expect(recordMock).toHaveBeenCalledOnce());
    const stopCapture = recordMock.mock.results[0].value as ReturnType<typeof vi.fn>;
    const renew = intervals.mock.calls.find(([, delay]) => delay === 15_000)?.[0];
    if (!renew) throw new Error('Expected a periodic permit renewal.');

    permitAllowed = false;
    now += 15_001;
    renew();

    await vi.waitFor(() => expect(stopCapture).toHaveBeenCalledOnce());
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/analytics-permit')),
    ).toHaveLength(2);
  } finally {
    if (originalCurrentScript) {
      Object.defineProperty(document, 'currentScript', originalCurrentScript);
    } else {
      delete (document as Document & { currentScript?: HTMLScriptElement }).currentScript;
    }
    clock.mockRestore();
    intervals.mockRestore();
    vi.unstubAllGlobals();
  }
});

test.each(['record', 'heatmap'])(
  '%s capture expires while permit renewal remains pending',
  async feature => {
    vi.resetModules();
    recordMock.mockClear();
    const script = document.createElement('script');
    script.setAttribute('data-website-id', 'synthetic-website');
    script.setAttribute('data-permit-endpoint', '/analytics-permit');
    const originalCurrentScript = Object.getOwnPropertyDescriptor(document, 'currentScript');
    Object.defineProperty(document, 'currentScript', { configurable: true, value: script });
    vi.stubGlobal('umami', { getSession: () => ({ cache: 'synthetic-session' }) });
    let now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const intervals = vi
      .spyOn(window, 'setInterval')
      .mockReturnValue(1 as unknown as ReturnType<typeof setInterval>);
    const timeouts = vi.spyOn(window, 'setTimeout');
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener');
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    let resolveRenewal:
      | ((value: { ok: boolean; json: () => Promise<unknown> }) => void)
      | undefined;
    const delayedRenewal = new Promise<{ ok: boolean; json: () => Promise<unknown> }>(resolve => {
      resolveRenewal = resolve;
    });
    let permitCalls = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/analytics-permit')) {
        permitCalls += 1;
        return permitCalls === 1
          ? { ok: true, json: async () => ({ permit: 'synthetic-permit' }) }
          : delayedRenewal;
      }

      return {
        ok: true,
        json: async () => ({
          enabled: true,
          replayEnabled: feature === 'record',
          heatmapEnabled: feature === 'heatmap',
          maskLevel: 'strict',
          sampleRate: 1,
          heatmapSampleRate: 1,
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await import('./index.js');
      await vi.waitFor(() => expect(permitCalls).toBe(1));
      const renew = intervals.mock.calls.find(([, delay]) => delay === 15_000)?.[0];
      const expire = timeouts.mock.calls.find(([, delay]) => delay === 30_000)?.[0];
      if (!renew || typeof expire !== 'function') throw new Error('Expected permit timers.');

      now += 15_001;
      renew();
      await vi.waitFor(() => expect(permitCalls).toBe(2));
      now += 15_000;
      expire();

      expect(clearIntervalSpy).toHaveBeenCalledWith(1);
      if (feature === 'record') {
        const stopCapture = recordMock.mock.results[0]?.value as ReturnType<typeof vi.fn>;
        expect(stopCapture).toHaveBeenCalledOnce();
      } else {
        expect(recordMock).not.toHaveBeenCalled();
        expect(removeDocumentListener).toHaveBeenCalledWith('click', expect.any(Function), true);
        expect(history.pushState).toBe(originalPushState);
        expect(history.replaceState).toBe(originalReplaceState);
      }

      resolveRenewal?.({ ok: true, json: async () => ({ permit: 'late-permit' }) });
      await Promise.resolve();
      await Promise.resolve();
      expect(timeouts.mock.calls.filter(([, delay]) => delay === 30_000)).toHaveLength(1);
    } finally {
      if (originalCurrentScript) {
        Object.defineProperty(document, 'currentScript', originalCurrentScript);
      } else {
        delete (document as Document & { currentScript?: HTMLScriptElement }).currentScript;
      }
      clock.mockRestore();
      intervals.mockRestore();
      timeouts.mockRestore();
      clearIntervalSpy.mockRestore();
      removeDocumentListener.mockRestore();
      vi.unstubAllGlobals();
    }
  },
);

test('initial capture never starts after its permit expires while another feature loads', async () => {
  vi.resetModules();
  recordMock.mockClear();
  const script = document.createElement('script');
  script.setAttribute('data-website-id', 'synthetic-website');
  script.setAttribute('data-permit-endpoint', '/analytics-permit');
  const originalCurrentScript = Object.getOwnPropertyDescriptor(document, 'currentScript');
  Object.defineProperty(document, 'currentScript', { configurable: true, value: script });
  vi.stubGlobal('umami', { getSession: () => ({ cache: 'synthetic-session' }) });
  let now = 1_800_000_000_000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const timeouts = vi.spyOn(window, 'setTimeout');
  const intervals = vi.spyOn(window, 'setInterval');
  let resolveHeatmap: ((value: { ok: boolean; json: () => Promise<unknown> }) => void) | undefined;
  const delayedHeatmap = new Promise<{ ok: boolean; json: () => Promise<unknown> }>(resolve => {
    resolveHeatmap = resolve;
  });
  let permitCalls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/analytics-permit')) {
        permitCalls += 1;
        return permitCalls === 1
          ? { ok: true, json: async () => ({ permit: 'replay-permit' }) }
          : delayedHeatmap;
      }

      return {
        ok: true,
        json: async () => ({
          enabled: true,
          replayEnabled: true,
          heatmapEnabled: true,
          maskLevel: 'strict',
          sampleRate: 1,
          heatmapSampleRate: 1,
        }),
      };
    }),
  );

  try {
    await import('./index.js');
    await vi.waitFor(() => expect(permitCalls).toBe(2));
    const expire = timeouts.mock.calls.find(([, delay]) => delay === 30_000)?.[0];
    if (typeof expire !== 'function') throw new Error('Expected replay permit expiry.');

    now += 30_001;
    expire();
    resolveHeatmap?.({ ok: true, json: async () => ({ permit: 'late-heatmap-permit' }) });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(recordMock).not.toHaveBeenCalled();
    expect(intervals.mock.calls.some(([, delay]) => delay === 15_000)).toBe(false);
  } finally {
    if (originalCurrentScript) {
      Object.defineProperty(document, 'currentScript', originalCurrentScript);
    } else {
      delete (document as Document & { currentScript?: HTMLScriptElement }).currentScript;
    }
    clock.mockRestore();
    timeouts.mockRestore();
    intervals.mockRestore();
    vi.unstubAllGlobals();
  }
});
