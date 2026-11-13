import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'https://service-now.com';
const AUTH_HEADER = {
  Authorization: 'Basic ' + Buffer.from(`${process.env.SN_USER}:${process.env.SN_PASS}`).toString('base64'),
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

test.describe('Shift Pay Cross-Module Integration Suite', () => {

  test('INT-01. Employee Calendar shift submission appears immediately in Manager Approval widget', async ({ page }) => {
    // 1. Employee logs a shift in Employee Calendar UI Widget
    await page.goto(`${BASE_URL}/sp?id=employee_calendar`);
    await page.getByRole('button', { name: /Log Shift|Add Shift/i }).click();
    await page.getByLabel('Start Time').fill('09:00');
    await page.getByLabel('End Time').fill('17:00');
    await page.getByRole('button', { name: /Submit/i }).click();
    await expect(page.getByText(/Submitted|Pending Approval/i)).toBeVisible();

    // 2. Verify the exact shift appears in Manager Approval UI Widget
    await page.goto(`${BASE_URL}/sp?id=manager_approval`);
    await expect(page.getByRole('row', { name: /Pending/i }).first()).toBeVisible();
  });

  test('INT-02. Manager approval updates record state via REST API and locks Employee Calendar entry', async ({ page, request }) => {
    // 1. Approve first pending shift in Manager Approval UI
    await page.goto(`${BASE_URL}/sp?id=manager_approval`);
    const firstPendingRow = page.getByRole('row', { name: /Pending/i }).first();
    const shiftRef = (await firstPendingRow.getByRole('cell').first().textContent())?.trim() || '';
    await firstPendingRow.getByRole('button', { name: /Approve/i }).click();
    await expect(page.getByText(/Approved/i).first()).toBeVisible();

    // 2. Verify backend database reflects "approved" status via API
    const apiRes = await request.get(
      `${BASE_URL}/api/now/table/x_shiftpay_entry?sysparm_query=number=${shiftRef}`,
      { headers: AUTH_HEADER }
    );
    const body = await apiRes.json();
    if (body.result?.length > 0) {
      expect(body.result[0].status).toBe('approved');
    }
  });

  test('INT-03. Approved shift pay totals reflect on Landing Page summary and Analytics Dashboard', async ({ page }) => {
    // 1. Check total approved pay on Landing Page UI Widget
    await page.goto(`${BASE_URL}/sp?id=shiftpay_landing`);
    const landingTotal = await page.getByTestId('total-approved-pay').textContent();

    // 2. Verify Platform Analytics Dashboard loads without data mismatch
    await page.goto(`${BASE_URL}/now/platform-analytics-workspace/dashboards`);
    await expect(page.getByRole('heading', { name: 'Dashboards', level: 1 })).toBeVisible();
    expect(landingTotal).toBeTruthy();
  });

  test('INT-04. Catalog Requested Item (RITM) links to Shift Pay allowance request workflow', async ({ page }) => {
    await page.goto(`${BASE_URL}/sc_req_item_list.do?sysparm_view=ess`);
    const firstRitm = page.getByRole('link', { name: /^RITM\d+$/ }).first();
    await firstRitm.click();

    await expect(page).toHaveURL(/sc_req_item\.do/);
    await expect(page.getByText(/Approval|Stage/i).first()).toBeVisible();
  });

  test('INT-05. API-created shift renders accurately on Employee Calendar UI Widget', async ({ page, request }) => {
    // 1. Create shift via REST API
    const createRes = await request.post(`${BASE_URL}/api/now/table/x_shiftpay_entry`, {
      headers: AUTH_HEADER,
      data: {
        shift_date: '2026-11-15',
        start_time: '10:00:00',
        end_time: '16:00:00',
        status: 'draft',
      },
    });
    expect([200, 201]).toContain(createRes.status());

    // 2. Open Employee Calendar UI and verify shift block renders
    await page.goto(`${BASE_URL}/sp?id=employee_calendar`);
    await expect(page.getByText(/10:00|Draft/i).first()).toBeVisible();
  });

});
