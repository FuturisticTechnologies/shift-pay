import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadScriptInclude } from './load-script-include.mjs';
import { fakeGlide } from './fake-glide.mjs';

/**
 * ShiftPayAggregator against an in-memory instance.
 *
 * The aggregator is the payroll maths: what it writes to the summary table is
 * what managers approve and what the reports and Power BI read. These pin the
 * shape of what it writes — one row per shift type per period, u_month
 * 1-indexed, weeks clipped to their month — and how each row is priced.
 */

const USER = 'emp-1';
const OTHER = 'emp-2';

const CATALOGUE = [
  { sys_id: 'day', active: true, rate: '500', currency: 'INR' },
  { sys_id: 'oncall', active: true, rate: '1500', currency: 'INR' },
];

let daySeq = 0;
const logged = (user, date, shift) => ({ sys_id: `d${++daySeq}`, u_user: user, u_date: date, u_shift_type: shift });

function instance(days, catalogue = CATALOGUE) {
  const tables = { day: days, cat: catalogue.map((r) => ({ ...r })), sum: [] };
  const { ShiftPayAggregator } = loadScriptInclude(['ShiftPayAggregator'], {
    GlideRecord: fakeGlide(tables),
  });
  // A fresh aggregator per recompute, as each widget request builds its own —
  // the rate map is cached per instance, so reusing one would hide a rate change.
  const recompute = (dates, user = USER) =>
    new ShiftPayAggregator({ userId: user, dayTable: 'day', summaryTable: 'sum', catalogTable: 'cat' })
      .recompute(dates);
  const rows = (where = {}) =>
    tables.sum
      .filter((r) => Object.entries(where).every(([k, v]) => String(r[k]) === String(v)))
      .map((r) => ({
        user: r.u_user,
        type: r.u_period_type,
        start: r.u_period_start,
        month: String(r.u_month),
        shift: r.u_shift_type,
        count: Number(r.u_count),
        rate: String(r.u_rate_snapshot),
        amount: Number(r.u_amount),
      }));
  return { tables, recompute, rows };
}

describe('what a recompute writes', () => {
  test('one month row and one week row per shift type, priced at the catalogue rate', () => {
    const agg = instance([
      logged(USER, '2026-10-05', 'day'),
      logged(USER, '2026-10-06', 'day'),
      logged(USER, '2026-10-10', 'oncall'),
    ]);
    agg.recompute(['2026-10-05']);

    assert.deepEqual(
      agg.rows({ u_period_type: 'month', u_shift_type: 'day' }),
      [{ user: USER, type: 'month', start: '2026-10-01', month: '10', shift: 'day', count: 2, rate: '500', amount: 1000 }]
    );
    assert.equal(agg.rows({ u_period_type: 'month', u_shift_type: 'oncall' })[0].amount, 1500);
    assert.deepEqual(
      agg.rows({ u_period_type: 'week' }).map((r) => [r.start, r.shift, r.count]),
      [['2026-10-05', 'day', 2], ['2026-10-05', 'oncall', 1]]
    );
  });

  test('u_month is stored 1-indexed', () => {
    const agg = instance([logged(USER, '2026-01-15', 'day')]);
    agg.recompute(['2026-01-15']);
    assert.deepEqual(agg.rows().map((r) => r.month), ['1', '1']);
  });

  test('a week straddling month-end is reported under each month, clipped to it', () => {
    // Wednesday 30 Sep and Thursday 1 Oct share the week of Monday 28 Sep.
    const agg = instance([logged(USER, '2026-09-30', 'day'), logged(USER, '2026-10-01', 'day')]);
    agg.recompute(['2026-09-30', '2026-10-01']);

    const weeks = agg.rows({ u_period_type: 'week' });
    assert.deepEqual(
      weeks.map((r) => [r.start, r.month, r.count]),
      [['2026-09-28', '9', 1], ['2026-09-28', '10', 1]]
    );
  });

  test('a recompute replaces the period rows rather than adding to them', () => {
    const agg = instance([logged(USER, '2026-10-05', 'day')]);
    agg.recompute(['2026-10-05']);
    agg.recompute(['2026-10-05']);
    assert.equal(agg.rows({ u_period_type: 'month' }).length, 1);
    assert.equal(agg.rows({ u_period_type: 'month' })[0].count, 1);
  });

  test("another user's days are neither counted nor touched", () => {
    const agg = instance([logged(USER, '2026-10-05', 'day'), logged(OTHER, '2026-10-05', 'day')]);
    agg.recompute(['2026-10-05'], OTHER);
    agg.recompute(['2026-10-05'], USER);
    assert.equal(agg.rows({ u_user: USER, u_period_type: 'month' })[0].count, 1);
    assert.equal(agg.rows({ u_user: OTHER, u_period_type: 'month' })[0].count, 1);
  });
});

describe('pricing', () => {
  test('a rate change is snapshotted on the next recompute', () => {
    const agg = instance([logged(USER, '2026-10-05', 'day')]);
    agg.recompute(['2026-10-05']);
    agg.tables.cat.find((r) => r.sys_id === 'day').rate = '600';
    agg.recompute(['2026-10-05']);
    assert.equal(agg.rows({ u_period_type: 'month' })[0].rate, '600');
  });

  // SP-80. Deactivating a shift type is a statement about the future: it can no
  // longer be logged. It is not a statement that days already worked were
  // worth nothing, which is what an active-only rate map made it.
  test('SP-80: a deactivated shift type keeps its rate', () => {
    const agg = instance([logged(USER, '2026-10-10', 'oncall'), logged(USER, '2026-10-11', 'oncall')]);
    agg.recompute(['2026-10-10']);
    agg.tables.cat.find((r) => r.sys_id === 'oncall').active = false;
    agg.recompute(['2026-10-10']);

    const [month] = agg.rows({ u_period_type: 'month' });
    assert.equal(month.rate, '1500');
    assert.equal(month.amount, 3000);
  });

  test('SP-80: a shift type whose catalogue row is gone keeps the rate it was snapshotted at', () => {
    const agg = instance([logged(USER, '2026-10-10', 'oncall')]);
    agg.recompute(['2026-10-10']);
    agg.tables.cat = agg.tables.cat.filter((r) => r.sys_id !== 'oncall');
    agg.recompute(['2026-10-10']);

    assert.deepEqual(
      agg.rows().map((r) => [r.type, r.rate, r.amount]),
      [['month', '1500', 1500], ['week', '1500', 1500]]
    );
  });

  test('a shift type with no rate anywhere still aggregates at 0', () => {
    const agg = instance([logged(USER, '2026-10-05', 'ghost')]);
    agg.recompute(['2026-10-05']);
    assert.deepEqual(agg.rows({ u_period_type: 'month' }).map((r) => [r.count, r.amount]), [[1, 0]]);
  });
});
