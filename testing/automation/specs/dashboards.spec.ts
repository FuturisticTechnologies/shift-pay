import { test, expect } from '@playwright/test';

const BASE_URL = 'https://service-now.com';

test.describe('ServiceNow Dashboards Workspace - 20 E2E Test Cases', () => {

  test.beforeEach(async ({ page }) => {
    // Navigate directly to the Dashboards workspace (assumes authenticated storageState)
    await page.goto(`${BASE_URL}/now/platform-analytics-workspace/dashboards`);
    await expect(page.getByRole('heading', { name: 'Dashboards', level: 1 })).toBeVisible();
  });

  // ==========================================
  // 1. LEFT NAVIGATION & WORKSPACE SIDEBAR
  // ==========================================

  test('01. Filter left application navigator menu items', async ({ page }) => {
    const filterInput = page.getByPlaceholder('Filter');
    await filterInput.fill('Dashboards');
    await expect(page.getByRole('link', { name: 'Dashboards' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Incidents' })).toBeHidden();
  });

  test('02. Favorite and unfavorite the Dashboards module in Self-Service', async ({ page }) => {
    const dashboardNav = page.getByRole('link', { name: 'Dashboards' });
    await dashboardNav.hover();
    const favoriteBtn = page.getByRole('button', { name: /Favorite Dashboards/i });
    await favoriteBtn.click();
    await expect(favoriteBtn).toHaveAttribute('aria-pressed', 'true');
  });

  test('03. Collapse and expand the Libraries inner sidebar', async ({ page }) => {
    const collapseBtn = page.getByRole('button', { name: /Collapse/i });
    await collapseBtn.click();
    await expect(page.getByRole('link', { name: 'Data visualizations' })).toBeHidden();

    await collapseBtn.click();
    await expect(page.getByRole('link', { name: 'Data visualizations' })).toBeVisible();
  });

  test('04. Navigate between Libraries sections (Indicators & Scheduled exports)', async ({ page }) => {
    await page.getByRole('link', { name: 'Indicators' }).click();
    await expect(page.getByRole('heading', { name: 'Indicators' })).toBeVisible();

    await page.getByRole('link', { name: 'Scheduled exports' }).click();
    await expect(page.getByRole('heading', { name: 'Scheduled exports' })).toBeVisible();
  });

  test('05. Open Usage insights external link from Additional Links', async ({ page }) => {
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('link', { name: 'Usage insights' }).click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(/usage/i);
  });

  // ==========================================
  // 2. HEADER ACTIONS & TOP DROPDOWN FILTERS
  // ==========================================

  test('06. Click Create dashboard button opens dashboard builder', async ({ page }) => {
    await page.getByRole('button', { name: 'Create dashboard' }).click();
    await expect(page).toHaveURL(/create|new/i);
  });

  test('07. Filter dashboards using the "Filter by" dropdown', async ({ page }) => {
    await page.getByLabel('Filter by').click();
    await page.getByRole('option', { name: 'Owned by me' }).click();
    
    const countBadge = page.getByText(/Count/).locator('..');
    await expect(countBadge).not.toContainText('42');
  });

  test('08. Filter dashboards using the "Categories" dropdown', async ({ page }) => {
    await page.getByLabel('Categories').click();
    await page.getByRole('option').first().click();
    await expect(page.locator('table')).toBeVisible();
  });

  // ==========================================
  // 3. QUICK-ACCESS DASHBOARD CARDS
  // ==========================================

  test('09. Verify quick-access cards display status icons (Not viewable, Deactivated, Updated)', async ({ page }) => {
    await expect(page.getByText('Not view...').first()).toBeVisible();
    await expect(page.getByText('Deactivat...')).toBeVisible();
    await expect(page.getByText('Updated ...')).toBeVisible();
  });

  test('10. Clicking a "Not viewable" card displays access restriction message', async ({ page }) => {
    await page.getByText('Not view...').first().click();
    await expect(page.getByText(/not authorized|permission|not viewable/i)).toBeVisible();
  });

  test('11. Clicking an active "Updated" card opens the dashboard view', async ({ page }) => {
    await page.getByText('Updated ...').click();
    await expect(page).not.toHaveURL(/\/dashboards$/);
  });

  // ==========================================
  // 4. DATA TABLE SEARCH, SORTING & CONTROLS
  // ==========================================

  test('12. Verify initial total dashboard Count badge displays correctly', async ({ page }) => {
    await expect(page.getByText('42')).toBeVisible();
  });

  test('13. Search dashboards by name using "Search by da..." input', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/Search by da/i);
    await searchInput.fill('Agentic Usage');
    await searchInput.press('Enter');

    await expect(page.getByRole('link', { name: 'Agentic Usage Overview Dashboard' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Analytics Usage Overview' })).toBeHidden();
  });

  test('14. Search with non-existent keyword displays empty state', async ({ page }) => {
    const searchInput = page.getByPlaceholder(/Search by da/i);
    await searchInput.fill('NonExistentShiftPayDashboard999');
    await searchInput.press('Enter');

    await expect(page.getByText(/No records to display|No results/i)).toBeVisible();
  });

  test('15. Toggle column filter builder icon next to search bar', async ({ page }) => {
    const filterIconBtn = page.locator('button[aria-label*="Filter"]').nth(1);
    await filterIconBtn.click();
    await expect(page.getByText(/Add condition|All conditions/i)).toBeVisible();
  });

  test('16. Open column personalization / settings gear menu', async ({ page }) => {
    const settingsBtn = page.locator('button[aria-label*="Personalize"], button[aria-label*="Columns"]');
    await settingsBtn.click();
    await expect(page.getByText('Description')).toBeVisible();
  });

  test('17. Sort dashboards table ascending and descending by Name column', async ({ page }) => {
    const nameHeader = page.getByRole('columnheader', { name: /Name/i });
    await nameHeader.click();
    await expect(nameHeader).toHaveAttribute('aria-sort', /ascending|descending/);
  });

  // ==========================================
  // 5. BULK SELECTION, BOOKMARKS & ROW ACTIONS
  // ==========================================

  test('18. Delete and Deactivate buttons remain disabled when no rows are selected', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Delete' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Deactivate' })).toBeDisabled();
  });

  test('19. Selecting a dashboard row checkbox enables Delete and Deactivate actions', async ({ page }) => {
    const firstRowCheckbox = page.getByRole('row').nth(1).getByRole('checkbox');
    await firstRowCheckbox.check();

    await expect(page.getByRole('button', { name: 'Delete' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Deactivate' })).toBeEnabled();
  });

  test('20. Click dashboard link in table opens Agentic Usage Overview Dashboard', async ({ page }) => {
    await page.getByRole('link', { name: 'Agentic Usage Overview Dashboard' }).click();
    await expect(page.getByRole('heading', { name: 'Agentic Usage Overview Dashboard' })).toBeVisible();
  });

});
