import { expect, test, vi } from 'vitest';

const { recordMock } = vi.hoisted(() => ({ recordMock: vi.fn((_options: unknown) => vi.fn()) }));

vi.mock('rrweb', () => ({ record: recordMock, addCustomEvent: vi.fn() }));

test('website settings cannot replace the built-in credential block class', async () => {
  const script = document.createElement('script');
  script.setAttribute('data-website-id', 'synthetic-website');
  const originalCurrentScript = Object.getOwnPropertyDescriptor(document, 'currentScript');
  Object.defineProperty(document, 'currentScript', { configurable: true, value: script });
  vi.stubGlobal('umami', { getSession: () => ({ cache: 'synthetic-session' }) });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        enabled: true,
        replayEnabled: true,
        heatmapEnabled: false,
        sampleRate: 1,
        blockSelector: '.custom-block',
      }),
    }),
  );
  vi.spyOn(window, 'setInterval').mockReturnValue(1 as unknown as ReturnType<typeof setInterval>);

  try {
    await import('./index.js');
    await vi.waitFor(() => expect(recordMock).toHaveBeenCalled());
    expect(recordMock.mock.calls[0][0]).toMatchObject({
      blockClass: 'rr-block',
      blockSelector: '.custom-block',
    });
  } finally {
    if (originalCurrentScript) {
      Object.defineProperty(document, 'currentScript', originalCurrentScript);
    } else {
      delete (document as Document & { currentScript?: HTMLScriptElement }).currentScript;
    }
    vi.unstubAllGlobals();
  }
});
