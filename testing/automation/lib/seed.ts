import { Page } from '@playwright/test';
import { TABLES, tableApi, currentUserId } from './servicenow';

/**
 * Bulk fixture seeding for the performance smoke.
 *
 * Everything here goes through the Table API, never through the widget. A test
 * that has to click its own fixtures into place is slow, fails for the wrong
 * reason, and gets ignored inside a month — which makes it worse than no test.
 *
 * The same constraint as the rest of the pack applies and is not negotiable:
 * writes touch only the signed-in account's own calendar, only in months the
 * pack owns, and every seed is reversed by its own teardown. Nothing here
 * submits a month, and nothing here approves, rejects or corrects one.
 *
 * Months are 0-indexed on the wire and 1-indexed in the stored u_month column,
 * exactly as everywhere else in this application. The conversion happens in
 * `monthKey` and nowhere else in this file.
 */

/** Sys_ids created by a seed run, in insertion order, for teardown. */
export interface SeedHandle {
  table: string;
  sysIds: string[];
}

const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);

/** 'YYYY-MM-DD' from a 0-indexed month, the wire format used across the app. */
export function dateKey(year: number, month0: number, day: number): string {
  return `${year}-${pad(month0 + 1)}-${pad(day)}`;
}

/** The 1-indexed month the lock and summary tables store. */
export function monthKey(month0: number): number {
  return month0 + 1;
}

function daysInMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

/**
 * Seed one shift per weekday for `months` consecutive months ending at the
 * month before `endYear`/`endMonth0`, so the calendar has real history behind
 * it when the smoke opens a month.
 *
 * Weekends are skipped rather than filled: the point is a realistic volume of
 * rows, and a weekend row would need a shift type the rules may not allow on
 * that date, which turns a performance fixture into a rules argument.
 */
export async function seedHistory(
  page: Page,
  opts: {
    endYear: number;
    endMonth0: number;
    months: number;
    shiftTypeId: string;
  },
): Promise<SeedHandle> {
  const userId = await currentUserId(page);
  const sysIds: string[] = [];

  for (let back = opts.months; back >= 1; back--) {
    const anchor = new Date(opts.endYear, opts.endMonth0 - back, 1);
    const year = anchor.getFullYear();
    const month0 = anchor.getMonth();

    for (let day = 1; day <= daysInMonth(year, month0); day++) {
      const weekday = new Date(year, month0, day).getDay();
      if (weekday === 0 || weekday === 6) continue;

      const created = await tableApi(page, 'POST', TABLES.submission, {
        u_user: userId,
        u_date: dateKey(year, month0, day),
        u_shift_type: opts.shiftTypeId,
      });
      sysIds.push(created.sys_id);
    }
  }

  return { table: TABLES.submission, sysIds };
}

/**
 * Remove everything a seed created.
 *
 * Deletes in reverse insertion order and keeps going after a failure, so one
 * row that has already gone cannot strand the rest. A seed that half-cleans up
 * poisons every later run on the instance, which is the failure mode worth
 * spending the extra loop on.
 */
export async function teardown(page: Page, handle: SeedHandle): Promise<number> {
  let removed = 0;
  for (const sysId of [...handle.sysIds].reverse()) {
    try {
      await tableApi(page, 'DELETE', `${handle.table}/${sysId}`);
      removed++;
    } catch {
      // Already gone, or never created. Neither is worth failing teardown over.
    }
  }
  return removed;
}
