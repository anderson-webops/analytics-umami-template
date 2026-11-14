import { render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getTestRouter } from '@/test/navigation';
import RootPage from './page';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test('lets authenticated routing verify the same-origin cookie without requiring a stored token', () => {
  render(<RootPage />);

  expect(getTestRouter().replace).toHaveBeenCalledWith('/websites');
});

test('a legacy stored token does not alter the cookie-authenticated websites route', () => {
  localStorage.setItem('umami.auth', JSON.stringify('token'));

  render(<RootPage />);

  expect(getTestRouter().replace).toHaveBeenCalledWith('/websites');
});

test('restores the last team without reading a browser-stored credential', () => {
  localStorage.setItem('umami.last-team', JSON.stringify('team-1'));

  render(<RootPage />);

  expect(getTestRouter().replace).toHaveBeenCalledWith('/teams/team-1/websites');
});

test('keeps the normal flow in cloud mode', () => {
  vi.stubEnv('cloudMode', '1');

  render(<RootPage />);

  expect(getTestRouter().replace).toHaveBeenCalledWith('/websites');
});
