import { expect, test } from 'vitest';
import { replayConfigInputSchema } from './request-schema';

test('accepts only bounded same-origin site permit endpoint paths', () => {
  expect(replayConfigInputSchema.safeParse({ permitEndpoint: '/analytics-permit' }).success).toBe(
    true,
  );
  expect(replayConfigInputSchema.safeParse({ permitEndpoint: null }).success).toBe(true);
  for (const permitEndpoint of [
    'https://other.example/permit',
    '//other.example/permit',
    '/permit/../other',
    '/permit?token=secret',
    `/${'a'.repeat(255)}`,
  ]) {
    expect(replayConfigInputSchema.safeParse({ permitEndpoint }).success).toBe(false);
  }
});
