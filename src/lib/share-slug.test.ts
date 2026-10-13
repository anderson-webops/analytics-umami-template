import { expect, test } from 'vitest';
import { getRandomShareSlug } from './share-slug';

test('share slugs encode 144 random bits in a URL-safe form', () => {
  const slugs = Array.from({ length: 100 }, () => getRandomShareSlug());

  expect(slugs.every(slug => /^[A-Za-z0-9_-]{24}$/.test(slug))).toBe(true);
  expect(new Set(slugs).size).toBe(slugs.length);
});
