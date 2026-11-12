import { test, expect } from '@playwright/test';

const BASE_URL = 'https://service-now.com';

test.describe('ServiceNow Requested Items List View - 20 Dynamic E2E Test Cases', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/sc_req_item_list.do?sysparm_view=ess`);
    await expect(page.getByRole('heading', { name: /Requested Items/i })).toBeVisible();
  });

  // ==========================================
  // 1. LEFT NAVIGATION & HEADER CONTROLS
  // ==========================================

  test('01. Navigate to Requested Items from Self-Service menu', async ({ page }) => {
    await page.getByPlaceholder('Filter').fill('Requested Items');
    await page.getByRole('link', { name: 'Requested Items', exact: true }).click();
    await expect(page).toHaveURL(/sc_req_item_list/);
  });

  test('02. Favorite the Requested Items view using header star icon', async ({ page }) => {
    const favoriteStar = page.getByRole('button', { name: /Favorite.*Requested Items/i });
    await favoriteStar.click();
    await expect(favoriteStar).toHaveAttribute('aria-pressed', 'true');
  });

  test('03. Open List Controls menu from top-left hamburger icon', async ({ page }) => {
    await page.getByRole('button', { name: /List controls|Additional actions/i }).click();
    await expect(page.getByRole('menuitem', { name: /View|Export|Refresh List/i }).first()).toBeVisible();
  });

  test('04. Toggle Filter condition builder panel using funnel icon', async ({ page }) => {
    await page.getByRole('button', { name: /Show \/ hide filter/i }).click();
    await expect(page.getByRole('button', { name: 'Run' })).toBeVisible();
  });

  test('05. Open Activity stream / split view panel', async ({ page }) => {
    await page.getByRole('button', { name: /Show \/ hide activity stream/i }).click();
    await expect(page.getByText(/Activity/i)).toBeVisible();
  });

  // ==========================================
  // 2. SEARCH DROPDOWN & BREADCRUMB FILTERS
  // ==========================================

  test('06. Search Requested Item dynamically by first visible RITM Number', async ({ page }) => {
    const firstRitmLink = page.getByRole('link', { name: /^RITM\d+$/ }).first();
    const dynamicRitmNumber = (await firstRitmLink.textContent())?.trim() || '';
    expect(dynamicRitmNumber).toMatch(/^RITM\d+$/);

    await page.getByLabel('Search column').selectOption('number');
    const searchInput = page.getByPlaceholder('Search', { exact: true });
    await searchInput.fill(dynamicRitmNumber);
    await searchInput.press('Enter');

    await expect(page.getByRole('link', { name: dynamicRitmNumber })).toBeVisible();
    await expect(page.getByRole('link', { name: /^RITM\d+$/ })).toHaveCount(1);
  });

  test('07. Search Requested Items dynamically by first row Item name', async ({ page }) => {
    const firstDataRow = page.locator('table tbody tr').first();
    const dynamicItemName = (await firstDataRow.getByRole('cell').nth(2).textContent())?.trim() || '';
    expect(dynamicItemName.length).toBeGreaterThan(0);

    await page.getByLabel('Search column').selectOption('cat_item');
    const searchInput = page.getByPlaceholder('Search', { exact: true });
    await searchInput.fill(dynamicItemName);
    await searchInput.press('Enter');

    const matchingRows = page.locator('table tbody tr');
    await expect(matchingRows.first()).toContainText(dynamicItemName);
  });

  test('08. Search with non-matching RITM pattern shows empty list message', async ({ page }) => {
    const searchInput = page.getByPlaceholder('Search', { exact: true });
    await searchInput.fill('RITM_NON_EXISTENT_999999');
    await searchInput.press('Enter');

    await expect(page.getByText('No records to display')).toBeVisible();
  });

  test('09. Verify default filter breadcrumbs are active', async ({ page }) => {
    await expect(page.getByRole('link', { name: 'All', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: /Request Requested for =/i })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Active = true' })).toBeVisible();
  });

  test('10. Click "All" in filter breadcrumb resets active filters', async ({ page }) => {
    await page.getByRole('link', { name: 'All', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Active = true' })).toBeHidden();
  });

  // ==========================================
  // 3. TABLE COLUMNS, SORTING & PERSONALIZATION
  // ==========================================

  test('11. Verify all expected list columns are displayed', async ({ page }) => {
    for (const column of ['Number', 'Catalog', 'Item', 'Approval', 'Quantity', 'Stage']) {
      await expect(page.getByRole('columnheader', { name: new RegExp(column, 'i') })).toBeVisible();
    }
  });

  test('12. Toggle inline column search row using magnifying glass icon', async ({ page }) => {
    await page.getByRole('button', { name: /Search/i }).first().click();
    await expect(page.getByLabel('Search Number')).toBeVisible();
  });

  test('13. Sort Requested Items by Number column and verify order changes', async ({ page }) => {
    const firstRitmBefore = await page.getByRole('link', { name: /^RITM\d+$/ }).first().textContent();
    const numberHeader = page.getByRole('columnheader', { name: /Number/i });
    await numberHeader.click();

    const firstRitmAfter = await page.getByRole('link', { name: /^RITM\d+$/ }).first().textContent();
    expect(firstRitmAfter).not.toEqual(firstRitmBefore);
  });

  test('14. Open Personalize List Columns modal via gear icon', async ({ page }) => {
    await page.getByRole('button', { name: /Personalize List/i }).click();
    await expect(page.getByRole('dialog', { name: /Personalize List Columns/i })).toBeVisible();
  });

  // ==========================================
  // 4. APPROVAL STATUS, QUANTITY & STAGE DETAILS
  // ==========================================

  test('15. Verify Approval column displays valid workflow states on visible rows', async ({ page }) => {
    const firstRow = page.locator('table tbody tr').first();
    const approvalCell = firstRow.getByRole('cell').nth(3);
    await expect(approvalCell).toHaveText(/Requested|Approved|Rejected|Not Yet Requested/i);
  });

  test('16. Verify Quantity column displays a positive integer for any visible row', async ({ page }) => {
    const firstRow = page.locator('table tbody tr').first();
    const quantityCell = firstRow.getByRole('cell').nth(4);
    await expect(quantityCell).toHaveText(/^[1-9]\d*$/);
  });

  test('17. Expand Stage workflow progress icons on the first available row', async ({ page }) => {
    const firstRow = page.locator('table tbody tr').first();
    await firstRow.getByRole('button', { name: /Expand.*stage|Stage/i }).click();
    await expect(page.getByText(/Request Approved|Fulfillment|Completed|Waiting/i).first()).toBeVisible();
  });

  // ==========================================
  // 5. ROW SELECTION, BULK ACTIONS & RECORD NAVIGATION
  // ==========================================

  test('18. Actions on selected dropdown is disabled when no rows are checked', async ({ page }) => {
    const bulkActions = page.getByRole('combobox', { name: /Actions on selected/i });
    await expect(bulkActions).toBeDisabled();
  });

  test('19. Selecting the first row checkbox enables Actions on selected dropdown', async ({ page }) => {
    const firstRowCheckbox = page.locator('table tbody tr').first().getByRole('checkbox');
    await firstRowCheckbox.check();

    const bulkActions = page.getByRole('combobox', { name: /Actions on selected/i });
    await expect(bulkActions).toBeEnabled();
  });

  test('20. Clicking any RITM link opens its matching Requested Item detail form', async ({ page }) => {
    const firstRitmLink = page.getByRole('link', { name: /^RITM\d+$/ }).first();
    const selectedRitmNumber = (await firstRitmLink.textContent())?.trim() || '';

    await firstRitmLink.click();
    await expect(page).toHaveURL(/sc_req_item\.do/);
    await expect(page.getByDisplayValue(selectedRitmNumber).or(page.getByText(selectedRitmNumber))).toBeVisible();
  });

});
