import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { getColor, getPastel } from '@/lib/colors';
import { Avatar } from './Avatar';

function avatarSvg() {
  const source = screen.getByRole('img', { name: 'Avatar' }).getAttribute('src');
  expect(source).toMatch(/^data:image\/svg\+xml[;,]/);
  const separator = source.indexOf(',');
  const svg = source.slice(0, separator).includes(';base64')
    ? atob(source.slice(separator + 1))
    : decodeURIComponent(source.slice(separator + 1));
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  expect(document.querySelector('parsererror')).toBeNull();
  expect(document.documentElement.localName).toBe('svg');
  return { source, document };
}

test('renders a deterministic local Lorelei avatar with its seeded background', () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const first = render(<Avatar seed="analytics-session-one" />);
  const avatar = avatarSvg();

  expect(avatar.document.documentElement.getAttribute('width')).toBe('128');
  expect(avatar.document.documentElement.getAttribute('height')).toBe('128');
  expect(avatar.document.querySelector('path')).not.toBeNull();
  expect(
    avatar.document.querySelector(`[fill="#${getPastel(getColor('analytics-session-one'), 4)}"]`),
  ).not.toBeNull();
  expect(screen.getByRole('img')).toHaveStyle({ borderRadius: '100%', width: '128px' });
  first.unmount();
  render(<Avatar seed="analytics-session-one" />);

  expect(avatarSvg().source).toBe(avatar.source);
  expect(fetch).not.toHaveBeenCalled();
});

test('updates the generated avatar when the session seed changes', () => {
  const view = render(<Avatar seed="analytics-session-one" size={32} />);
  const original = avatarSvg().source;
  view.rerender(<Avatar seed="analytics-session-two" size={32} />);

  expect(avatarSvg().source).not.toBe(original);
});

test('keeps the generated SVG and display size aligned after resizing', () => {
  const view = render(<Avatar seed="analytics-session-one" size={32} />);
  expect(avatarSvg().document.documentElement.getAttribute('width')).toBe('32');
  view.rerender(<Avatar seed="analytics-session-one" size={48} />);

  expect(avatarSvg().document.documentElement.getAttribute('width')).toBe('48');
  expect(screen.getByRole('img')).toHaveStyle({ width: '48px' });
});

test('keeps hostile seed text inside a local SVG image without active markup', () => {
  render(<Avatar seed={'"><script>alert(1)</script><image href="https://invalid.example/" />'} />);

  expect(avatarSvg().document.querySelector('script, foreignObject, image, a')).toBeNull();
  expect(document.querySelector('script, iframe')).toBeNull();
});
