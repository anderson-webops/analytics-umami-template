import { expect, test } from 'vitest';
import { canMutateResource } from './mutation';

test('resource mutation requires a consistent global admin or user role', () => {
  const base = { id: 'user-1', username: 'user' };

  expect(canMutateResource(undefined)).toBe(false);
  expect(canMutateResource({ ...base, role: 'user', isAdmin: false })).toBe(true);
  expect(canMutateResource({ ...base, role: 'admin', isAdmin: true })).toBe(true);
  expect(canMutateResource({ ...base, role: 'view-only', isAdmin: false })).toBe(false);
  expect(canMutateResource({ ...base, role: 'view-only', isAdmin: true })).toBe(false);
  expect(canMutateResource({ ...base, role: 'admin', isAdmin: false })).toBe(false);
  expect(canMutateResource({ ...base, role: 'user', isAdmin: true })).toBe(false);
  expect(canMutateResource({ ...base, role: 'unexpected', isAdmin: false })).toBe(false);
});
