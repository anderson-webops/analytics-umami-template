import { render } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { useConfig } from '@/components/hooks';
import { Favicon } from './Favicon';

vi.mock('@/components/hooks', () => ({ useConfig: vi.fn() }));

beforeEach(() => {
  vi.mocked(useConfig).mockReturnValue({ privateMode: false } as ReturnType<typeof useConfig>);
});

test('uses a local generic icon by default without requesting a favicon provider', () => {
  const { container } = render(<Favicon domain="private.example" />);

  expect(container.querySelector('svg')).toBeInTheDocument();
  expect(container.querySelector('img')).toBeNull();
  expect(container.innerHTML).not.toContain('private.example');
});

test('loads a domain-specific icon only when the operator configures a favicon URL', () => {
  vi.mocked(useConfig).mockReturnValue({
    privateMode: false,
    faviconUrl: 'https://icons.example/{{domain}}.ico',
  } as ReturnType<typeof useConfig>);

  const { container } = render(<Favicon domain="private.example" />);

  expect(container.querySelector('img')).toHaveAttribute(
    'src',
    'https://icons.example/private.example.ico',
  );
});

test('private mode suppresses icons even with an explicit favicon URL', () => {
  vi.mocked(useConfig).mockReturnValue({
    privateMode: true,
    faviconUrl: 'https://icons.example/{{domain}}.ico',
  } as ReturnType<typeof useConfig>);

  const { container } = render(<Favicon domain="private.example" />);

  expect(container).toBeEmptyDOMElement();
});

test('does not render an icon without a domain', () => {
  const { container } = render(<Favicon domain="" />);

  expect(container).toBeEmptyDOMElement();
});
