import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runCalendarServer, dayRow, TABLES } from './load-calendar-server.mjs';

/**
 * Negative tests for every server-side refusal in the calendar (SP-100).
 *
 * The server has six refusal paths. Each test asserts two things:
 *   1. the refusal is raised through gs.addErrorMessage, with its exact wording,
 *   2. nothing is written — the day, the timesheet and the entitlements are as
 *      they were before the request.
 *
 * Assertion 1 is the server's half of the contract. Whether the screen shows
 * the refusal is TC-SP-004's question, and it fails by design until fixed; these
 * tests do not look at the screen.
 *
 * Fixtures (see load-calendar-server.mjs for the catalogue):
 *   'oc'  grants a CO right, is allowed at weekends, and opens a 7-weekday window
 *   'co'  consumes that right on a weekday
 *   Saturday 2026-10-03 logs an OC; Tuesday 2026-10-06 is inside its window.
 */

const USER = 'emp-1';
const OCT = { year: 2026, month: 9 }; // 0-indexed month, as the widget passes it

const SAT_OC = '2026-10-03';
const TUE_CO = '2026-10-06';

/** An OC on SAT_OC, with its CO already taken on TUE_CO. */
const coTakenFromOc = () => ({
  day: [
    { sys_id: 'd-oc', u_user: USER, u_date: SAT_OC, u_shift_type: 'oc' },
    { sys_id: 'd-co', u_user: USER, u_date: TUE_CO, u_shift_type: 'co' },
  ],
  ent: [
    { sys_id: 'e1', u_user: USER, oc_date: SAT_OC, u_oc_window_end: '2026-10-13',
      u_oc_entry: 'd-oc', u_co_entry: 'd-co', u_co_date: TUE_CO },
  ],
});

describe('calendar refusals (SP-100)', () => {
  test('1. a locked month refuses a day change and leaves the day alone', () => {
    const seed = {
      lock: [{ sys_id: 'ts1', u_user: USER, u_year: 2026, u_month: 10, status: 'submitted' }],
      day: [{ sys_id: 'd1', u_user: USER, u_date: '2026-10-05', u_shift_type: 'day' }],
    };
    const { errors, tables } = runCalendarServer({
      user: USER, seed,
      input: { action: 'saveDay', date: '2026-10-05', shift: 'co', ...OCT },
    });

    assert.deepEqual(errors, ['This month is already submitted and locked.']);
    assert.equal(dayRow(tables, USER, '2026-10-05').u_shift_type, 'day');
    assert.equal(tables[TABLES.day].length, 1);
  });

  test('2. a CO with no open entitlement is refused and nothing is written', () => {
    const { errors, tables } = runCalendarServer({
      user: USER,
      input: { action: 'saveDay', date: TUE_CO, shift: 'co', ...OCT },
    });

    assert.deepEqual(errors, [
      'CO not available for 2026-10-06 — log an OC+CO shift on a prior holiday first.',
    ]);
    assert.equal(dayRow(tables, USER, TUE_CO), undefined);
    assert.equal(tables[TABLES.ent].length, 0);
  });

  test('3. changing an OC that a taken CO depends on is refused and the OC stays', () => {
    const { errors, tables } = runCalendarServer({
      user: USER, seed: coTakenFromOc(),
      input: { action: 'saveDay', date: SAT_OC, shift: 'day', ...OCT },
    });

    assert.deepEqual(errors, ['Cannot change this entry — a CO on 2026-10-06 depends on it.']);
    assert.equal(dayRow(tables, USER, SAT_OC).u_shift_type, 'oc');
    assert.equal(tables[TABLES.ent][0].u_co_entry, 'd-co');
  });

  test('4. clearing an OC that a taken CO depends on is refused and the OC stays', () => {
    const { errors, tables } = runCalendarServer({
      user: USER, seed: coTakenFromOc(),
      input: { action: 'clearDay', date: SAT_OC, ...OCT },
    });

    assert.deepEqual(errors, ['Cannot clear — CO on 2026-10-06 depends on this entry.']);
    assert.equal(dayRow(tables, USER, SAT_OC).u_shift_type, 'oc');
    assert.equal(tables[TABLES.ent][0].u_co_entry, 'd-co');
  });

  test('5. a CO cannot be applied in bulk and no day is written', () => {
    const { errors, tables } = runCalendarServer({
      user: USER,
      input: { action: 'bulkSave', shift: 'co', dates: ['2026-10-07', '2026-10-08'], ...OCT },
    });

    assert.deepEqual(errors, [
      'This shift type cannot be applied in bulk — please log it on each date individually.',
    ]);
    assert.equal(tables[TABLES.day].length, 0);
  });

  test('6. submitting with unlogged weekdays is refused and the month stays open', () => {
    // October 2026 has 22 weekdays; nothing is logged.
    const { errors, tables } = runCalendarServer({
      user: USER,
      input: { action: 'submitMonth', ...OCT },
    });

    assert.deepEqual(errors, ['Cannot submit: 22 weekday(s) still unlogged.']);
    assert.equal(tables[TABLES.lock].length, 0);
  });
});
