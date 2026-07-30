import { expect, test } from '@playwright/test';
import { loginPage, logout } from './helpers';

test.describe('User tests', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async ({ page, request }) => {
    await loginPage(page, request);
    await page.goto('/admin/users');
  });

  test('adds a user', async ({ page }) => {
    await expect(page.getByText(/Create user/i)).toBeVisible();

    await page.getByTestId('button-create-user').click();
    await page.getByTestId('input-username').locator('input').fill('Test-user');
    await page.getByTestId('input-password').locator('input').fill('testPasswordPlaywright');
    await page.getByTestId('dropdown-role').click();
    await page.getByTestId('dropdown-item-user').click();
    await page.getByTestId('button-submit').click();

    await expect(page.getByRole('row').filter({ hasText: /Test-user/i })).toContainText('User');
  });

  test('edits a user role and password', async ({ page }) => {
    const userRow = page.getByRole('row').filter({ hasText: /Test-user/i });

    await userRow.getByRole('link', { name: 'Test-user' }).click();
    await page.getByTestId('input-password').locator('input').fill('New-test-password-2026-A9');
    await page.getByTestId('dropdown-role').click();
    await page.getByTestId('dropdown-item-viewOnly').click();
    await page.getByTestId('button-submit').click();

    await page.goto('/admin/users');
    await expect(page.getByRole('row').filter({ hasText: /Test-user/i })).toContainText(
      'View only',
    );

    await logout(page);
    await page.getByTestId('input-username').locator('input').fill('Test-user');
    await page.getByTestId('input-password').locator('input').fill('New-test-password-2026-A9');
    await page.getByTestId('button-submit').click();

    await expect(page).toHaveURL(/\/websites$/);
  });

  test('deletes a user', async ({ page }) => {
    const userRow = page.getByRole('row').filter({ hasText: /Test-user/i });

    await userRow.getByRole('button', { name: /Actions/i }).click();
    await page.getByTestId('link-button-delete').click();
    await expect(page.getByText(/Are you sure you want to delete Test-user?/i)).toBeVisible();
    await page.getByRole('button', { name: /^Delete$/i }).click();
  });
});
