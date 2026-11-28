import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadScriptInclude } from './load-script-include.mjs';
import { fakeGlide } from './fake-glide.mjs';

/**
 * Run the Employee Calendar server script, offline.
 *
 *   const { data, errors, tables } = runCalendarServer({ input, user, seed });
 *
 * The widget's server script is one IIFE that reads `input`, `options` and
 * `gs`, writes `data`, and dispatches writes through handleAction. It is run
 * here byte for byte, against the same Script Includes the instance loads, with
 * an in-memory GlideRecord behind it. `gs.addErrorMessage` is captured into
 * `errors`, which is the exact channel the user sees a refusal on.
 *
 * Table names are the widget's own defaults, so `seed` is keyed by short name:
 *   day   the per-day submission rows
 *   lock  the monthly timesheet rows
 *   ent   the CO entitlement rows
 * The catalogue is fixed (CATALOGUE below); the tests seed only what they need.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WIDGET = path.join(ROOT, 'Employee Calendar UI Widget', 'widget.server-script.js');

export const TABLES = {
  day:  'x_1995110_shift_0_u_shift_submission',
  lock: 'x_1995110_shift_0_monthly_timesheet',
  cat:  'x_1995110_shift_0_shift_type',
  sum:  'x_1995110_shift_0_shift_submission_summary',
  ent:  'x_1995110_shift_0_shift_co_entitlement',
};

/**
 * A small, sys_id-keyed catalogue. Semantics come from oc_role and the allow_*
 * flags, so the names are plain words and carry no meaning of their own.
 */
const CATALOGUE = [
  { sys_id: 'day', name: 'Day', active: true, rate: '500', currency: 'INR',
    oc_role: 'none', allow_weekday: true, allow_weekend_holiday: false, day_category: 'regular' },
  { sys_id: 'co', name: 'Comp day', active: true, rate: '0', currency: 'INR',
    oc_role: 'consumes_co', allow_weekday: true, allow_weekend_holiday: false, day_category: 'holiday' },
  { sys_id: 'oc', name: 'On call', active: true, rate: '1500', currency: 'INR',
    oc_role: 'grants_co', allow_weekday: false, allow_weekend_holiday: true, day_category: 'regular' },
];

const FIXED_NOW = '2026-10-15';

/** Fixed clock: the widget reads "now" through GlideDateTime. */
class GlideDateTimeStub {
  constructor() {}
  getYearLocalTime() { return FIXED_NOW.slice(0, 4); }
  getMonthLocalTime() { return String(Number(FIXED_NOW.slice(5, 7))); }
  getDate() { return { getValue: () => FIXED_NOW }; }
}

export function runCalendarServer({ input = {}, user = 'emp-1', seed = {} } = {}) {
  const tables = {
    [TABLES.day]:  clone(seed.day  || []),
    [TABLES.lock]: clone(seed.lock || []),
    [TABLES.cat]:  clone(CATALOGUE),
    [TABLES.sum]:  [],
    [TABLES.ent]:  clone(seed.ent  || []),
  };
  const errors = [];
  const gs = {
    getUserID: () => user,
    getProperty: (_name, fallback) => fallback,
    info: () => {},
    warn: () => {},
    addErrorMessage: (msg) => errors.push(msg),
  };

  const sandbox = loadScriptInclude(
    ['ShiftPayEntitlements', 'ShiftPayCalendarRules', 'ShiftPayAggregator'],
    { gs, GlideRecord: fakeGlide(tables), GlideDateTime: GlideDateTimeStub }
  );
  sandbox.options = {};
  sandbox.input = input;
  sandbox.data = {};
  vm.runInContext(fs.readFileSync(WIDGET, 'utf8'), sandbox, { filename: WIDGET });

  return { data: sandbox.data, errors, tables };
}

/** The day row for a date, or undefined. */
export function dayRow(tables, user, date) {
  return tables[TABLES.day].find((r) => r.u_user === user && r.u_date === date);
}

function clone(rows) {
  return rows.map((r) => ({ ...r }));
}
