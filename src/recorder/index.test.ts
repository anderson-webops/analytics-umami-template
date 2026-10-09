import { expect, test, vi } from 'vitest';

const { recordMock } = vi.hoisted(() => ({ recordMock: vi.fn((_options: unknown) => vi.fn()) }));

vi.mock('rrweb', () => ({ record: recordMock, addCustomEvent: vi.fn() }));

test('recorder blocks private elements and redacts navigation before sending', async () => {
  const script = document.createElement('script');
  script.setAttribute('data-website-id', 'synthetic-website');
  const originalCurrentScript = Object.getOwnPropertyDescriptor(document, 'currentScript');
  Object.defineProperty(document, 'currentScript', { configurable: true, value: script });
  vi.stubGlobal('umami', { getSession: () => ({ cache: 'synthetic-session' }) });
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      enabled: true,
      replayEnabled: true,
      heatmapEnabled: false,
      sampleRate: 1,
      blockSelector: '.custom-block',
    }),
  });
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
    emit({ type: 2, timestamp: 3, data: { node: { type: 0, childNodes: [] } } });

    const replayPayloads = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/api/record'))
      .map(([, options]) => JSON.parse(options.body));

    expect(replayPayloads).toHaveLength(2);
    expect(replayPayloads[0].payload.events[0].data.href).toBe('https://example.com/private');
    expect(replayPayloads[0].payload.events[1].data.payload.url).toBe('https://example.com/next');
    expect(JSON.stringify(replayPayloads)).not.toContain('secret');
  } finally {
    if (originalCurrentScript) {
      Object.defineProperty(document, 'currentScript', originalCurrentScript);
    } else {
      delete (document as Document & { currentScript?: HTMLScriptElement }).currentScript;
    }
    vi.unstubAllGlobals();
  }
});
