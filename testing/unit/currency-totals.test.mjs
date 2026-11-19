import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadScriptInclude, plain } from './load-script-include.mjs';
import { fakeGlide } from './fake-glide.mjs';

/**
 * BR-X6: currency comes from the data, and a total never adds two currencies.
 * The widget server scripts are run from source, against an in-memory instance.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { ShiftPayMoney } = loadScriptInclude(['ShiftPayMoney']);
const money = new ShiftPayMoney();
const total = (entries, zero) => {
  const bag = {};
  for (const [currency, amount] of entries) money.add(bag, currency, amount);
  return plain(money.toList(bag, zero));
};

describe('ShiftPayMoney', () => {
  test('one currency adds up', () => {
    assert.deepEqual(total([['USD', '10'], ['USD', 5]]), [{ currency: 'USD', amount: 15 }]);
  });

  test('two currencies stay apart', () => {
    assert.deepEqual(total([['USD', 10], ['EUR', 5]]),
      [{ currency: 'EUR', amount: 5 }, { currency: 'USD', amount: 10 }]);
  });

  test('an amount with no currency is not folded into a known one', () => {
    assert.deepEqual(total([['USD', 10], ['', 5]]),
      [{ currency: '', amount: 5 }, { currency: 'USD', amount: 10 }]);
  });

  test('a zero amount never makes a total mixed', () => {
    assert.deepEqual(total([['USD', 10], ['EUR', 0], ['', 0]]), [{ currency: 'USD', amount: 10 }]);
  });

  test('a total of nothing is labelled only when one answer exists', () => {
    assert.deepEqual(total([], 'GBP'), [{ currency: 'GBP', amount: 0 }]);
    assert.deepEqual(total([['EUR', 0]], 'GBP'), [{ currency: 'EUR', amount: 0 }]);
    assert.deepEqual(total([['EUR', 0], ['USD', 0]], 'GBP'), [{ currency: '', amount: 0 }]);
    assert.deepEqual(total([]), [{ currency: '', amount: 0 }]);
  });

  test('sharedCurrency is blank unless the catalogue agrees', () => {
    assert.equal(money.sharedCurrency([{ currency: 'USD' }, { currency: '' }]), 'USD');
    assert.equal(money.sharedCurrency([{ currency: 'USD' }, { currency: 'EUR' }]), '');
    assert.equal(money.sharedCurrency([]), '');
  });
});

describe('a catalogue row without a currency', () => {
  const { ShiftPayCalendarRules } = loadScriptInclude(['ShiftPayCalendarRules']);
  const errorFor = (rate) => new ShiftPayCalendarRules({
    coEnabled: false,
    catalogue: [{ sys_id: 'a', name: 'A', rate, currency: '', day_category: 'regular' }],
  }).configError();

  test('is a configuration error only when the shift type is paid', () => {
    assert.match(errorFor('100'), /"A" has a rate but no currency/);
    assert.equal(errorFor('0'), '');
  });
});

// ── the widget server scripts ───────────────────────────────────────────────

/** One reportee per currency, each with 200 submitted for October 2026. */
function run(widget, currencies) {
  const sum = [];
  const lock = [];
  const people = [];
  currencies.forEach((currency, i) => {
    const user = `emp-${i}`;
    people.push({ sys_id: user, manager: 'unit-test-user', active: true, name: `Person ${i}` });
    lock.push({ sys_id: `ts-${i}`, u_user: user, u_year: 2026, u_month: 10, status: 'submitted' });
    for (const type of ['month', 'week']) {
      sum.push({ sys_id: `${type}-${i}`, u_user: user, u_period_type: type, u_period_start: '2026-10-05',
        u_year: 2026, u_month: 10, u_shift_type: 'day', u_count: 2, u_rate_snapshot: 100,
        u_amount: 200, u_currency: currency });
    }
  });
  const data = {};
  const sandbox = loadScriptInclude(
    ['ShiftPayMoney', 'ShiftPayCalendarRules', 'ShiftPayEntitlements'],
    {
      GlideRecord: fakeGlide({
        sys_user: people,
        x_1995110_shift_0_monthly_timesheet: lock,
        x_1995110_shift_0_shift_submission_summary: sum,
        x_1995110_shift_0_shift_type: [{ sys_id: 'day', active: true, name: 'Day', rate: '100',
          currency: currencies[0], day_category: 'regular', allow_weekday: '1' }],
      }),
      GlideDateTime: function () {
        this.getYearLocalTime = () => 2026;
        this.getMonthLocalTime = () => 10;
        this.getDayOfMonthLocalTime = () => 15;
      },
      data,
      options: { enable_co_entitlement: false },
      input: { year: 2026, month: 9, scope: 'team' },
    }
  );
  sandbox.gs.hasRole = () => false;
  const file = path.join(ROOT, widget, 'widget.server-script.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return plain(data);
}

describe('Manager Approval totals', () => {
  test('a single non-INR currency is carried through', () => {
    const data = run('Manager Approval UI Widget', ['USD', 'USD']);
    assert.deepEqual(data.totals.pendingAmounts, [{ currency: 'USD', amount: 400 }]);
    assert.deepEqual(data.totals.approvedAmounts, [{ currency: 'USD', amount: 0 }]);
    assert.deepEqual(data.rows[0].totalAmounts, [{ currency: 'USD', amount: 200 }]);
  });

  test('a mixed team total is reported per currency', () => {
    const data = run('Manager Approval UI Widget', ['USD', 'EUR']);
    assert.deepEqual(data.totals.pendingAmounts,
      [{ currency: 'EUR', amount: 200 }, { currency: 'USD', amount: 200 }]);
  });
});

for (const widget of ['Reporting UI Widget', 'Reports UI Widget']) {
  describe(`${widget} totals`, () => {
    test('one currency keeps a chartable scalar', () => {
      const data = run(widget, ['GBP', 'GBP']);
      assert.equal(data.mixedCurrency, false);
      assert.equal(data.currency, 'GBP');
      assert.equal(data.totals.amount, 400);
      assert.equal(data.trend[data.trend.length - 1].amount, 400);
      // An empty month is zero in the report's currency.
      assert.deepEqual(data.trend[0].amounts, [{ currency: 'GBP', amount: 0 }]);
    });

    test('mixed currencies leave no scalar to add, chart or rank by', () => {
      const data = run(widget, ['USD', 'EUR']);
      assert.equal(data.mixedCurrency, true);
      assert.equal(data.currency, '');
      for (const bucket of [data.totals, data.trend[data.trend.length - 1], data.mix[0]]) {
        assert.equal(bucket.amount, null);
        assert.deepEqual(bucket.amounts,
          [{ currency: 'EUR', amount: 200 }, { currency: 'USD', amount: 200 }]);
      }
      assert.equal(data.team[0].amount, null);
      assert.equal(data.team[0].amounts.length, 1);
    });
  });
}

describe('no assumed currency', () => {
  test('widget and Script Include source quotes no currency code', () => {
    const dirs = fs.readdirSync(ROOT).filter((d) => /Widget$|^Script Includes$/.test(d));
    const offenders = [];
    for (const dir of dirs) {
      for (const name of fs.readdirSync(path.join(ROOT, dir))) {
        const source = fs.readFileSync(path.join(ROOT, dir, name), 'utf8');
        if (/(['"])(INR|USD|GBP|EUR)\1/.test(source)) offenders.push(`${dir}/${name}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
