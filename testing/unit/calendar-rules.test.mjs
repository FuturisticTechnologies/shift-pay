import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadScriptInclude, plain } from './load-script-include.mjs';

/**
 * ShiftPayCalendarRules, exercised offline.
 *
 *   node --test "testing/unit/*.test.mjs"
 *
 * These pin the rules the calendar and the manager widget both depend on —
 * catalogue validation and the allowed-shift list — without an instance. The
 * Playwright pack proves the deployed widgets obey them; this proves the rules
 * are what the README says they are, in milliseconds, on every change.
 *
 * Semantics are keyed by sys_id, so the fixture's sys_ids are readable words
 * and its names are deliberately unlike the live catalogue's: a rule that only
 * passes for a shift called "CO" is branching on the name, which is the one
 * thing it must never do.
 */

const ROW = (sysId, name, ocRole, weekday, weekend, category) => ({
  sys_id: sysId,
  name,
  oc_role: ocRole,
  allow_weekday: weekday,
  allow_weekend_holiday: weekend,
  day_category: category,
});

/** A well-formed catalogue, in the name order the Script Include reads it. */
const CATALOGUE = [
  ROW('co', 'Comp day', 'consumes_co', true, false, 'holiday'),
  ROW('day', 'Day shift', 'none', true, false, 'regular'),
  ROW('leave', 'Leave', 'none', true, false, 'off'),
  ROW('oncall', 'On call', 'none', false, true, 'regular'),
  ROW('oncall_co', 'On call + comp', 'grants_co', false, true, 'regular'),
];

const THURSDAY = '2026-10-01';
const FRIDAY = '2026-10-02';
const SATURDAY = '2026-10-03';

/** Entitlements stub: one open window, and a count of how often it was read. */
function entitlementsWith(windows) {
  const stub = {
    loads: 0,
    loadUnconsumed() {
      stub.loads++;
      return windows;
    },
    hasUnconsumedFor(rows, dateKey) {
      return rows.some((w) => dateKey >= w.start && dateKey <= w.end);
    },
  };
  return stub;
}

function rules(config = {}, globals = {}) {
  const { ShiftPayCalendarRules } = loadScriptInclude(['ShiftPayCalendarRules'], globals);
  return new ShiftPayCalendarRules({
    userId: 'emp-1',
    catalogue: CATALOGUE,
    entitlements: entitlementsWith([]),
    ...config,
  });
}

describe('configError', () => {
  test('a well-formed catalogue reports nothing', () => {
    assert.equal(rules().configError(), '');
  });

  test('names the shift type that is missing a day category', () => {
    const cat = CATALOGUE.map((r) => (r.sys_id === 'leave' ? { ...r, day_category: '' } : r));
    assert.equal(
      rules({ catalogue: cat }).configError(),
      'Shift type "Leave" is missing a day category.'
    );
  });

  test('CO enabled with no consumes_co row is a fault', () => {
    const cat = CATALOGUE.filter((r) => r.oc_role !== 'consumes_co');
    assert.match(rules({ catalogue: cat }).configError(), /no shift type has the "consumes_co" role/);
  });

  test('CO disabled with no consumes_co row is fine', () => {
    const cat = CATALOGUE.filter((r) => r.oc_role !== 'consumes_co');
    assert.equal(rules({ catalogue: cat, coEnabled: false }).configError(), '');
  });

  // SP-118. Before this, a second consumes_co row passed validation and
  // _deriveSemantics silently kept whichever it read last.
  test('SP-118: two consumes_co rows are a fault, and both are named', () => {
    const cat = [...CATALOGUE, ROW('co2', 'Time in lieu', 'consumes_co', true, false, 'off')];
    assert.equal(
      rules({ catalogue: cat }).configError(),
      'CO entitlement needs exactly one shift type with the "consumes_co" role; ' +
        '2 have it: "Comp day", "Time in lieu".'
    );
  });

  test('SP-118: duplicates are not a fault while CO is disabled', () => {
    // With CO off the consumes_co rows are ordinary shifts on their own
    // allow_* flags, so nothing depends on which one the rules pick.
    const cat = [...CATALOGUE, ROW('co2', 'Time in lieu', 'consumes_co', true, false, 'off')];
    assert.equal(rules({ catalogue: cat, coEnabled: false }).configError(), '');
  });

  test('every problem is reported in the one banner string', () => {
    const cat = [
      ...CATALOGUE.map((r) => (r.sys_id === 'day' ? { ...r, day_category: '' } : r)),
      ROW('co2', 'Time in lieu', 'consumes_co', true, false, ''),
    ];
    const msg = rules({ catalogue: cat }).configError();
    assert.match(msg, /"Day shift" is missing a day category\./);
    assert.match(msg, /"Time in lieu" is missing a day category\./);
    assert.match(msg, /2 have it/);
  });
});

describe('allowed shifts', () => {
  test('a plain weekday offers the weekday rows, minus the CO', () => {
    assert.deepEqual(plain(rules().allowedForDate(THURSDAY)), ['day', 'leave']);
  });

  test('a weekend offers the weekend rows only', () => {
    assert.deepEqual(plain(rules().allowedForDate(SATURDAY)), ['oncall', 'oncall_co']);
  });

  test('CO is offered on a weekday inside an open entitlement window', () => {
    const r = rules({ entitlements: entitlementsWith([{ start: THURSDAY, end: FRIDAY }]) });
    assert.deepEqual(plain(r.allowedForDate(FRIDAY)), ['day', 'leave', 'co']);
    assert.ok(r.isAllowedOn(FRIDAY, 'co'));
  });

  test('CO is withheld outside every window', () => {
    const r = rules({ entitlements: entitlementsWith([{ start: THURSDAY, end: THURSDAY }]) });
    assert.equal(r.isAllowedOn(FRIDAY, 'co'), false);
  });

  test('CO is never offered on a weekend, even inside a window', () => {
    const r = rules({ entitlements: entitlementsWith([{ start: THURSDAY, end: '2026-10-09' }]) });
    assert.equal(r.isAllowedOn(SATURDAY, 'co'), false);
  });

  test('with CO disabled the consumes_co row follows its own allow_* flags', () => {
    const r = rules({ coEnabled: false });
    assert.deepEqual(plain(r.allowedForDate(THURSDAY)), ['co', 'day', 'leave']);
  });

  test('isAllowedOn refuses a missing date or shift rather than guessing', () => {
    const r = rules();
    assert.equal(r.isAllowedOn('', 'day'), false);
    assert.equal(r.isAllowedOn(THURSDAY, ''), false);
    assert.equal(r.isAllowedOn(THURSDAY, 'no-such-shift'), false);
  });

  test('allowedForMonth takes a 0-indexed month and reads entitlements once', () => {
    const ent = entitlementsWith([]);
    const month = rules({ entitlements: ent }).allowedForMonth(2026, 9); // October
    const keys = Object.keys(month);
    assert.equal(keys.length, 31);
    assert.equal(keys[0], '2026-10-01');
    assert.equal(keys[30], '2026-10-31');
    assert.equal(ent.loads, 1, 'the entitlement table should be read once per month, not per day');
  });
});

describe('holidays', () => {
  // A schedule with one span, on a Friday. The stubs model only what
  // holidays() touches: the property, cmn_schedule_span, and GlideDateTime.
  const withHolidayOn = (dateKey) => ({
    gs: {
      getUserID: () => 'unit-test-user',
      getProperty: (name, fallback) =>
        name === 'x_shiftpay.holiday_schedule' ? 'sched-1' : fallback,
    },
    GlideRecord: function (table) {
      assert.equal(table, 'cmn_schedule_span');
      const spans = [{ start_date_time: `${dateKey} 00:00:00` }];
      let i = -1;
      this.addQuery = () => {};
      this.query = () => {};
      this.next = () => ++i < spans.length;
      this.getValue = (f) => spans[i][f];
    },
    GlideDateTime: function (value) {
      this.getDate = () => ({ getValue: () => value.slice(0, 10) });
    },
  });

  test('a weekday holiday offers the weekend set', () => {
    const r = rules({}, withHolidayOn(FRIDAY));
    assert.ok(r.isHoliday(FRIDAY));
    assert.deepEqual(plain(r.allowedForDate(FRIDAY)), ['oncall', 'oncall_co']);
  });

  test('CO is withheld on a holiday, even inside a window', () => {
    const r = rules(
      { entitlements: entitlementsWith([{ start: THURSDAY, end: '2026-10-09' }]) },
      withHolidayOn(FRIDAY)
    );
    assert.equal(r.isAllowedOn(FRIDAY, 'co'), false);
    assert.ok(r.isAllowedOn(THURSDAY, 'co'));
  });

  test('no holiday property means no holidays, and no query', () => {
    // The default GlideRecord stub throws, so reaching cmn_schedule_span here
    // would fail the test. This is the instance as it stands (TC-SP-030).
    assert.equal(rules().isHoliday(FRIDAY), false);
  });
});
