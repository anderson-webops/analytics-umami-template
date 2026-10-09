import { expect, test } from 'vitest';
import { getSecurityRequirements } from './security';

test('credential and administration routes require a session bearer', () => {
  expect(getSecurityRequirements('bearer', '/api/me/api-keys', 'post')).toEqual([
    { sessionAuth: [] },
  ]);
  expect(getSecurityRequirements('bearer', '/api/2fa/setup/confirm', 'post')).toEqual([
    { sessionAuth: [] },
  ]);
  expect(getSecurityRequirements('bearer', '/api/admin/users/{userId}/2fa', 'delete')).toEqual([
    { sessionAuth: [] },
  ]);
  expect(getSecurityRequirements('bearer', '/api/teams/{teamId}', 'post')).toEqual([
    { sessionAuth: [] },
  ]);
  expect(getSecurityRequirements('bearer-or-share', '/api/admin/websites', 'get')).toEqual([
    { sessionAuth: [] },
  ]);
});

test('API-key-capable reads retain the general bearer scheme', () => {
  expect(getSecurityRequirements('bearer', '/api/websites', 'get')).toEqual([{ bearerAuth: [] }]);
  expect(getSecurityRequirements('bearer', '/api/teams/{teamId}', 'get')).toEqual([
    { bearerAuth: [] },
  ]);
});

test('share-token access and public routes keep their authentication contracts', () => {
  expect(getSecurityRequirements('bearer-or-share', '/api/websites/{websiteId}', 'get')).toEqual([
    { bearerAuth: [] },
    { shareToken: [], shareContext: [] },
  ]);
  expect(getSecurityRequirements('none', '/api/auth/login', 'post')).toEqual([]);
});
