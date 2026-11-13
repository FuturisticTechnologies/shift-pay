import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'https://service-now.com';

test.describe('Shift Pay Full Application Regression Suite', () => {

  test('REG-01. Landing Page UI Widget loads navigation cards and user greeting', async ({ page }) => {
    await page.goto(`${BASE_URL}/sp?id=shiftpay_landing`);
    await expect(page.getByRole('heading').first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Calendar|My Shifts/i })).toBeVisible();
  });

  test('REG-02. Employee Calendar UI Widget switches between Week and Month views', async ({ page }) => {
    await page.goto(`${BASE_URL}/sp?id=employee_calendar`);
    await page.getByRole('button', { name: /Month/i }).click();
    await expect(page.getByRole('grid')).toBeVisible();

    await page.getByRole('button', { name: /Week/i }).click();
    await expect(page.getByRole('grid')).toBeVisible();
  });

  test('REG-03. Overtime and break deduction calculation rules remain intact', async ({ page }) => {
    await page.goto(`${BASE_URL}/sp?id=employee_calendar`);
    await page.getByRole('button', { name: /Log Shift|Add Shift/i }).click();
    await page.getByLabel('Start Time').fill('08:00');
    await page.getByLabel('End Time').fill('18:30');
    await page.getByLabel('Unpaid Break (mins)').fill('30');

    // 10 net payable hours (8 standard + 2 overtime)
    await expect(page.getByText(/10(\.00)?\s*hrs/i)).toBeVisible();
  });

  test('REG-04. Manager Approval UI Widget rejects shift only when rejection comment is provided', async ({ page }) => {
    await page.goto(`${BASE_URL}/sp?id=manager_approval`);
    const firstPendingRow = page.getByRole('row', { name: /Pending/i }).first();
    await firstPendingRow.getByRole('button', { name: /Reject/i }).click();

    const confirmRejectBtn = page.getByRole('button', { name: /Confirm Rejection/i });
    await expect(confirmRejectBtn).toBeDisabled();

    await page.getByLabel(/Reason|Comments/i).fill('Please verify clock-out timestamp');
    await expect(confirmRejectBtn).toBeEnabled();
  });

  test('REG-05. Role-based access control prevents standard employees from opening Manager Approval', async ({ page }) => {
    await page.goto(`${BASE_URL}/sp?id=manager_approval`);
    await expect(page.getByText(/Access Denied|Not Authorized|No records/i)).toBeVisible();
  });

  test('REG-06. Self-Service Requested Items list loads default active filter breadcrumbs', async ({ page }) => {
    await page.goto(`${BASE_URL}/sc_req_item_list.do?sysparm_view=ess`);
    await expect(page.getByRole('link', { name: 'All', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Active = true' })).toBeVisible();
  });

  test('REG-07. Platform Analytics Dashboards search and bulk action state rules remain intact', async ({ page }) => {
    await page.goto(`${BASE_URL}/now/platform-analytics-workspace/dashboards`);
    await expect(page.getByRole('button', { name: 'Delete' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Deactivate' })).toBeDisabled();
  });

  test('REG-08. Payroll report export generates downloadable CSV/PDF without error', async ({ page }) => {
    await page.goto(`${BASE_URL}/sp?id=shiftpay_landing`);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /Export/i }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.(csv|pdf|xlsx)$/i);
  });

});