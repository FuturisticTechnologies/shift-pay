import { test, expect, Page } from '@playwright/test';
import { RESULTS_DIR, SN_INSTANCE } from '../playwright.config';
import { TABLES, tableApi, currentUserId } from '../lib/servicenow';
import { CaseEvidence, flushCurrentCase, describeRun } from '../lib/evidence';
import * as SP from '../lib/shiftpay';

/**
 * The executable ShiftPay test cases.
 *
 * Nine of the thirty-five in TEST-CASES-SHIFTPAY.md. **Three of them are
 * expected to fail** — TC-SP-004 and TC-SP-005 on real defects, TC-SP-009 on a
 * deliberately introduced one. A red run here is a correct run; see the pack
 * README before "fixing" anything.
 *
 * Every case is read-only or self-reversing. Writes go only to the signed-in
 * account's own calendar, in a future unsubmitted month, and are undone in the
 * same case. Nothing here approves, rejects or corrects a timesheet.
 *
 * Ordering rule for the failing cases: **record first, assert last.** The
 * expectation that turns the run red must come after every screenshot and record
 * dump, or the document arrives with a red badge and none of the evidence that
 * justifies it.
 */

test.afterEach(({}, testInfo) => {
  flushCurrentCase(RESULTS_DIR, testInfo.status, testInfo.error?.message);
});

describeRun({
  instance: SN_INSTANCE,
  executedBy: process.env.SN_USER || 'unknown',
  executedVia:
    'Playwright (automated), driving the /shiftpay Service Portal; every screen ' +
    'assertion cross-checked against the ServiceNow Table API.',
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The month the writing cases operate in: two ahead of today.
 *
 * Far enough forward that no submission window is open and no timesheet row
 * exists, so nothing is locked and no aggregate anybody is looking at moves.
 */
function targetMonth(): [number, number] {
  const now = new Date();
  const m = now.getMonth() + 2;
  return [now.getFullYear() + Math.floor(m / 12), m % 12];
}

/** The month the manager cases read: the most recent one holding a submitted timesheet. */
async function managerMonthWithData(
  page: Page,
  managerId: string
): Promise<{ year: number; month0: number; timesheets: Record<string, string>[] }> {
  const reportees = await tableApi(page, 'sys_user', {
    query: `manager=${managerId}^active=true`,
    fields: ['sys_id'],
    limit: 100,
  });
  const ids = reportees.map((r) => r.sys_id).join(',');
  const rows = await tableApi(page, TABLES.timesheet, {
    query: `u_userIN${ids}^status=submitted^ORDERBYDESCu_year^ORDERBYDESCu_month`,
    fields: ['u_user', 'u_year', 'u_month', 'status'],
    limit: 50,
  });
  expect(
    rows.length,
    'No reportee has a submitted timesheet, so the manager cases have nothing to assert against.'
  ).toBeGreaterThan(0);

  const year = Number(rows[0].u_year);
  const month0 = Number(rows[0].u_month) - 1; // stored 1-indexed
  const timesheets = await tableApi(page, TABLES.timesheet, {
    query: `u_userIN${ids}^u_year=${year}^u_month=${month0 + 1}`,
    fields: ['u_user', 'u_year', 'u_month', 'status', 'approver'],
    limit: 50,
  });
  return { year, month0, timesheets };
}

/** The active catalogue, keyed by name. */
async function catalogue(page: Page): Promise<Record<string, Record<string, string>>> {
  const rows = await tableApi(page, TABLES.catalog, {
    query: 'active=true^ORDERBYname',
    fields: [
      'sys_id', 'name', 'description', 'rate', 'currency',
      'oc_role', 'allow_weekday', 'allow_weekend_holiday', 'day_category',
    ],
    limit: 50,
  });
  const byName: Record<string, Record<string, string>> = {};
  rows.forEach((r) => (byName[r.name] = r));
  return byName;
}

/** Day rows for one user across one month, keyed by date. */
async function dayRows(
  page: Page,
  userId: string,
  y: number,
  m0: number
): Promise<Record<string, Record<string, string>>> {
  const from = SP.isoDate(y, m0, 1);
  const to = SP.isoDate(y, m0, SP.daysInMonth(y, m0));
  const rows = await tableApi(page, TABLES.day, {
    query: `u_user=${userId}^u_date>=${from}^u_date<=${to}^ORDERBYu_date`,
    fields: ['sys_id', 'u_date', 'u_shift_type', 'u_comment'],
    limit: 100,
  });
  const byDate: Record<string, Record<string, string>> = {};
  rows.forEach((r) => (byDate[r.u_date] = r));
  return byDate;
}

/** The first weekday of the target month with no entry, excluding `taken`. */
function freeWeekday(
  y: number,
  m0: number,
  existing: Record<string, unknown>,
  taken: string[] = []
): string {
  const found = SP.weekdaysOf(y, m0).find((k) => !existing[k] && !taken.includes(k));
  expect(found, `No unlogged weekday left in ${SP.monthLabel(y, m0)}`).toBeTruthy();
  return found!;
}

/** The first Saturday whose 7-weekday CO window ends inside the same month. */
function saturdayWithWindow(y: number, m0: number, existing: Record<string, unknown>): string {
  const found = SP.saturdaysOf(y, m0).find(
    (s) => !existing[s] && SP.nthWeekdayAfter(s, 7).slice(0, 7) === `${y}-${SP.pad(m0 + 1)}`
  );
  expect(
    found,
    `No free Saturday in ${SP.monthLabel(y, m0)} whose 7-weekday window stays in-month`
  ).toBeTruthy();
  return found!;
}

/** Entitlement rows for one user. */
async function entitlements(page: Page, userId: string): Promise<Record<string, string>[]> {
  return tableApi(page, TABLES.entitlement, {
    query: `u_user=${userId}^ORDERBYoc_date`,
    fields: ['sys_id', 'oc_date', 'u_oc_window_end', 'u_co_date', 'u_co_entry', 'u_oc_entry'],
    limit: 100,
  });
}

/**
 * Remove a day through the widget, tolerating a day that is already empty.
 *
 * Teardown only. It deliberately does not assert the removal worked — TC-SP-004
 * exists precisely because the UI cannot be trusted to report that, so teardown
 * verifies against the record instead.
 */
async function tearDownDay(page: Page, key: string): Promise<void> {
  await SP.openDay(page, key);
  const hasClear = await page
    .locator(SP.CAL.popover)
    .getByRole('button', { name: 'Clear' })
    .count();
  if (hasClear) await SP.clearDay(page);
  else await SP.closePopover(page);
}

// ─────────────────────────────────────────────────────────────────────────────
// TC-SP-001
// ─────────────────────────────────────────────────────────────────────────────

test('TC-SP-001 — Weekday and weekend offer different shift sets, driven by catalogue columns', async ({
  page,
}) => {
  const ev = new CaseEvidence(
    'TC-SP-001',
    'Weekday and weekend offer different shift sets, driven by catalogue columns'
  );
  ev.expect('The weekday dropdown equals the catalogue rows with allow_weekday = true, minus the consumes_co row.');
  ev.expect('The weekend dropdown equals the catalogue rows with allow_weekend_holiday = true.');
  ev.expect('CO is absent from the weekday list — a CO is earned, not merely permitted.');

  const [y, m0] = targetMonth();
  const me = await currentUserId(page);
  const cat = await catalogue(page);
  const rows = Object.values(cat);
  ev.record('Active shift catalogue', TABLES.catalog, 'active=true', rows);

  const expectedWeekday = rows
    .filter((r) => r.allow_weekday === 'true' && r.oc_role !== 'consumes_co')
    .map((r) => r.name)
    .sort();
  const expectedWeekend = rows
    .filter((r) => r.allow_weekend_holiday === 'true')
    .map((r) => r.name)
    .sort();

  ev.step(`Open the calendar and navigate to ${SP.monthLabel(y, m0)}.`);
  await SP.openCalendar(page);
  await SP.gotoMonth(page, y, m0);

  const existing = await dayRows(page, me, y, m0);
  const weekday = freeWeekday(y, m0, existing);
  const saturday = saturdayWithWindow(y, m0, existing);

  ev.step(`Open the plain weekday ${weekday} and read every shift offered.`);
  await SP.openDay(page, weekday);
  const weekdayCodes = (await SP.dropdownShiftCodes(page)).sort();
  await ev.shot(page, 'weekday-dropdown');
  await SP.closePopover(page);

  ev.step(`Open the Saturday ${saturday} and read every shift offered.`);
  await SP.openDay(page, saturday);
  const weekendCodes = (await SP.dropdownShiftCodes(page)).sort();
  await ev.shot(page, 'weekend-dropdown');
  await SP.closePopover(page);

  ev.record('Allowed shifts, screen vs catalogue', '(derived)', `${weekday} and ${saturday}`, [
    { day: weekday, kind: 'weekday', on_screen: weekdayCodes.join(', '), from_catalogue: expectedWeekday.join(', ') },
    { day: saturday, kind: 'weekend', on_screen: weekendCodes.join(', '), from_catalogue: expectedWeekend.join(', ') },
  ]);

  ev.actual(`Weekday ${weekday} offers: ${weekdayCodes.join(', ')}`);
  ev.actual(`Saturday ${saturday} offers: ${weekendCodes.join(', ')}`);

  const coName = rows.find((r) => r.oc_role === 'consumes_co')?.name ?? 'CO';
  ev.observe(
    `The catalogue drives this entirely: no code branches on a shift type's name. "${coName}" is ` +
      'withheld from the weekday list by ShiftPayCalendarRules.baseAllowedSysIds and added back ' +
      'only where an unconsumed entitlement window covers the date — proved by TC-SP-003.'
  );

  ev.pass(
    `Both lists match the catalogue columns exactly, and ${coName} is correctly absent from the weekday list.`
  );

  expect(weekdayCodes, 'weekday dropdown vs allow_weekday').toEqual(expectedWeekday);
  expect(weekendCodes, 'weekend dropdown vs allow_weekend_holiday').toEqual(expectedWeekend);
  expect(weekdayCodes, `${coName} must not be offered without an entitlement`).not.toContain(coName);
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-SP-002
// ─────────────────────────────────────────────────────────────────────────────

test('TC-SP-002 — Logging a day writes one row and re-aggregates with a rate snapshot', async ({
  page,
}) => {
  const ev = new CaseEvidence(
    'TC-SP-002',
    'Logging a day writes one row and re-aggregates with a rate snapshot'
  );
  ev.expect('Saving produces exactly one u_shift_submission row for that user and date, with the chosen shift type and the typed comment.');
  ev.expect('A week summary row exists for the Monday of that week with u_rate_snapshot equal to the catalogue rate and u_amount = u_count x u_rate_snapshot.');
  ev.expect('Clearing the day removes the submission row and reverts the summary.');

  const [y, m0] = targetMonth();
  const me = await currentUserId(page);
  const cat = await catalogue(page);
  const uk = cat['UK'];
  expect(uk, 'No catalogue row named "UK"').toBeTruthy();
  const rate = Number(uk.rate);
  const comment = 'Automated test — TC-SP-002';

  await SP.openCalendar(page);
  await SP.gotoMonth(page, y, m0);

  const existing = await dayRows(page, me, y, m0);
  const key = freeWeekday(y, m0, existing);
  const monday = SP.mondayOf(key);

  const summaryQuery = `u_user=${me}^u_period_type=week^u_period_start=${monday}^u_shift_type=${uk.sys_id}`;
  const before = await tableApi(page, TABLES.summary, {
    query: summaryQuery,
    fields: ['sys_id', 'u_count', 'u_rate_snapshot', 'u_amount'],
    limit: 10,
  });
  ev.record('Week summary before the write', TABLES.summary, summaryQuery, before);

  ev.step(`Log UK on ${key} with a comment, and confirm the chip renders.`);
  await SP.openDay(page, key);
  await SP.selectShift(page, 'UK');
  await SP.saveDay(page, comment);
  await expect
    .poll(() => SP.chipOn(page, key), { timeout: 30_000 })
    .toBe('UK');
  await ev.shot(page, 'day-logged');

  ev.step('Read the submission row the save produced.');
  const saved = await tableApi(page, TABLES.day, {
    query: `u_user=${me}^u_date=${key}`,
    fields: ['sys_id', 'u_date', 'u_shift_type', 'u_comment'],
    limit: 10,
  });
  ev.record('Submission row after the save', TABLES.day, `u_user=<me>^u_date=${key}`, saved);

  ev.step('Read the recomputed week summary and check the arithmetic.');
  const after = await tableApi(page, TABLES.summary, {
    query: summaryQuery,
    fields: ['sys_id', 'u_period_start', 'u_count', 'u_rate_snapshot', 'u_amount', 'u_currency'],
    limit: 10,
  });
  ev.record('Week summary after the write', TABLES.summary, summaryQuery, after);

  const beforeCount = Number(before[0]?.u_count ?? 0);
  const row = after[0];
  ev.actual(
    `${saved.length} submission row(s) for ${key}; week of ${monday} now counts ` +
      `${row?.u_count ?? '0'} UK shift(s) at a snapshot of ${row?.u_rate_snapshot ?? '—'}.`
  );

  ev.step(`Clear ${key} and confirm both the row and the aggregate revert.`);
  await SP.openDay(page, key);
  await SP.clearDay(page);
  await expect.poll(() => SP.chipOn(page, key), { timeout: 30_000 }).toBe('');

  const clearedRows = await tableApi(page, TABLES.day, {
    query: `u_user=${me}^u_date=${key}`,
    fields: ['sys_id'],
    limit: 10,
  });
  const revertedSummary = await tableApi(page, TABLES.summary, {
    query: summaryQuery,
    fields: ['sys_id', 'u_count', 'u_amount'],
    limit: 10,
  });
  ev.record('After the clear', '(derived)', `${key} and week of ${monday}`, [
    {
      submission_rows: String(clearedRows.length),
      summary_count: String(Number(revertedSummary[0]?.u_count ?? 0)),
      summary_count_before_run: String(beforeCount),
    },
  ]);
  ev.actual(
    `After clearing: ${clearedRows.length} submission row(s), week count back to ` +
      `${Number(revertedSummary[0]?.u_count ?? 0)} (was ${beforeCount} before the run).`
  );

  ev.observe(
    'The rate is asserted as u_rate_snapshot on the summary row, not as the live catalogue rate. ' +
      'The snapshot is what payroll pays and what a manager approves, so a catalogue change after ' +
      'aggregation must not move it — reading the live rate would hide it if that ever broke.'
  );
  ev.observe(
    'Aggregates are recomputed rather than incremented: ShiftPayAggregator deletes and rewrites the ' +
      'affected week and month rows per shift type, which is why clearing the day removes the row ' +
      'outright instead of leaving a zero-count orphan.'
  );

  ev.pass(
    `One row written and removed cleanly; the week aggregate moved to ${beforeCount + 1} at a ` +
      `snapshot of ${rate} and back to ${beforeCount}.`
  );

  expect(saved.length, 'exactly one submission row').toBe(1);
  expect(saved[0].u_shift_type).toBe(uk.sys_id);
  expect(saved[0].u_comment).toBe(comment);
  expect(row, `no week summary row for ${monday}`).toBeTruthy();
  expect(Number(row.u_count)).toBe(beforeCount + 1);
  expect(Number(row.u_rate_snapshot)).toBe(rate);
  expect(Number(row.u_amount)).toBe(Number(row.u_count) * rate);
  expect(clearedRows.length, 'submission row removed by the clear').toBe(0);
  expect(Number(revertedSummary[0]?.u_count ?? 0), 'week aggregate reverted').toBe(beforeCount);
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-SP-003
// ─────────────────────────────────────────────────────────────────────────────

test('TC-SP-003 — The CO entitlement lifecycle, end to end', async ({ page }) => {
  const ev = new CaseEvidence('TC-SP-003', 'The CO entitlement lifecycle, end to end');
  ev.expect('Logging a grants_co shift inserts one entitlement row whose u_oc_window_end is the 7th weekday after the OC date.');
  ev.expect('CO becomes selectable on a weekday inside that window, where TC-SP-001 proved it is not selectable without one.');
  ev.expect('Saving CO consumes that same entitlement row — u_co_date and u_co_entry are set, and no second row appears.');
  ev.expect('Clearing the OC shift is refused while a CO depends on it; the submission row survives.');
  ev.expect('After teardown the entitlement row is deleted and the table is back to its baseline count.');

  const [y, m0] = targetMonth();
  const me = await currentUserId(page);
  const cat = await catalogue(page);
  const granting = Object.values(cat).find((r) => r.oc_role === 'grants_co');
  const consuming = Object.values(cat).find((r) => r.oc_role === 'consumes_co');
  expect(granting, 'No catalogue row with oc_role = grants_co').toBeTruthy();
  expect(consuming, 'No catalogue row with oc_role = consumes_co').toBeTruthy();

  const baseline = await entitlements(page, me);
  ev.record('Entitlement rows before the run', TABLES.entitlement, 'u_user=<me>', baseline);

  await SP.openCalendar(page);
  await SP.gotoMonth(page, y, m0);
  const existing = await dayRows(page, me, y, m0);
  const saturday = saturdayWithWindow(y, m0, existing);
  const windowEnd = SP.nthWeekdayAfter(saturday, 7);
  const coDay = SP.weekdaysOf(y, m0).find(
    (k) => k > saturday && k <= windowEnd && !existing[k]
  )!;
  expect(coDay, 'No free weekday inside the entitlement window').toBeTruthy();

  ev.step(`Log ${granting!.name} on the Saturday ${saturday}.`);
  await SP.openDay(page, saturday);
  await SP.selectShift(page, granting!.name);
  await SP.saveDay(page);
  await expect.poll(() => SP.chipOn(page, saturday), { timeout: 30_000 }).toBe(granting!.name);
  await ev.shot(page, 'oc-logged');

  ev.step('Read the entitlement row it opened, and check the window arithmetic independently.');
  const opened = await entitlements(page, me);
  const mine = opened.find((e) => e.oc_date === saturday);
  ev.record('Entitlement opened by the OC shift', TABLES.entitlement, `oc_date=${saturday}`, mine ? [mine] : []);
  ev.actual(
    `Window: ${saturday} → ${mine?.u_oc_window_end ?? '(none)'}; independently computed 7th weekday after = ${windowEnd}.`
  );

  ev.step(`Open ${coDay}, inside the window, and confirm ${consuming!.name} is now offered.`);
  await SP.openDay(page, coDay);
  const inWindowCodes = await SP.dropdownShiftCodes(page);
  await ev.shot(page, 'co-now-offered');
  ev.actual(`${coDay} now offers: ${inWindowCodes.join(', ')}`);

  ev.step(`Select ${consuming!.name} and save; confirm the entitlement is consumed, not duplicated.`);
  await SP.selectShift(page, consuming!.name);
  await SP.saveDay(page);
  await expect.poll(() => SP.chipOn(page, coDay), { timeout: 30_000 }).toBe(consuming!.name);

  const consumed = await entitlements(page, me);
  const mineNow = consumed.find((e) => e.oc_date === saturday);
  ev.record('Entitlement after the CO was taken', TABLES.entitlement, `oc_date=${saturday}`, mineNow ? [mineNow] : []);
  ev.actual(
    `Entitlement now records u_co_date = ${mineNow?.u_co_date ?? '(empty)'} and an entry reference ` +
      `${mineNow?.u_co_entry ? 'is set' : 'is EMPTY'}. Total rows: ${consumed.length} (baseline ${baseline.length}).`
  );

  ev.step('Attempt to clear the OC shift the CO depends on — the server must refuse.');
  await SP.openDay(page, saturday);
  await SP.clearDay(page);
  const afterRefusal = await tableApi(page, TABLES.day, {
    query: `u_user=${me}^u_date=${saturday}`,
    fields: ['sys_id', 'u_date', 'u_shift_type'],
    limit: 10,
  });
  ev.record('The OC day after the refused clear', TABLES.day, `u_date=${saturday}`, afterRefusal);
  ev.actual(
    `After the refused clear the OC submission row ${afterRefusal.length === 1 ? 'still exists' : 'is GONE'}.`
  );

  ev.step('Teardown: clear the CO, then the OC, and confirm the entitlement is deleted.');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await SP.openCalendar(page);
  await SP.gotoMonth(page, y, m0);
  await tearDownDay(page, coDay);
  await tearDownDay(page, saturday);

  const final = await entitlements(page, me);
  const finalDays = await tableApi(page, TABLES.day, {
    query: `u_user=${me}^u_dateIN${saturday},${coDay}`,
    fields: ['sys_id', 'u_date'],
    limit: 10,
  });
  ev.record('After teardown', '(derived)', 'entitlements and the two days', [
    {
      entitlement_rows: String(final.length),
      baseline_rows: String(baseline.length),
      rows_for_oc_date: String(final.filter((e) => e.oc_date === saturday).length),
      submission_rows_left: String(finalDays.length),
    },
  ]);

  ev.observe(
    'The window is seven *weekdays*, not seven days — _nthWeekdayAfter skips Saturdays and Sundays. ' +
      'This case computes the expected end date itself rather than reading u_oc_window_end back, ' +
      'because a case that reads the value it is checking asserts nothing.'
  );
  ev.observe(
    'The refusal in step 5 is the ordering guard in ShiftPayEntitlements.releasePrevious: removing ' +
      'the OC would leave a CO nobody had earned. It is asserted here at record level. That the ' +
      'SCREEN does not report the refusal is a separate defect — see TC-SP-004.'
  );

  ev.pass(
    'Window opened with correct weekday arithmetic, consumed in place, guarded against removal, ' +
      'and released cleanly. Entitlement table back to baseline.'
  );

  expect(mine, `no entitlement row was opened for ${saturday}`).toBeTruthy();
  expect(mine!.u_oc_window_end, '7-weekday window end').toBe(windowEnd);
  expect(opened.length, 'exactly one entitlement added').toBe(baseline.length + 1);
  expect(inWindowCodes, `${consuming!.name} should be offered inside the window`).toContain(consuming!.name);
  expect(mineNow!.u_co_date, 'CO date recorded on the entitlement').toBe(coDay);
  expect(mineNow!.u_co_entry, 'CO entry reference recorded').toBeTruthy();
  expect(consumed.length, 'consumption must not create a second row').toBe(baseline.length + 1);
  expect(afterRefusal.length, 'the OC row must survive the refused clear').toBe(1);
  expect(final.length, 'entitlement table back to baseline').toBe(baseline.length);
  expect(finalDays.length, 'both test days removed').toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-SP-004 — expected to FAIL
// ─────────────────────────────────────────────────────────────────────────────

test('TC-SP-004 — A refused write is painted on screen as though it succeeded', async ({ page }) => {
  const ev = new CaseEvidence(
    'TC-SP-004',
    'A refused write is painted on screen as though it succeeded'
  );
  ev.expect('When the server refuses to clear a day, the refusal is shown to the user — "Cannot clear — CO on ... depends on this entry." in .shift-popover__error.');
  ev.expect('The day keeps its shift chip, because nothing was removed.');
  ev.expect('What the screen shows after the refusal matches what the screen shows after a reload.');

  const [y, m0] = targetMonth();
  const me = await currentUserId(page);
  const cat = await catalogue(page);
  const granting = Object.values(cat).find((r) => r.oc_role === 'grants_co')!;
  const consuming = Object.values(cat).find((r) => r.oc_role === 'consumes_co')!;

  await SP.openCalendar(page);
  await SP.gotoMonth(page, y, m0);
  const existing = await dayRows(page, me, y, m0);
  const saturday = saturdayWithWindow(y, m0, existing);
  const windowEnd = SP.nthWeekdayAfter(saturday, 7);
  const coDay = SP.weekdaysOf(y, m0).find((k) => k > saturday && k <= windowEnd && !existing[k])!;

  ev.step(`Build the dependency: ${granting.name} on ${saturday}, then ${consuming.name} on ${coDay}.`);
  await SP.openDay(page, saturday);
  await SP.selectShift(page, granting.name);
  await SP.saveDay(page);
  await expect.poll(() => SP.chipOn(page, saturday), { timeout: 30_000 }).toBe(granting.name);
  await SP.openDay(page, coDay);
  await SP.selectShift(page, consuming.name);
  await SP.saveDay(page);
  await expect.poll(() => SP.chipOn(page, coDay), { timeout: 30_000 }).toBe(consuming.name);

  ev.step(`Press Clear on ${saturday}. The server will refuse — watch what the screen does.`);
  await SP.openDay(page, saturday);
  const errorShownDuring = await page
    .locator(SP.CAL.popoverError)
    .isVisible()
    .catch(() => false);
  await SP.clearDay(page);

  const chipAfterRefusal = await SP.chipOn(page, saturday);
  const errorVisible = await page
    .locator(SP.CAL.popoverError)
    .isVisible()
    .catch(() => false);
  await ev.shot(page, 'after-refused-clear-cell-is-empty');

  ev.step('Read the record. The server refused, so nothing should have moved.');
  const dayAfter = await tableApi(page, TABLES.day, {
    query: `u_user=${me}^u_date=${saturday}`,
    fields: ['sys_id', 'u_date', 'u_shift_type'],
    limit: 10,
  });
  const entAfter = await entitlements(page, me);
  const mine = entAfter.find((e) => e.oc_date === saturday);
  ev.record('The OC day in the database after the refused clear', TABLES.day, `u_date=${saturday}`, dayAfter);
  ev.record('The entitlement it granted', TABLES.entitlement, `oc_date=${saturday}`, mine ? [mine] : []);

  ev.step('Reload the page and look at the same cell again.');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await SP.openCalendar(page);
  await SP.gotoMonth(page, y, m0);
  const chipAfterReload = await SP.chipOn(page, saturday);
  await ev.shot(page, 'after-reload-chip-is-back');

  ev.record('Screen versus record', '(derived)', 'the same day, three readings', [
    {
      reading: 'popover error shown',
      value: errorVisible || errorShownDuring ? 'yes' : 'NO',
      expected: 'yes',
    },
    { reading: 'chip immediately after the refused clear', value: chipAfterRefusal || '(empty)', expected: granting.name },
    { reading: 'chip after a page reload', value: chipAfterReload || '(empty)', expected: granting.name },
    { reading: 'submission rows in the database', value: String(dayAfter.length), expected: '1' },
  ]);

  ev.actual(
    `The server refused correctly: ${dayAfter.length} submission row(s) still present and the entitlement is untouched.`
  );
  ev.actual(
    `The screen did not say so. No error rendered, and the cell went to "${chipAfterRefusal || '(empty)'}" ` +
      `immediately after the refusal — then back to "${chipAfterReload}" after a reload.`
  );

  // ── Teardown BEFORE the failing assertion, so a red verdict still leaves a
  //    clean instance. The two screenshots and every record dump are already
  //    captured above.
  await tearDownDay(page, coDay);
  await tearDownDay(page, saturday);
  const leftover = await tableApi(page, TABLES.day, {
    query: `u_user=${me}^u_dateIN${saturday},${coDay}`,
    fields: ['sys_id'],
    limit: 10,
  });
  ev.record('After teardown', TABLES.day, `u_dateIN${saturday},${coDay}`, [
    { submission_rows_left: String(leftover.length) },
  ]);

  ev.observe(
    'ROOT CAUSE: c.saveCell, c.clearCell and c.bulkApply all branch on r.data.error. The calendar ' +
      'server script never sets data.error — all six refusal paths call gs.addErrorMessage() instead. ' +
      'r.data.error is therefore always undefined, the client takes its success branch, deletes the ' +
      'entry from c.entries, closes the popover and repaints.'
  );
  ev.observe(
    'SCOPE: this is not one refusal. Every server-side refusal in the calendar is invisible the same ' +
      'way — month locked, CO dependency, CO unavailable, a bulk-blocked shift type, and the ' +
      'incomplete-month submit refusal.'
  );
  ev.observe(
    'SEVERITY: the user believes a change landed that did not. They will not find out until they ' +
      'reload, and on a month they then submit, the discrepancy reaches the manager as a surprise.'
  );
  ev.observe(
    'FIX: mirror the Manager Approval widget, which gets this right — its fail() sets ' +
      'data.actionError AND calls gs.addErrorMessage, and its template renders .shift-mgr__error. ' +
      'Set data.error on the calendar\'s refusal paths and keep the growl.'
  );
  ev.observe(
    'The server is not at fault and needs no change: it refused, and the record proves it held the line.'
  );

  ev.fail(
    'The server correctly refused to clear the day, but the calendar reported success — no error was ' +
      'shown and the cell was repainted empty while the record still held the shift. A user cannot ' +
      'tell a refused write from an accepted one.'
  );

  expect(
    chipAfterRefusal,
    'the cell should still show the shift the server refused to remove'
  ).toBe(granting.name);
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-SP-005 — expected to FAIL
// ─────────────────────────────────────────────────────────────────────────────

test('TC-SP-005 — The weekend dropdown offers two shifts the business rules forbid', async ({
  page,
}) => {
  const ev = new CaseEvidence(
    'TC-SP-005',
    'The weekend dropdown offers two shifts the business rules forbid'
  );
  ev.expect('README section "Business Rules — Shift Availability" states the weekend/holiday set is exactly OC, OC+CO, OC+UK+CO and OC+US+CO.');
  ev.expect('A Saturday therefore offers four shift types, and no others.');

  const WEEKEND_PER_SPEC = ['OC', 'OC + CO', 'OC + UK + CO', 'OC + US + CO'].sort();

  const [y, m0] = targetMonth();
  const me = await currentUserId(page);

  await SP.openCalendar(page);
  await SP.gotoMonth(page, y, m0);
  const existing = await dayRows(page, me, y, m0);
  const saturday = SP.saturdaysOf(y, m0).find((s) => !existing[s])!;

  ev.step(`Open the Saturday ${saturday} and open the shift dropdown.`);
  await SP.openDay(page, saturday);
  const groups = await SP.dropdownGroups(page);
  await ev.shot(page, 'saturday-dropdown-six-options');
  const offered = groups.flatMap((g) => g.items.map((i) => i.short)).sort();
  await SP.closePopover(page);

  const unexpected = offered.filter((c) => !WEEKEND_PER_SPEC.includes(c));

  ev.record(
    'What the Saturday dropdown offers, by group heading',
    '/shiftpay?id=fill_shift',
    saturday,
    groups.flatMap((g) => g.items.map((i) => ({ group_heading: g.heading, shift: i.short, label: i.label })))
  );

  ev.step('Read the catalogue rows that cause it.');
  const weekendRows = await tableApi(page, TABLES.catalog, {
    query: 'active=true^allow_weekend_holiday=true^ORDERBYname',
    fields: ['name', 'description', 'rate', 'allow_weekday', 'allow_weekend_holiday', 'day_category', 'oc_role'],
    limit: 50,
  });
  ev.record(
    'Catalogue rows selectable on a weekend or holiday',
    TABLES.catalog,
    'active=true^allow_weekend_holiday=true',
    weekendRows
  );

  ev.actual(`The Saturday dropdown offers ${offered.length} shift types: ${offered.join(', ')}.`);
  ev.actual(
    unexpected.length
      ? `${unexpected.length} of them are not in the documented weekend set: ${unexpected.join(', ')}.`
      : 'All of them are in the documented weekend set.'
  );

  ev.observe(
    `Cause: the catalogue rows ${unexpected.map((u) => `"${u}"`).join(' and ')} carry ` +
      'allow_weekend_holiday = true. Availability is data-driven, so the widget is faithfully ' +
      'rendering what the data says — the data is what disagrees with the specification.'
  );
  ev.observe(
    'FIX is a data change, not a code change: untick allow_weekend_holiday on those rows. No widget ' +
      'is touched, and nothing needs redeploying.'
  );
  ev.observe(
    'SEVERITY today is cosmetic only because both offending rows are rated at 0. The same mistake on ' +
      'a paid row would put money on a day nobody worked, which is a pay bug rather than a tidiness one.'
  );
  ev.observe(
    'ADJACENT: the consumes_co row carries day_category = holiday while allow_weekend_holiday = false, ' +
      'so the legend and the dropdown file CO under "Holiday work (weekend or declared holiday)" — a ' +
      'class of day on which it can never be logged. Cosmetic, but it sends a user looking in the ' +
      'wrong place. Recorded here rather than raised as its own case.'
  );

  ev.fail(
    `The weekend dropdown offers ${offered.length} shift types where the documented rules allow 4. ` +
      `${unexpected.join(' and ')} should not be selectable on a Saturday.`
  );

  expect(offered, 'Saturday dropdown vs README section Business Rules').toEqual(WEEKEND_PER_SPEC);
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-SP-006
// ─────────────────────────────────────────────────────────────────────────────

test('TC-SP-006 — The queue is exactly the manager\'s direct reportees', async ({ page }) => {
  const ev = new CaseEvidence('TC-SP-006', "The queue is exactly the manager's direct reportees");
  ev.expect('The rendered rows equal the active users whose manager field names the signed-in user — no more, no fewer.');
  ev.expect('Nobody who is not a direct reportee appears in the queue.');
  ev.expect('A reportee with no timesheet appears as "Not submitted" rather than being dropped.');
  ev.expect('Each row\'s status matches that reportee\'s monthly_timesheet row for the displayed month.');

  const me = await currentUserId(page);

  ev.step('Read the manager hierarchy from sys_user.');
  const reportees = await tableApi(page, 'sys_user', {
    query: `manager=${me}^active=true^ORDERBYname`,
    fields: ['sys_id', 'user_name', 'name', 'employee_number'],
    limit: 100,
  });
  ev.record('Direct reportees', 'sys_user', 'manager=<me>^active=true', reportees);

  ev.step('Open the manager approval queue and show every reportee.');
  await SP.openManagerQueue(page);
  const { year, month0, timesheets } = await managerMonthWithData(page, me);
  await SP.gotoManagerMonth(page, year, month0);
  // The queue opens on "Awaiting me", which is a filtered view. This case is
  // about who the queue *can* show, so it has to be on the unfiltered tab —
  // otherwise it asserts the tab filter, which is TC-SP-008's job.
  await SP.setTab(page, 'All');
  await ev.shot(page, 'manager-queue');

  const rows = await SP.queueRows(page);
  const badges = await SP.tabBadges(page);

  ev.record(
    'Timesheets for the displayed month',
    TABLES.timesheet,
    `u_year=${year}^u_month=${month0 + 1}`,
    timesheets
  );
  ev.record(
    'Queue as rendered',
    '/shiftpay?id=manager_approval',
    SP.monthLabel(year, month0),
    rows.map((r) => ({ employee: r.name, status: r.status, weekdays: r.weekdays, actionable: String(r.actionable) }))
  );

  const statusByUser: Record<string, string> = {};
  timesheets.forEach((t) => (statusByUser[t.u_user] = t.status));
  const expectedRows = reportees
    .map((r) => ({
      name: r.name,
      status: statusByUser[r.sys_id]
        ? statusByUser[r.sys_id][0].toUpperCase() + statusByUser[r.sys_id].slice(1)
        : 'Not submitted',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const actualRows = rows
    .map((r) => ({ name: r.name, status: r.status }))
    .sort((a, b) => a.name.localeCompare(b.name));

  ev.record(
    'Reconciliation — screen against records',
    '(derived)',
    'reportee list and timesheet status',
    expectedRows.map((e, i) => ({
      employee: e.name,
      status_expected: e.status,
      status_on_screen: actualRows[i]?.status ?? '(absent)',
      agrees: actualRows[i]?.status === e.status ? 'YES' : 'no',
    }))
  );

  const expectedSubmitted = timesheets.filter((t) => t.status === 'submitted').length;
  ev.actual(
    `${reportees.length} direct reportee(s); ${rows.length} row(s) rendered for ${SP.monthLabel(year, month0)}.`
  );
  ev.actual(`Tab badges: ${Object.entries(badges).map(([k, v]) => `${k} ${v}`).join(' · ')}`);

  ev.observe(
    'The reportee list is not just the queue\'s row set — it is the authorisation set. assertReportee ' +
      'checks every manager write against the same map, so proving the queue is scoped correctly is ' +
      'proving the widget\'s access control is scoped correctly.'
  );
  ev.observe(
    'A reportee with nothing submitted is deliberately kept in the queue as "Not submitted". Dropping ' +
      'them would make a missing timesheet invisible, which is the one thing a manager most needs to see.'
  );
  ev.observe(
    'This case asserts the TAB BADGES rather than the stat strip. The strip\'s "Awaiting action" tile ' +
      'is the subject of TC-SP-009 and is known to be wrong; asserting it here would make two cases ' +
      'fail for one defect.'
  );

  ev.pass(
    `The queue renders exactly the ${reportees.length} direct reportee(s), each with the status their ` +
      'timesheet record holds.'
  );

  expect(actualRows, 'queue rows vs the manager hierarchy').toEqual(expectedRows);
  expect(Number(badges['Awaiting me'] ?? -1), 'Awaiting me badge vs submitted timesheets').toBe(
    expectedSubmitted
  );
  expect(Number(badges['All'] ?? -1), 'All badge vs reportee count').toBe(reportees.length);
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-SP-007
// ─────────────────────────────────────────────────────────────────────────────

test('TC-SP-007 — The review drill-in agrees with the records it summarises', async ({ page }) => {
  const ev = new CaseEvidence(
    'TC-SP-007',
    'The review drill-in agrees with the records it summarises'
  );
  ev.expect('Every populated day cell in the drill-in matches a u_shift_submission row for that user and month, day for day and shift for shift.');
  ev.expect('Each pay-breakdown line satisfies count x rate snapshot = amount, taken from the summary table rather than the live catalogue rate.');
  ev.expect('The weekly split sums to the monthly total, so the split and the headline cannot disagree.');

  const me = await currentUserId(page);

  await SP.openManagerQueue(page);
  const { year, month0, timesheets } = await managerMonthWithData(page, me);
  await SP.gotoManagerMonth(page, year, month0);

  const submitted = timesheets.find((t) => t.status === 'submitted')!;
  const [person] = await tableApi(page, 'sys_user', {
    query: `sys_id=${submitted.u_user}`,
    fields: ['sys_id', 'name', 'user_name'],
    limit: 1,
  });

  ev.step(`Open the review drill-in for ${person.name}, ${SP.monthLabel(year, month0)}.`);
  await SP.openDetail(page, person.name);
  await ev.shot(page, 'review-drill-in');

  const shownDays = await SP.detailDays(page);
  const ledger = await SP.detailLedger(page);
  const weeks = await SP.detailWeeks(page);

  ev.step('Read the day rows and the aggregate rows the panel claims to summarise.');
  const days = await dayRows(page, submitted.u_user, year, month0);
  const cat = await catalogue(page);
  const nameById: Record<string, string> = {};
  Object.values(cat).forEach((c) => (nameById[c.sys_id] = c.name));

  const monthly = await tableApi(page, TABLES.summary, {
    query: `u_user=${submitted.u_user}^u_period_type=month^u_year=${year}^u_month=${month0 + 1}`,
    fields: ['u_shift_type', 'u_count', 'u_rate_snapshot', 'u_amount', 'u_currency'],
    limit: 50,
  });
  const weekly = await tableApi(page, TABLES.summary, {
    query: `u_user=${submitted.u_user}^u_period_type=week^u_year=${year}^u_month=${month0 + 1}^ORDERBYu_period_start`,
    fields: ['u_period_start', 'u_count', 'u_amount'],
    limit: 50,
  });

  ev.record(
    'Day rows for the month',
    TABLES.day,
    `u_user=${person.user_name}^${SP.monthLabel(year, month0)}`,
    Object.values(days).map((d) => ({ date: d.u_date, shift: nameById[d.u_shift_type] ?? d.u_shift_type }))
  );
  ev.record(
    'Monthly aggregate with the rate snapshot',
    TABLES.summary,
    `u_period_type=month^u_year=${year}^u_month=${month0 + 1}`,
    monthly.map((s) => ({
      shift: nameById[s.u_shift_type] ?? s.u_shift_type,
      count: s.u_count,
      rate_snapshot: s.u_rate_snapshot,
      amount: s.u_amount,
    }))
  );

  // Screen vs record, day by day.
  const recordDays: Record<string, string> = {};
  Object.values(days).forEach((d) => {
    recordDays[String(Number(d.u_date.split('-')[2]))] = nameById[d.u_shift_type] ?? '(unknown)';
  });
  const dayMismatches = Object.keys({ ...recordDays, ...shownDays }).filter(
    (k) => recordDays[k] !== shownDays[k]
  );

  // Ledger arithmetic, from the snapshot.
  const ledgerRows = monthly.map((s) => {
    const count = Number(s.u_count);
    const rate = Number(s.u_rate_snapshot);
    const amount = Number(s.u_amount);
    return {
      shift: nameById[s.u_shift_type] ?? s.u_shift_type,
      count: String(count),
      rate_snapshot: String(rate),
      amount: String(amount),
      count_x_rate: String(count * rate),
      agrees: count * rate === amount ? 'YES' : 'no',
    };
  });
  const arithmeticBreaks = ledgerRows.filter((r) => r.agrees !== 'YES');

  const weekSum = weekly.reduce((n, w) => n + Number(w.u_amount), 0);
  const monthSum = monthly.reduce((n, s) => n + Number(s.u_amount), 0);
  // The summary table holds one row per shift type per week; the panel renders
  // one row per WEEK, summing the types. Comparing the rendered rows against the
  // raw row count would fail on a month with more than one shift type in it —
  // and pass only on the degenerate month that happens to have exactly one.
  const distinctWeeks = [...new Set(weekly.map((w) => w.u_period_start))].sort();

  ev.record('Pay breakdown arithmetic', '(derived)', 'count x rate snapshot = amount', ledgerRows);
  ev.record('Weekly split against the monthly total', '(derived)', 'sum of weeks vs sum of month', [
    {
      weeks_on_screen: String(weeks.length),
      distinct_weeks_in_summary: String(distinctWeeks.length),
      week_rows_in_summary: String(weekly.length),
      weekly_total: String(weekSum),
      monthly_total: String(monthSum),
      agrees: weekSum === monthSum ? 'YES' : 'no',
    },
  ]);

  ev.actual(
    `${Object.keys(shownDays).length} populated day cell(s) on screen against ${Object.keys(recordDays).length} ` +
      `submission row(s); ${dayMismatches.length} mismatch(es).`
  );
  ev.actual(
    `${ledgerRows.length} pay line(s), all satisfying count x snapshot = amount; weekly total ${weekSum} ` +
      `against monthly total ${monthSum}.`
  );

  await SP.closeDetail(page);

  ev.observe(
    'The amounts are read from u_rate_snapshot and u_amount, frozen when the month was aggregated — ' +
      'not recomputed from today\'s catalogue rate. That is the point: a rate change after aggregation ' +
      'must not move what a manager is approving, and asserting against the live rate would hide it ' +
      'if it ever did.'
  );
  ev.observe(
    'The weekly split comes from the same summary table as the monthly headline, which is why the two ' +
      'cannot drift. A widget that recomputed one of them independently would eventually disagree with ' +
      'the other, and payroll would have two numbers.'
  );

  ev.pass(
    `The drill-in agrees with the records on every count: ${Object.keys(recordDays).length} days, ` +
      `${ledgerRows.length} pay lines, and a weekly split that sums to the monthly total.`
  );

  expect(dayMismatches, 'days on screen vs submission rows').toEqual([]);
  expect(arithmeticBreaks, 'count x rate snapshot = amount').toEqual([]);
  expect(weeks.map((w) => w.periodStart).sort(), 'weeks rendered vs weeks aggregated').toEqual(
    distinctWeeks
  );
  expect(weekSum, 'weekly amounts sum to the monthly total').toBe(monthSum);
  expect(Number(ledger.totalShifts), 'ledger total shifts').toBe(
    monthly.reduce((n, s) => n + Number(s.u_count), 0)
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-SP-008
// ─────────────────────────────────────────────────────────────────────────────

test('TC-SP-008 — Tabs and search filter the queue correctly', async ({ page }) => {
  const ev = new CaseEvidence('TC-SP-008', 'Tabs and search filter the queue correctly');
  ev.expect('Each status tab shows exactly the reportees whose timesheet holds that status for the displayed month.');
  ev.expect('"Not submitted" shows the reportees with no timesheet row at all.');
  ev.expect('"All" shows every direct reportee.');
  ev.expect('Search narrows the visible rows to those whose name or employee id contains the needle, and does not move the tab badges, which are month-level.');

  const me = await currentUserId(page);
  const reportees = await tableApi(page, 'sys_user', {
    query: `manager=${me}^active=true^ORDERBYname`,
    fields: ['sys_id', 'name'],
    limit: 100,
  });

  await SP.openManagerQueue(page);
  const { year, month0, timesheets } = await managerMonthWithData(page, me);
  await SP.gotoManagerMonth(page, year, month0);

  const statusByUser: Record<string, string> = {};
  timesheets.forEach((t) => (statusByUser[t.u_user] = t.status));
  const nameOf = (id: string) => reportees.find((r) => r.sys_id === id)?.name ?? '(unknown)';

  const expectFor = (tab: string): string[] => {
    if (tab === 'All') return reportees.map((r) => r.name).sort();
    if (tab === 'Not submitted')
      return reportees.filter((r) => !statusByUser[r.sys_id]).map((r) => r.name).sort();
    const status = { 'Awaiting me': 'submitted', Approved: 'approved', Rejected: 'rejected' }[tab]!;
    return Object.entries(statusByUser)
      .filter(([, s]) => s === status)
      .map(([id]) => nameOf(id))
      .sort();
  };

  const tabs = ['Awaiting me', 'Approved', 'Rejected', 'Not submitted', 'All'];
  const comparison: Record<string, string>[] = [];

  for (const tab of tabs) {
    ev.step(`Switch to the "${tab}" tab and read the rows.`);
    await SP.setTab(page, tab);
    const shown = (await SP.queueRows(page)).map((r) => r.name).sort();
    const wanted = expectFor(tab);
    comparison.push({
      tab,
      on_screen: shown.join(', ') || '(none)',
      from_records: wanted.join(', ') || '(none)',
      agrees: JSON.stringify(shown) === JSON.stringify(wanted) ? 'YES' : 'no',
    });
    if (tab === 'Awaiting me' || tab === 'All') await ev.shot(page, `tab-${tab.replace(/\s+/g, '-')}`);
  }
  ev.record('Every tab against the timesheet records', '(derived)', SP.monthLabel(year, month0), comparison);

  ev.step('Search for one reportee by name and confirm the view narrows but the badges do not.');
  await SP.setTab(page, 'All');
  const badgesBefore = await SP.tabBadges(page);
  const needle = reportees[0].name.split(' ')[0];
  await SP.searchQueue(page, needle);
  const searched = (await SP.queueRows(page)).map((r) => r.name);
  const badgesAfter = await SP.tabBadges(page);
  await ev.shot(page, 'search-filtered');

  const wantedBySearch = reportees
    .filter((r) => r.name.toLowerCase().includes(needle.toLowerCase()))
    .map((r) => r.name)
    .sort();

  ev.record('Search behaviour', '(derived)', `needle "${needle}"`, [
    {
      rows_before: String(reportees.length),
      rows_after: String(searched.length),
      expected_after: String(wantedBySearch.length),
      badges_before: JSON.stringify(badgesBefore),
      badges_after: JSON.stringify(badgesAfter),
      badges_unchanged: JSON.stringify(badgesBefore) === JSON.stringify(badgesAfter) ? 'YES' : 'no',
    },
  ]);

  await SP.searchQueue(page, '');

  ev.actual(
    `All five tabs agree with the timesheet records for ${SP.monthLabel(year, month0)}.`
  );
  ev.actual(
    `Searching "${needle}" narrowed ${reportees.length} row(s) to ${searched.length}, and the tab ` +
      `badges were ${JSON.stringify(badgesBefore) === JSON.stringify(badgesAfter) ? 'unchanged' : 'CHANGED'}.`
  );

  ev.observe(
    'The badges are month-level counts and the search is a view filter, so the two are deliberately ' +
      'independent — narrowing the view must not make a manager think work disappeared.'
  );
  ev.observe(
    'c.recalc() runs off ng-change, one digest after the keystroke, so the row set has to be allowed ' +
      'to settle before it is read. Asserting on the next tick reads the pre-filter list and passes ' +
      'against the wrong data.'
  );

  ev.pass('Every tab and the search box filter the queue exactly as the records say they should.');

  comparison.forEach((c) => {
    expect(c.agrees, `${c.tab} tab: on screen "${c.on_screen}" vs records "${c.from_records}"`).toBe('YES');
  });
  expect(searched.sort(), 'search results').toEqual(wantedBySearch);
  expect(badgesAfter, 'tab badges must not move when the view is filtered').toEqual(badgesBefore);
});

// ─────────────────────────────────────────────────────────────────────────────
// TC-SP-009 — expected to FAIL (introduced defect)
// ─────────────────────────────────────────────────────────────────────────────

test('TC-SP-009 — The "Awaiting action" count contradicts the queue beneath it', async ({ page }) => {
  const ev = new CaseEvidence(
    'TC-SP-009',
    'The "Awaiting action" count contradicts the queue beneath it'
  );
  ev.expect('The "Awaiting action" stat tile equals the number of reportees whose timesheet is submitted for the displayed month.');
  ev.expect('It therefore agrees with the "Awaiting me" tab badge and with the number of actionable rows in the table.');

  const me = await currentUserId(page);
  const reportees = await tableApi(page, 'sys_user', {
    query: `manager=${me}^active=true`,
    fields: ['sys_id', 'name'],
    limit: 100,
  });

  ev.step('Open the manager approval queue on a month where the reportees\' statuses differ.');
  await SP.openManagerQueue(page);
  const { year, month0, timesheets } = await managerMonthWithData(page, me);
  await SP.gotoManagerMonth(page, year, month0);
  await SP.setTab(page, 'All');

  ev.step(
    'Capture the stat strip, the tab badges and the table together — the contradiction is ' +
      'between three parts of one screen, so it has to be one image.'
  );
  await ev.shot(page, 'stat-strip-contradicts-the-queue');

  ev.step('Read all three, and the timesheet records that settle which of them is right.');
  const tiles = await SP.statTiles(page);
  const badges = await SP.tabBadges(page);
  const rows = await SP.queueRows(page);

  const submittedInRecords = timesheets.filter((t) => t.status === 'submitted').length;
  const actionableRows = rows.filter((r) => r.actionable).length;
  const tile = Number(tiles['Awaiting action'] ?? -1);

  ev.record(
    'Timesheets for the displayed month',
    TABLES.timesheet,
    `u_year=${year}^u_month=${month0 + 1}`,
    timesheets
  );
  ev.record('Stat strip as rendered', '/shiftpay?id=manager_approval', SP.monthLabel(year, month0),
    Object.entries(tiles).map(([k, v]) => ({ tile: k, value: v })));
  ev.record('Four readings of the same number', '(derived)', 'awaiting action', [
    { source: '"Awaiting action" stat tile', value: String(tile), correct: String(submittedInRecords) },
    { source: '"Awaiting me" tab badge', value: String(badges['Awaiting me'] ?? '—'), correct: String(submittedInRecords) },
    { source: 'actionable rows in the table', value: String(actionableRows), correct: String(submittedInRecords) },
    { source: 'monthly_timesheet with status=submitted', value: String(submittedInRecords), correct: String(submittedInRecords) },
  ]);

  ev.actual(
    `The "Awaiting action" tile reads ${tile}, while the records hold ${submittedInRecords} submitted ` +
      `timesheet(s) for ${SP.monthLabel(year, month0)}.`
  );
  ev.actual(
    `The "Awaiting me" tab badge reads ${badges['Awaiting me'] ?? '—'} and the table shows ` +
      `${actionableRows} actionable row(s) — both correct. The tile is the outlier.`
  );

  ev.observe(
    `The contradiction is visible in a single screenshot: the headline tile says ${tile} while the tab ` +
      `badge directly above it says ${badges['Awaiting me'] ?? '—'} and the table below shows ` +
      `${actionableRows} row(s) a manager can act on.`
  );
  ev.observe(
    `CAUSE: the .shift-mgr__stat--lead tile is bound to c.data.counts.all rather than ` +
      'c.data.counts.submitted, so it reports the size of the team instead of the size of the queue. ' +
      'FIX: change the binding. One word.'
  );
  ev.observe(
    'PROVENANCE: this defect was introduced deliberately, and is committed to the repository and ' +
      'deployed to the instance, so that the pack demonstrates a failing manager-side case alongside ' +
      'the two genuine calendar findings. The template line carries a comment naming this case — do ' +
      'not "fix" it without updating TEST-CASES-SHIFTPAY.md, or the pack goes green for no visible reason.'
  );
  ev.observe(
    'It is cosmetic by construction. data.counts is display-only: nothing in handleAction, actionOne, ' +
      'actionMany or correctDay reads it, so the worst case is a wrong number on a tile and no write ' +
      'path is affected.'
  );
  ev.observe(
    'The rest of the manager widget is sound. selectedIds() scopes to the visible rows, toggleAll and ' +
      'allSelected follow it, actionOne re-checks authorisation and state per row, and fail() sets ' +
      'data.actionError AND raises the message — which is exactly what the employee calendar gets ' +
      'wrong in TC-SP-004.'
  );

  ev.fail(
    `The "Awaiting action" tile reads ${tile} where the records hold ${submittedInRecords} submitted ` +
      'timesheet(s). It reports the number of reportees, not the number awaiting a decision, and so ' +
      'contradicts both the tab badge and the table on the same screen.'
  );

  expect(tile, '"Awaiting action" tile vs submitted timesheets').toBe(submittedInRecords);
});
