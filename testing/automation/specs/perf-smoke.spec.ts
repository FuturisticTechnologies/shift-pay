import { test, expect } from '@playwright/test';
import { SN_INSTANCE } from '../playwright.config';
import { TABLES, tableApi, currentUserId } from '../lib/servicenow';
import * as SP from '../lib/shiftpay';
import { seedHistory, teardown, SeedHandle } from '../lib/seed';

/**
 * Performance smoke: does month load degrade as submissions accumulate?
 *
 * SP-103. Not part of the nine documented cases and deliberately not wired into
 * the evidence generator — it produces a timing, not a screenshot, and the
 * evidence records are for cases with a stated expected result in
 * TEST-CASES-SHIFTPAY.md. Run it on demand, not on every commit.
 *
 * The question it answers is narrow and worth answering once: no query in the
 * calendar should scale with history. The month grid reads one month, the
 * aggregates are recomputed per affected period rather than accumulated, and
 * the entitlement window is bounded. If any of that stops being true, this
 * catches it while the data is still small enough to delete.
 *
 * Threshold is deliberately loose. It is a smoke test, not a benchmark: it
 * should fail when something has become O(history), not when the instance is
 * having a slow afternoon.
 */

const BUDGET_MS = 2000;
const MONTHS_OF_HISTORY = 12;

test.describe('performance smoke', () => {
  let handle: SeedHandle | null = null;

  test.afterAll(async ({ browser }) => {
    if (!handle) return;
    const page = await browser.newPage();
    const removed = await teardown(page, handle);
    console.log(`perf-smoke: removed ${removed} seeded submissions`);
    await page.close();
  });

  test('month load stays inside budget with a year of history behind it', async ({ page }) => {
    test.slow();

    const userId = await currentUserId(page);
    const catalogue = await tableApi(page, 'GET', TABLES.catalog, undefined, {
      sysparm_query: 'active=true^oc_role=none^allow_weekday=true',
      sysparm_limit: '1',
    });
    expect(catalogue.length, 'need one ordinary weekday shift type to seed with').toBeGreaterThan(0);

    // Two months ahead, same window the rest of the pack writes in, so a
    // seeded month can never collide with a real submitted one.
    const target = SP.monthsAhead(2);

    const cold = await SP.openCalendarMonth(page, target.year, target.month0);
    console.log(`perf-smoke: cold load, no history: ${cold.elapsedMs} ms`);

    handle = await seedHistory(page, {
      endYear: target.year,
      endMonth0: target.month0,
      months: MONTHS_OF_HISTORY,
      shiftTypeId: catalogue[0].sys_id,
    });
    console.log(`perf-smoke: seeded ${handle.sysIds.length} submissions for user ${userId}`);

    const warm = await SP.openCalendarMonth(page, target.year, target.month0);
    console.log(`perf-smoke: load with ${MONTHS_OF_HISTORY} months behind it: ${warm.elapsedMs} ms`);

    // The absolute budget is the headline, but the ratio is the real signal:
    // a load that has become proportional to history will blow past both.
    expect(warm.elapsedMs).toBeLessThan(BUDGET_MS);
    expect(warm.elapsedMs).toBeLessThan(cold.elapsedMs * 3);
  });
});
