import { Page, expect } from '@playwright/test';
import fs from 'fs';
import { SN_INSTANCE, TOKEN_STATE, PORTAL } from '../playwright.config';

/**
 * The ShiftPay tables, fully qualified.
 *
 * These are the REAL table names on the instance. The employee calendar widget
 * ships `u_`-prefixed option defaults (`u_shift_submission`, `u_shift_type_catalog`,
 * …) that name no table at all — it runs only because the sp_instance
 * widget_parameters override all five. That discrepancy is itself a recorded
 * finding; see TEST-CASES-SHIFTPAY.md. Never take a table name from the widget
 * source.
 */
export const TABLES = {
  day: 'x_1995110_shift_0_u_shift_submission',
  timesheet: 'x_1995110_shift_0_monthly_timesheet',
  catalog: 'x_1995110_shift_0_shift_type',
  summary: 'x_1995110_shift_0_shift_submission_summary',
  entitlement: 'x_1995110_shift_0_shift_co_entitlement',
  dayChange: 'x_1995110_shift_0_shift_day_change',
} as const;

/**
 * The session's user token, as required by every Table API call.
 *
 * A session cookie on its own gets HTTP 401 from /api/now/table even with the
 * browser fully logged in. ServiceNow additionally wants `X-UserToken` (the
 * `g_ck` value), which is what stops a bare cookie authorising API calls from
 * anywhere.
 *
 * The setup project captures the token and writes it beside the storage state.
 * Reading it live from the page is the fallback, for when a session outlives the
 * file.
 */
let cachedToken: string | null = null;

async function userToken(page: Page, forceRefresh = false): Promise<string> {
  if (cachedToken && !forceRefresh) return cachedToken;

  if (!forceRefresh && fs.existsSync(TOKEN_STATE)) {
    try {
      const t = JSON.parse(fs.readFileSync(TOKEN_STATE, 'utf8')).userToken;
      if (t) {
        cachedToken = t;
        return t;
      }
    } catch {
      /* fall through to reading it live */
    }
  }

  // g_ck is exposed on the landing page, on classic list and form pages, and on
  // /shiftpay — but not on about:blank, so this only works once the page has
  // navigated somewhere real.
  const live = await page
    .evaluate(() => (window as unknown as { g_ck?: string }).g_ck || null)
    .catch(() => null);

  if (!live) {
    throw new Error(
      'No X-UserToken available. Run the `setup` project first, or call this after the page ' +
        'has navigated to a ServiceNow page (about:blank does not expose g_ck).'
    );
  }
  cachedToken = live;
  return live;
}

/**
 * Read records through the Table API using the browser's own session.
 *
 * This is the `Verify` half of every test case: what the record holds, as
 * opposed to what the screen claimed. Reusing the page's session rather than a
 * separate credential means the assertion sees exactly what the signed-in user
 * sees.
 */
export async function tableApi(
  page: Page,
  table: string,
  params: { query?: string; fields?: string[]; limit?: number } = {}
): Promise<Record<string, string>[]> {
  const search = new URLSearchParams();
  if (params.query) search.set('sysparm_query', params.query);
  if (params.fields) search.set('sysparm_fields', params.fields.join(','));
  search.set('sysparm_limit', String(params.limit ?? 100));
  // Values, not display values — a test asserting "status is submitted" must not
  // pass because the label happens to read "Submitted".
  search.set('sysparm_display_value', 'false');
  // Reference fields otherwise arrive as {link, value} objects rather than the
  // sys_id string, so every comparison against one silently fails on shape.
  search.set('sysparm_exclude_reference_link', 'true');

  const url = `${SN_INSTANCE}/api/now/table/${table}?${search.toString()}`;

  let res = await page.request.get(url, {
    headers: { 'X-UserToken': await userToken(page) },
  });

  // A stale token reads as 401, which is indistinguishable from "not logged in"
  // in the failure message. Refresh from the live page and try once more, so a
  // long run does not fail on an expired token and get diagnosed as an ACL bug.
  if (res.status() === 401) {
    const refreshed = await userToken(page, true).catch(() => null);
    if (refreshed) {
      res = await page.request.get(url, { headers: { 'X-UserToken': refreshed } });
    }
  }

  expect(
    res.ok(),
    `Table API ${table} returned HTTP ${res.status()} for ${params.query ?? '(no query)'}`
  ).toBeTruthy();
  const body = await res.json();
  return body.result ?? [];
}

/** The sys_id of the signed-in user, resolved once per run. */
let cachedUserId: string | null = null;

export async function currentUserId(page: Page): Promise<string> {
  if (cachedUserId) return cachedUserId;
  const user = process.env.SN_USER;
  const rows = await tableApi(page, 'sys_user', {
    query: `user_name=${user}`,
    fields: ['sys_id', 'user_name', 'name'],
    limit: 1,
  });
  expect(rows.length, `No sys_user found with user_name=${user}`).toBeGreaterThan(0);
  cachedUserId = rows[0].sys_id;
  return cachedUserId!;
}

/** Open a page in the ShiftPay Service Portal. */
export async function openPortal(
  page: Page,
  pageId: string,
  params: Record<string, string> = {}
): Promise<void> {
  const qs = new URLSearchParams({ id: pageId, ...params });
  await page.goto(`${SN_INSTANCE}/${PORTAL}?${qs.toString()}`, {
    waitUntil: 'domcontentloaded',
  });
}

/** Open a classic list, optionally filtered by an encoded query. */
export async function openList(
  page: Page,
  table: string,
  encodedQuery?: string
): Promise<void> {
  const q = encodedQuery ? `?sysparm_query=${encodeURIComponent(encodedQuery)}` : '';
  await page.goto(`${SN_INSTANCE}/${table}_list.do${q}`, {
    waitUntil: 'domcontentloaded',
  });
}
