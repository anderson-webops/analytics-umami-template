import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { addWebsite, deleteWebsite, loginPage } from './helpers';

test.describe('Website tests', () => {
  test('adds a website', async ({ page, request }) => {
    const auth = await loginPage(page, request);
    const suffix = randomUUID().slice(0, 8);
    const websiteName = `Add test ${suffix}`;
    const websiteDomain = `addtest-${suffix}.com`;

    await page.goto('/websites');
    await page.getByRole('button', { name: /Add website/i }).click();
    await expect(page.getByRole('heading', { name: /Add website/i })).toBeVisible();
    await page.getByTestId('input-name').locator('input').fill(websiteName);
    await page.getByTestId('input-domain').locator('input').fill(websiteDomain);
    await page.getByTestId('button-submit').click();

    const websiteRow = page.getByRole('row').filter({ hasText: websiteName });
    await expect(websiteRow).toContainText(websiteDomain);

    await websiteRow.getByTestId('link-button-edit').click();
    await expect(page.getByTestId('text-field-websiteId')).toBeVisible();

    const websiteId = await page.getByTestId('text-field-websiteId').inputValue();

    await deleteWebsite(request, auth, websiteId);
    await page.goto('/websites');
    await expect(page.getByText(websiteName, { exact: true })).toHaveCount(0);
  });

  test('edits a website', async ({ page, request }) => {
    const auth = await loginPage(page, request);
    const suffix = randomUUID().slice(0, 8);
    const websiteName = `Update test ${suffix}`;
    const updatedName = `Updated website ${suffix}`;

    await addWebsite(request, auth, websiteName, `updatetest-${suffix}.com`);
    await page.goto('/websites');

    await page
      .getByRole('row')
      .filter({ hasText: websiteName })
      .getByTestId('link-button-edit')
      .click();
    await expect(page.getByTestId('text-field-websiteId')).toBeVisible();
    await page.getByTestId('input-name').locator('input').fill(updatedName);
    await page.getByTestId('input-domain').locator('input').fill(`updatedwebsite-${suffix}.com`);
    await page.getByTestId('button-submit').click();

    await expect(page.getByTestId('input-name').locator('input')).toHaveValue(updatedName);
    await expect(page.getByTestId('input-domain').locator('input')).toHaveValue(
      `updatedwebsite-${suffix}.com`,
    );

    await expect(page.locator('textarea')).toContainText('/script.js');

    const websiteId = await page.getByTestId('text-field-websiteId').inputValue();

    await deleteWebsite(request, auth, websiteId);
    await page.goto('/websites');
    await expect(page.getByText(updatedName, { exact: true })).toHaveCount(0);
  });

  test('deletes a website', async ({ page, request }, testInfo) => {
    const auth = await loginPage(page, request);
    const websiteName = `Delete test ${testInfo.retry}`;
    const websiteId = await addWebsite(
      request,
      auth,
      websiteName,
      `deletetest-${testInfo.retry}.com`,
    );

    await page.goto(`/websites/${websiteId}/settings`);
    await expect(page.getByText(/All website data will be deleted./i)).toBeVisible();
    await page.getByTestId('button-delete').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/Type DELETE in the box below to confirm./i)).toBeVisible();
    await dialog.getByRole('textbox', { name: /^Confirm$/i }).fill('DELETE');
    await dialog.getByRole('button', { name: /^Delete$/i }).click();

    await expect(page).toHaveURL(/\/websites$/);
    await expect(page.getByText(websiteName, { exact: true })).toHaveCount(0);
  });
});
