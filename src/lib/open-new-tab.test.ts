import { afterEach, expect, test, vi } from 'vitest';
import { openNewTab } from './open-new-tab';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('opens external pages without access to the application window', () => {
  const open = vi.fn();
  vi.stubGlobal('open', open);

  openNewTab('https://billing.example/settings/billing');

  expect(open).toHaveBeenCalledWith(
    'https://billing.example/settings/billing',
    '_blank',
    'noopener,noreferrer',
  );
});
