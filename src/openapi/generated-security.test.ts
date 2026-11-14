import { expect, test } from 'vitest';
import { loadApiContracts } from './contracts';
import { getSecurityRequirements } from './security';

const contracts = await loadApiContracts();

function security(route: string, method: string) {
  const matching = contracts.filter(
    contract => contract.path === route && contract.method === method,
  );
  expect(matching).toHaveLength(1);
  return getSecurityRequirements(matching[0].auth, route, method);
}

test.each([
  ['/api/boards', 'post'],
  ['/api/boards/{boardId}', 'post'],
  ['/api/teams/{teamId}/websites', 'get'],
])('%s %s advertises bearer access without unsupported shares', (route, method) => {
  expect(security(route, method)).toEqual([{ bearerAuth: [] }]);
});

test.each([
  ['/api/admin/teams', 'get'],
  ['/api/users/{userId}', 'get'],
  ['/api/teams/{teamId}', 'post'],
  ['/api/me/api-keys', 'post'],
  ['/api/2fa/setup/confirm', 'post'],
  ['/api/admin/users/{userId}/2fa', 'delete'],
])('%s %s retains the session-only security contract', (route, method) => {
  expect(security(route, method)).toEqual([{ sessionAuth: [] }]);
});

test.each([
  '/api/websites/{websiteId}',
  '/api/websites/{websiteId}/sessions',
  '/api/websites/{websiteId}/events',
  '/api/websites/{websiteId}/event-data',
  '/api/boards/{boardId}',
])('%s retains both scoped share headers as one credential requirement', route => {
  expect(security(route, 'get')).toEqual([
    { bearerAuth: [] },
    { shareToken: [], shareContext: [] },
  ]);
});

test('the public collector and trusted revenue endpoint retain distinct credentials', () => {
  expect(security('/api/send', 'post')).toEqual([]);
  expect(security('/api/revenue/movements', 'post')).toEqual([{ backendCollectionKey: [] }]);
});
