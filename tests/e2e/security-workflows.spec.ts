import { expect, test } from '@playwright/test';
import { type Auth, authHeaders, loginViaApi, umamiUser } from './helpers';

const SECONDARY_USERNAME = 'security-secondary-admin';
const SECONDARY_PASSWORD = 'Security-secondary-password-2026-A9';
const MANAGER_USERNAME = 'security-team-manager';
const MANAGER_PASSWORD = 'Security-manager-password-2026-A9';
const MEMBER_USERNAME = 'security-team-member';
const MEMBER_PASSWORD = 'Security-member-password-2026-A9';

test.describe('Authorization and role-transition security', () => {
  test.describe.configure({ mode: 'serial' });

  let primaryAuth: Auth;
  let secondaryId = '';
  let managerId = '';
  let memberId = '';
  let teamId = '';

  test.beforeAll(async ({ request }) => {
    primaryAuth = await loginViaApi(request);
  });

  test.afterAll(async ({ request }) => {
    if (teamId) {
      await request.delete(`/api/teams/${teamId}`, {
        headers: authHeaders(primaryAuth),
      });
    }

    for (const userId of [secondaryId, managerId, memberId]) {
      if (userId) {
        await request.delete(`/api/users/${userId}`, {
          headers: authHeaders(primaryAuth),
        });
      }
    }
  });

  test('protects the final administrator and redacts password hashes', async ({ request }) => {
    const demotion = await request.post(`/api/users/${umamiUser.id}`, {
      headers: authHeaders(primaryAuth),
      data: { role: 'user' },
    });
    const selfDelete = await request.delete(`/api/users/${umamiUser.id}`, {
      headers: authHeaders(primaryAuth),
    });
    const users = await request.get('/api/admin/users', {
      headers: authHeaders(primaryAuth),
    });
    const body = await users.json();

    expect(demotion.status()).toBe(400);
    expect(selfDelete.status()).toBe(400);
    expect(users.status()).toBe(200);
    expect(body.data.length).toBeGreaterThan(0);

    for (const user of body.data) {
      expect(user).not.toHaveProperty('password');
    }
  });

  test('invalidates sessions across promotion and demotion', async ({ request }) => {
    const create = await request.post('/api/users', {
      headers: authHeaders(primaryAuth),
      data: {
        username: SECONDARY_USERNAME,
        password: SECONDARY_PASSWORD,
        role: 'admin',
      },
    });
    const created = await create.json();
    secondaryId = created.id;

    expect(create.status()).toBe(200);

    const adminSession = await loginViaApi(request, SECONDARY_USERNAME, SECONDARY_PASSWORD);
    const demotion = await request.post(`/api/users/${secondaryId}`, {
      headers: authHeaders(primaryAuth),
      data: { role: 'user' },
    });

    expect(demotion.status()).toBe(200);

    const staleAdminSession = await request.get('/api/admin/users', {
      headers: authHeaders(adminSession),
    });
    expect(staleAdminSession.status()).toBe(401);

    const userSession = await loginViaApi(request, SECONDARY_USERNAME, SECONDARY_PASSWORD);
    const selfPromotion = await request.post(`/api/users/${secondaryId}`, {
      headers: authHeaders(userSession),
      data: { role: 'admin' },
    });
    expect(selfPromotion.status()).toBe(403);

    const promotion = await request.post(`/api/users/${secondaryId}`, {
      headers: authHeaders(primaryAuth),
      data: { role: 'admin' },
    });
    expect(promotion.status()).toBe(200);

    const staleUserSession = await request.get('/api/admin/users', {
      headers: authHeaders(userSession),
    });
    expect(staleUserSession.status()).toBe(401);

    const refreshedAdminSession = await loginViaApi(
      request,
      SECONDARY_USERNAME,
      SECONDARY_PASSWORD,
    );
    const adminList = await request.get('/api/admin/users', {
      headers: authHeaders(refreshedAdminSession),
    });
    expect(adminList.status()).toBe(200);

    const restore = await request.post(`/api/users/${secondaryId}`, {
      headers: authHeaders(primaryAuth),
      data: { role: 'user' },
    });
    expect(restore.status()).toBe(200);
  });

  test('enforces team rank and single-owner transitions', async ({ request }) => {
    for (const [username, password, setId] of [
      [MANAGER_USERNAME, MANAGER_PASSWORD, (id: string) => (managerId = id)],
      [MEMBER_USERNAME, MEMBER_PASSWORD, (id: string) => (memberId = id)],
    ] as const) {
      const response = await request.post('/api/users', {
        headers: authHeaders(primaryAuth),
        data: { username, password, role: 'user' },
      });
      const body = await response.json();

      expect(response.status()).toBe(200);
      setId(body.id);
    }

    const createTeam = await request.post('/api/teams', {
      headers: authHeaders(primaryAuth),
      data: { name: 'Security workflow team' },
    });
    const team = await createTeam.json();
    teamId = team.id;

    expect(createTeam.status()).toBe(200);

    const addManager = await request.post(`/api/teams/${teamId}/users`, {
      headers: authHeaders(primaryAuth),
      data: { userId: managerId, role: 'team-manager' },
    });
    expect(addManager.status()).toBe(200);

    const managerAuth = await loginViaApi(request, MANAGER_USERNAME, MANAGER_PASSWORD);
    const assignPeer = await request.post(`/api/teams/${teamId}/users`, {
      headers: authHeaders(managerAuth),
      data: { userId: memberId, role: 'team-manager' },
    });
    expect(assignPeer.status()).toBe(401);

    const addMember = await request.post(`/api/teams/${teamId}/users`, {
      headers: authHeaders(managerAuth),
      data: { userId: memberId, role: 'team-member' },
    });
    expect(addMember.status()).toBe(200);

    const demoteOwner = await request.post(`/api/teams/${teamId}/users/${umamiUser.id}`, {
      headers: authHeaders(managerAuth),
      data: { role: 'team-view-only' },
    });
    expect(demoteOwner.status()).toBe(401);

    const transfer = await request.post(`/api/teams/${teamId}/owner`, {
      headers: authHeaders(primaryAuth),
      data: { userId: managerId },
    });
    expect(transfer.status()).toBe(200);

    const removeCurrentOwner = await request.delete(`/api/teams/${teamId}/users/${managerId}`, {
      headers: authHeaders(managerAuth),
    });
    expect(removeCurrentOwner.status()).toBe(401);

    const transferBack = await request.post(`/api/teams/${teamId}/owner`, {
      headers: authHeaders(managerAuth),
      data: { userId: umamiUser.id },
    });
    expect(transferBack.status()).toBe(200);
  });
});
