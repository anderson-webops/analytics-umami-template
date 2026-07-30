import { expect, test } from '@playwright/test';
import { addWebsite, deleteWebsite, loginPage } from './helpers';

test.describe('Website tests', () => {
  test('adds a website', async ({ page, request }) => {
    const auth = await loginPage(page, request);

    await page.goto('/websites');
    await page.getByRole('button', { name: /Add website/i }).click();
    await expect(page.getByRole('heading', { name: /Add website/i })).toBeVisible();
    await page.getByTestId('input-name').locator('input').fill('Add test');
    await page.getByTestId('input-domain').locator('input').fill('addtest.com');
    await page.getByTestId('button-submit').click();

    const websiteRow = page.getByRole('row').filter({ hasText: /Add test/i });
    await expect(websiteRow).toContainText('addtest.com');

    await websiteRow.getByRole('link', { name: /Edit/i }).click();
    await expect(page.getByTestId('text-field-websiteId')).toBeVisible();

    const websiteId = await page.getByTestId('text-field-websiteId').locator('input').inputValue();

    await deleteWebsite(request, auth, websiteId);
    await page.goto('/websites');
    await expect(page.getByText(/Add test/i)).toHaveCount(0);
  });

  test('edits a website', async ({ page, request }) => {
    const auth = await loginPage(page, request);

    await addWebsite(request, auth, 'Update test', 'updatetest.com');
    await page.goto('/websites');

    await page
      .getByRole('row')
      .filter({ hasText: /Update test/i })
      .getByRole('link', { name: /Edit/i })
      .click();
    await expect(page.getByTestId('text-field-websiteId')).toBeVisible();
    await page.getByTestId('input-name').locator('input').fill('Updated website');
    await page.getByTestId('input-domain').locator('input').fill('updatedwebsite.com');
    await page.getByTestId('button-submit').click();

    await expect(page.getByTestId('input-name').locator('input')).toHaveValue('Updated website');
    await expect(page.getByTestId('input-domain').locator('input')).toHaveValue(
      'updatedwebsite.com',
    );

    await expect(page.locator('textarea')).toContainText('/script.js');

    const websiteId = await page.getByTestId('text-field-websiteId').locator('input').inputValue();

    await deleteWebsite(request, auth, websiteId);
    await page.goto('/websites');
    await expect(page.getByText(/Update test/i)).toHaveCount(0);
  });

  test('deletes a website', async ({ page, request }) => {
    const auth = await loginPage(page, request);

    await addWebsite(request, auth, 'Delete test', 'deletetest.com');
    await page.goto('/websites');

    await page
      .getByRole('row')
      .filter({ hasText: /Delete test/i })
      .getByRole('link', { name: /Edit/i })
      .click();
    await expect(page.getByText(/All website data will be deleted./i)).toBeVisible();
    await page.getByTestId('button-delete').click();
    await expect(page.getByText(/Type DELETE in the box below to confirm./i)).toBeVisible();
    await page.locator('input[name="confirm"]').fill('DELETE');
    await page
      .getByLabel('Dialog')
      .getByRole('button', { name: /^Delete$/i })
      .click();

    await expect(page.getByText(/Delete test/i)).toHaveCount(0);
  });
});
