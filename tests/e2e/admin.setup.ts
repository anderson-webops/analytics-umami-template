import { expect, test as setup } from '@playwright/test';
import { umamiUser } from './helpers';

setup('verify the provisioned test administrator', async ({ request }) => {
  const { username, password } = umamiUser;
  const current = await request.post('/api/auth/login', { data: { username, password } });

  expect(
    current.status(),
    `Provision the isolated test administrator ${username} before running browser tests`,
  ).toBe(200);
  const { user } = await current.json();
  expect(user).toMatchObject({
    id: umamiUser.id,
    username,
    role: 'admin',
    passwordChangeRequired: false,
  });
});
