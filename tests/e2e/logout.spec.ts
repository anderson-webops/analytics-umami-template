import { expect, test } from '@playwright/test';
import { loginPage, logout } from './helpers';

test('opening the logout page preserves the session until confirmation', async ({
  page,
  request,
}) => {
  await loginPage(page, request);
  await page.goto('/logout');
  await expect(page.getByRole('main').getByRole('heading', { name: /^Logout$/i })).toBeVisible();
  expect((await page.context().request.get('/api/me')).status()).toBe(200);

  await page
    .getByRole('main')
    .getByRole('button', { name: /^Logout$/i })
    .click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.context().request.get('/api/me')).status()).toBe(401);
});

test('the explicit profile-menu logout action ends the session', async ({ page, request }) => {
  await loginPage(page, request);
  await page.goto('/websites');
  await logout(page);
  expect((await page.context().request.get('/api/me')).status()).toBe(401);
});
