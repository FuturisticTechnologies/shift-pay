import { Page, Locator, expect } from '@playwright/test';
import { PAGES } from '../playwright.config';
import { openPortal } from './servicenow';

/**
 * The ShiftPay Service Portal surface, as Playwright sees it.
 *
 * Both widgets are AngularJS 1.x rendering into ordinary DOM — no shadow roots,
 * no iframes — so plain CSS selectors reach everything. What does bite is
 * timing: Angular bootstraps well after DOMContentLoaded and then fetches the
 * month in a second server call, so every entry point here waits on rendered
 * content rather than on a fixed delay.
 *
 * Class names are BEM-light and namespaced `shift-` (calendar) or `shift-mgr__`
 * (manager approval).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Dates. Everything crosses the wire as 'YYYY-MM-DD' and is compared lexically,
// matching the server. These helpers mirror the server's arithmetic rather than
// reading it back, so a case can assert an independently computed answer.
// ─────────────────────────────────────────────────────────────────────────────

export function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function isoDate(y: number, m0: number, d: number): string {
  return `${y}-${pad(m0 + 1)}-${pad(d)}`;
}

export function daysInMonth(y: number, m0: number): number {
  return new Date(y, m0 + 1, 0).getDate();
}

export function isWeekend(key: string): boolean {
  const [y, m, d] = key.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return dow === 0 || dow === 6;
}

/** Monday of the week containing `key`, as the aggregator computes it. */
export function mondayOf(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const shift = (dt.getDay() + 6) % 7; // Mon = 0
  dt.setDate(dt.getDate() - shift);
  return isoDate(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

/**
 * The date `n` weekdays after `key`, skipping Saturdays and Sundays.
 *
 * Deliberately a reimplementation of `ShiftPayEntitlements._nthWeekdayAfter`
 * rather than a read of `u_oc_window_end`: a case that reads the value it is
 * meant to be checking asserts nothing.
 */
export function nthWeekdayAfter(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  let count = 0;
  while (count < n) {
    dt.setDate(dt.getDate() + 1);
    const dow = dt.getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return isoDate(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function monthLabel(y: number, m0: number): string {
  return `${MONTH_NAMES[m0]} ${y}`;
}

/** Every weekday of the month, as 'YYYY-MM-DD'. */
export function weekdaysOf(y: number, m0: number): string[] {
  const out: string[] = [];
  for (let d = 1; d <= daysInMonth(y, m0); d++) {
    const key = isoDate(y, m0, d);
    if (!isWeekend(key)) out.push(key);
  }
  return out;
}

/** Every Saturday of the month, as 'YYYY-MM-DD'. */
export function saturdaysOf(y: number, m0: number): string[] {
  const out: string[] = [];
  for (let d = 1; d <= daysInMonth(y, m0); d++) {
    const [yy, mm, dd] = [y, m0, d];
    if (new Date(yy, mm, dd).getDay() === 6) out.push(isoDate(y, m0, d));
  }
  return out;
}

/** Day-of-month from a 'YYYY-MM-DD' key. */
export function dayOf(key: string): number {
  return Number(key.split('-')[2]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Employee calendar
// ─────────────────────────────────────────────────────────────────────────────

export const CAL = {
  widget: '.shift-widget',
  grid: '.shift-cal__grid',
  cell: '.shift-cal__grid .shift-cell',
  popover: '.shift-popover',
  popoverError: '.shift-popover__error',
  dropdownTrigger: '.shift-dropdown__trigger',
  dropdownList: '.shift-dropdown__list',
  dropdownItem: '.shift-dropdown__item',
  monthLabel: '.shift-widget__monthlabel',
  legendBtn: '.shift-legend-btn',
  legendPanel: '.shift-legend-panel',
  configError: '.shift-widget__configerror',
  locked: '.shift-widget__locked',
  submit: '.shift-widget__submit',
  status: '.shift-widget__status',
} as const;

/**
 * Open the calendar and wait for it to be usable.
 *
 * The grid renders from `data.entries`, which arrives with the first server
 * response, so waiting on a cell is waiting on real data rather than on the
 * Angular shell.
 */
export async function openCalendar(page: Page): Promise<void> {
  await openPortal(page, PAGES.calendar);
  await page.locator(CAL.cell).first().waitFor({ state: 'visible', timeout: 60_000 });
}

/** Which month the calendar is currently showing, as [year, month0]. */
export async function currentMonth(page: Page): Promise<[number, number]> {
  const label = (await page.locator(CAL.monthLabel).innerText()).trim();
  const [name, year] = label.split(/\s+/);
  const m0 = MONTH_NAMES.indexOf(name);
  expect(m0, `Unrecognised month label "${label}"`).toBeGreaterThanOrEqual(0);
  return [Number(year), m0];
}

/**
 * Navigate to a specific month by clicking the chevrons.
 *
 * Each click fires a `loadMonth` server call, so the loop waits for the label to
 * actually change before deciding where it is — clicking blind and asserting at
 * the end turns one slow response into a wrong-month failure.
 */
export async function gotoMonth(page: Page, y: number, m0: number): Promise<void> {
  const target = monthLabel(y, m0);
  for (let guard = 0; guard < 24; guard++) {
    const [cy, cm] = await currentMonth(page);
    if (cy === y && cm === m0) return;
    const delta = (y - cy) * 12 + (m0 - cm);
    const label = delta > 0 ? 'Next month' : 'Previous month';
    const before = monthLabel(cy, cm);
    await page.getByLabel(label).click();
    await expect(page.locator(CAL.monthLabel)).not.toHaveText(before, { timeout: 30_000 });
  }
  throw new Error(`Could not reach ${target} — still on ${await page.locator(CAL.monthLabel).innerText()}`);
}

/**
 * The cell for one day of the displayed month.
 *
 * Cells are `<button>` elements keyed by `cell.idx`, not by date, and the
 * leading/trailing padding cells carry day numbers too — so this matches on an
 * exact date string within a cell that is not `--outside`. Never index
 * positionally.
 */
export function cellForDay(page: Page, day: number): Locator {
  return page
    .locator(`${CAL.cell}:not(.shift-cell--outside)`)
    .filter({ has: page.locator('.shift-cell__date', { hasText: new RegExp(`^${day}$`) }) })
    .first();
}

export function cellForDate(page: Page, key: string): Locator {
  return cellForDay(page, dayOf(key));
}

/** Open the single-day popover for a date in the displayed month. */
export async function openDay(page: Page, key: string): Promise<void> {
  await cellForDate(page, key).click();
  await page.locator(CAL.popover).waitFor({ state: 'visible', timeout: 30_000 });
}

export async function closePopover(page: Page): Promise<void> {
  const popover = page.locator(CAL.popover);
  if (await popover.isVisible().catch(() => false)) {
    await popover.getByLabel('Close').click();
    await popover.waitFor({ state: 'hidden', timeout: 15_000 });
  }
}

/**
 * The shift types offered in the open popover, grouped as the user sees them.
 *
 * Returns `[{ heading, items: [{ short, label }] }]`. The grouping matters:
 * headings come from `day_category`, which is independent of the `allow_*`
 * columns that decide availability, so the two can disagree — and that
 * disagreement is one of the recorded findings.
 */
export async function dropdownGroups(
  page: Page
): Promise<{ heading: string; items: { short: string; label: string }[] }[]> {
  const trigger = page.locator(CAL.dropdownTrigger);
  if (!(await page.locator(CAL.dropdownList).isVisible().catch(() => false))) {
    await trigger.click();
  }
  await page.locator(CAL.dropdownList).waitFor({ state: 'visible', timeout: 15_000 });

  return page.locator(CAL.dropdownList).evaluate((list) =>
    Array.from(list.children).map((group) => ({
      heading:
        (group.querySelector('.shift-dropdown__group-heading') as HTMLElement | null)
          ?.innerText.trim() ?? '',
      items: Array.from(group.querySelectorAll('.shift-dropdown__item')).map((it) => ({
        short:
          (it.querySelector('.shift-dropdown__item-chip') as HTMLElement | null)
            ?.innerText.trim() ?? '',
        label:
          (it.querySelector('.shift-dropdown__item-label') as HTMLElement | null)
            ?.innerText.trim() ?? '',
      })),
    }))
  );
}

/** Flat list of the shift codes offered in the open popover, e.g. ['UK','US','L']. */
export async function dropdownShiftCodes(page: Page): Promise<string[]> {
  const groups = await dropdownGroups(page);
  return groups.flatMap((g) => g.items.map((i) => i.short));
}

/** Choose a shift by its catalogue `name` (the chip text), e.g. 'UK' or 'OC + CO'. */
export async function selectShift(page: Page, code: string): Promise<void> {
  await dropdownGroups(page); // ensures the list is open
  await page
    .locator(CAL.dropdownItem)
    .filter({ has: page.locator('.shift-dropdown__item-chip', { hasText: new RegExp(`^${escapeRe(code)}$`) }) })
    .first()
    .click();
  await expect(page.locator(CAL.dropdownList)).toBeHidden({ timeout: 15_000 });
}

/**
 * Save the open popover.
 *
 * Completion is "the popover closed", which is what `c.saveCell` does on the
 * success path. NOTE it also closes on a *refused* save, because the client
 * branches on `r.data.error` and the server never sets it — that is finding
 * TC-SP-004, and it is why no helper here treats a closed popover as proof the
 * write landed. Always confirm against the record.
 */
export async function saveDay(page: Page, comment?: string): Promise<void> {
  if (comment !== undefined) {
    await page.locator('.shift-popover__textarea').fill(comment);
  }
  await page.locator(CAL.popover).getByRole('button', { name: 'Save' }).click();
  await page.locator(CAL.popover).waitFor({ state: 'hidden', timeout: 60_000 });
}

/** Clear the day the open popover is showing. Same caveat as `saveDay`. */
export async function clearDay(page: Page): Promise<void> {
  await page.locator(CAL.popover).getByRole('button', { name: 'Clear' }).click();
  await page.locator(CAL.popover).waitFor({ state: 'hidden', timeout: 60_000 });
}

/** The shift chip currently rendered on a day cell, or '' when the day is empty. */
export async function chipOn(page: Page, key: string): Promise<string> {
  const chip = cellForDate(page, key).locator('.shift-cell__chip');
  if (!(await chip.count())) return '';
  return (await chip.innerText()).trim();
}

/** Open the legend panel and read its groups. */
export async function legendGroups(
  page: Page
): Promise<{ heading: string; items: string[] }[]> {
  if (!(await page.locator(CAL.legendPanel).isVisible().catch(() => false))) {
    await page.locator(CAL.legendBtn).click();
  }
  await page.locator(CAL.legendPanel).waitFor({ state: 'visible', timeout: 15_000 });
  return page.locator(CAL.legendPanel).evaluate((panel) =>
    Array.from(panel.children).map((group) => ({
      heading:
        (group.querySelector('.shift-legend-panel__heading') as HTMLElement | null)
          ?.innerText.trim() ?? '',
      items: Array.from(group.querySelectorAll('.shift-legend-panel__chip')).map((c) =>
        (c as HTMLElement).innerText.trim()
      ),
    }))
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Manager approval
// ─────────────────────────────────────────────────────────────────────────────

export const MGR = {
  widget: '.shift-mgr',
  error: '.shift-mgr__error',
  empty: '.shift-mgr__empty',
  tab: '.shift-mgr__tab',
  tabCount: '.shift-mgr__tabcount',
  strip: '.shift-mgr__strip',
  stat: '.shift-mgr__stat',
  search: '.shift-mgr__search input',
  tableWrap: '.shift-mgr__tablewrap',
  monthLabel: '.shift-mgr__monthlabel',
  panel: '.shift-mgr__panel',
  panelCal: '.shift-mgr__cal',
  panelDay: '.shift-mgr__cal .shift-mgr__day',
  coverage: '.shift-mgr__coverage',
  ledger: '.shift-mgr__ledger',
} as const;

export interface QueueRow {
  name: string;
  employeeId: string;
  mix: { code: string; count: string }[];
  weekdays: string;
  pay: string;
  status: string;
  actionable: boolean;
}

/*
 * A note that governs every scraper below: read `textContent`, never `innerText`.
 *
 * `widget.styles.scss` applies `text-transform: uppercase` in seven places —
 * status pills, stat labels, tab labels, chips. `innerText` returns the
 * *rendered* text, so it hands back "SUBMITTED" where the DOM holds "Submitted",
 * and a comparison against a record value then fails on case alone. Worse, a
 * lookup keyed on a label — `tiles['Awaiting action']` — quietly returns
 * undefined and the case reports a number nobody rendered.
 *
 * Each evaluate defines its own `txt()` because the callback is serialised into
 * the page and cannot close over anything here.
 */

/** Open the manager queue and wait for it to settle. */
export async function openManagerQueue(page: Page): Promise<void> {
  await openPortal(page, PAGES.manager);
  await page.locator(MGR.widget).waitFor({ state: 'visible', timeout: 60_000 });
  // Either the queue table or the "Nobody reports to you" empty state — waiting
  // only for the table would hang forever on an account with no reportees and
  // read as a rendering bug.
  await page
    .locator(`${MGR.tableWrap}, ${MGR.empty}`)
    .first()
    .waitFor({ state: 'visible', timeout: 60_000 });
}

/**
 * Scrape the visible queue rows.
 *
 * Scoped to the *visible* table wrap: the queue and the History tab render two
 * different tables under the same class, and only one is in the DOM at a time —
 * but scoping by visibility means a future change that renders both cannot
 * silently point this at the wrong one.
 */
export async function queueRows(page: Page): Promise<QueueRow[]> {
  const wrap = page.locator(MGR.tableWrap).filter({ visible: true }).first();
  const empty = await wrap.locator('.shift-mgr__norows').count();
  if (empty) return [];

  return wrap.locator('tbody tr').evaluateAll((trs) => {
    const txt = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return trs
      .filter((tr) => !tr.querySelector('.shift-mgr__norows'))
      .map((tr) => {
        const text = (sel: string) => txt(tr.querySelector(sel));
        const nums = Array.from(tr.querySelectorAll('.shift-mgr__num')).map(txt);

        // The pill wraps a decorative glyph span alongside the label, so its own
        // text is "● Submitted". Subtract the glyph rather than splitting on
        // whitespace — a two-word status would lose half of itself.
        const pill = tr.querySelector('.shift-mgr__pill');
        const glyph = txt(pill?.querySelector('.shift-mgr__pillglyph') ?? null);
        const status = txt(pill).replace(glyph, '').trim();

        return {
          name: text('.shift-mgr__nm'),
          employeeId: text('.shift-mgr__id'),
          mix: Array.from(tr.querySelectorAll('.shift-mgr__chipset')).map((cs) => ({
            code: txt(cs.querySelector('.shift-mgr__chip')),
            count: txt(cs.querySelector('.shift-mgr__chipn')),
          })),
          // Weekdays is always the first numeric cell; Total pay, when shown, is
          // the second. Reading by position within the numeric cells rather than
          // by column index keeps this correct when show_pay_amounts is off.
          weekdays: nums[0] ?? '',
          pay: nums[1] ?? '',
          status,
          actionable: !!tr.querySelector('input[type="checkbox"]'),
        };
      });
  });
}

/** The stat strip as { label: value }, e.g. { 'Awaiting action': '3' }. */
export async function statTiles(page: Page): Promise<Record<string, string>> {
  return page.locator(MGR.strip).evaluate((strip) => {
    const txt = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const out: Record<string, string> = {};
    strip.querySelectorAll('.shift-mgr__stat').forEach((s) => {
      const k = txt(s.querySelector('.shift-mgr__statk'));
      if (k) out[k] = txt(s.querySelector('.shift-mgr__statv'));
    });
    return out;
  });
}

/** The tab strip as { label: badgeCount }; a tab with no badge maps to ''. */
export async function tabBadges(page: Page): Promise<Record<string, string>> {
  return page.locator(MGR.widget).evaluate((w) => {
    const txt = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const out: Record<string, string> = {};
    w.querySelectorAll('.shift-mgr__tab').forEach((t) => {
      const badge = t.querySelector('.shift-mgr__tabcount');
      const count = txt(badge);
      // The badge is nested inside the tab, so the tab's own text is
      // "Awaiting me 1". Strip the badge's text from the end rather than
      // globally — a tab labelled with a digit would otherwise lose it.
      const label = txt(t).replace(new RegExp(`\\s*${count}\\s*$`), '').trim();
      out[label] = count;
    });
    return out;
  });
}

/** Switch tabs and wait for the row set to settle. */
export async function setTab(page: Page, label: string): Promise<void> {
  await page.locator(MGR.tab).filter({ hasText: label }).first().click();
  await expect(
    page.locator(MGR.tab).filter({ hasText: label }).first()
  ).toHaveClass(/shift-mgr__tab--on/, { timeout: 30_000 });
  await settleRows(page);
}

/**
 * Type into the search box and wait for the filter to land.
 *
 * `c.recalc()` runs off `ng-change`, so the row set updates a digest later than
 * the keystroke. Asserting on the next tick reads the pre-filter list — and in
 * TC-SP-008 and TC-SP-009 the row count *is* the assertion.
 */
export async function searchQueue(page: Page, needle: string): Promise<void> {
  await page.locator(MGR.search).fill(needle);
  await settleRows(page);
}

/** Which month the manager queue is showing, as [year, month0]. */
export async function managerMonth(page: Page): Promise<[number, number]> {
  const label = (await page.locator(MGR.monthLabel).innerText()).trim();
  const [name, year] = label.split(/\s+/);
  const m0 = MONTH_NAMES.indexOf(name);
  expect(m0, `Unrecognised month label "${label}"`).toBeGreaterThanOrEqual(0);
  return [Number(year), m0];
}

/** Navigate the manager queue to a specific month. */
export async function gotoManagerMonth(page: Page, y: number, m0: number): Promise<void> {
  for (let guard = 0; guard < 36; guard++) {
    const [cy, cm] = await managerMonth(page);
    if (cy === y && cm === m0) return;
    const delta = (y - cy) * 12 + (m0 - cm);
    const before = monthLabel(cy, cm);
    await page.getByLabel(delta > 0 ? 'Next month' : 'Previous month').click();
    await expect(page.locator(MGR.monthLabel)).not.toHaveText(before, { timeout: 30_000 });
    await settleRows(page);
  }
  throw new Error(`Could not reach ${monthLabel(y, m0)} in the manager queue`);
}

/** Open the review drill-in for a named reportee. */
export async function openDetail(page: Page, name: string): Promise<void> {
  const wrap = page.locator(MGR.tableWrap).filter({ visible: true }).first();
  await wrap
    .locator('tbody tr')
    .filter({ has: page.locator('.shift-mgr__nm', { hasText: name }) })
    .first()
    .getByRole('button', { name: 'Review' })
    .click();
  await page.locator(MGR.panel).waitFor({ state: 'visible', timeout: 30_000 });
  // The ledger arrives with the same response as the panel, but the grid is
  // rebuilt client-side from it — wait for a rendered day rather than the shell.
  await page.locator(MGR.panelDay).first().waitFor({ state: 'visible', timeout: 30_000 });
}

export async function closeDetail(page: Page): Promise<void> {
  await page.locator(MGR.panel).getByRole('button', { name: 'Close' }).click();
  await page.locator(MGR.panel).waitFor({ state: 'hidden', timeout: 15_000 });
}

/**
 * The drill-in day grid as { day-of-month: shift name }, in-month days only.
 *
 * Keyed by day number rather than by date because that is all the cell renders;
 * the caller knows which month it asked for.
 */
export async function detailDays(page: Page): Promise<Record<string, string>> {
  return page.locator(MGR.panelCal).evaluate((cal) => {
    const txt = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const out: Record<string, string> = {};
    cal.querySelectorAll('.shift-mgr__day').forEach((d) => {
      if (d.classList.contains('shift-mgr__day--out')) return;
      const num = txt(d.querySelector('.shift-mgr__daynum'));
      const shift = txt(d.querySelector('.shift-mgr__dayshift'));
      if (num && shift) out[num] = shift;
    });
    return out;
  });
}

export interface LedgerLine {
  name: string;
  count: string;
  rate: string;
  amount: string;
}

/** The pay breakdown, excluding the Total row (returned separately). */
export async function detailLedger(
  page: Page
): Promise<{ lines: LedgerLine[]; totalShifts: string; totalAmount: string }> {
  return page.locator(MGR.panel).evaluate((panel) => {
    const txt = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const table = panel.querySelector('.shift-mgr__ledger');
    const lines: { name: string; count: string; rate: string; amount: string }[] = [];
    let totalShifts = '';
    let totalAmount = '';
    table?.querySelectorAll('tbody tr').forEach((tr) => {
      const nums = Array.from(tr.querySelectorAll('.shift-mgr__num')).map(txt);
      if (tr.classList.contains('shift-mgr__ledgertotal')) {
        totalShifts = nums[0] ?? '';
        totalAmount = nums[nums.length - 1] ?? '';
        return;
      }
      const chip = tr.querySelector('.shift-mgr__chip');
      if (!chip) return; // the "Nothing aggregated" row
      lines.push({
        name: txt(chip),
        count: nums[0] ?? '',
        rate: nums[1] ?? '',
        amount: nums[nums.length - 1] ?? '',
      });
    });
    return { lines, totalShifts, totalAmount };
  });
}

/** The weekly split — the second ledger table in the panel. */
export async function detailWeeks(
  page: Page
): Promise<{ periodStart: string; count: string; amount: string }[]> {
  return page.locator(MGR.panel).evaluate((panel) => {
    const txt = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const tables = panel.querySelectorAll('.shift-mgr__ledger');
    const weeks = tables[1];
    if (!weeks) return [];
    return Array.from(weeks.querySelectorAll('tbody tr')).map((tr) => {
      const nums = Array.from(tr.querySelectorAll('.shift-mgr__num')).map(txt);
      return {
        periodStart: txt(tr.querySelector('td')).replace(/^Week of\s*/i, ''),
        count: nums[0] ?? '',
        amount: nums[1] ?? '',
      };
    });
  });
}

/** Wait until the visible row count stops changing. */
async function settleRows(page: Page): Promise<void> {
  const wrap = page.locator(MGR.tableWrap).filter({ visible: true }).first();
  let last = -1;
  for (let i = 0; i < 20; i++) {
    const n = await wrap.locator('tbody tr').count();
    if (n === last) return;
    last = n;
    await page.waitForTimeout(150);
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
