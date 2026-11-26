import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadScriptInclude, plain } from './load-script-include.mjs';

/**
 * ShiftPayExportSplit - the optional split of a payroll export (SP-131).
 *
 * BR-X9 / DD-8: one consolidated file by default, an optional split per
 * manager or cost centre, and the split files' totals must equal the
 * consolidated total. These pin that contract, plus the two ways a split can
 * quietly lose money: dividing one employee between files, and dropping an
 * employee whose manager or cost centre is blank.
 */

const row = (user, manager, shift, subtotal, extra = {}) => ({
  userId: user,
  employeeName: `Name ${user}`,
  employeeId: `E-${user}`,
  managerId: manager ? `mgr-${manager}` : '',
  managerName: manager || '',
  period: '2026-10',
  shiftType: shift,
  days: 1,
  rate: subtotal,
  currency: 'INR',
  subtotal,
  ...extra,
});

const ROWS = [
  row('u1', 'Asha Rao', 'UK', '1500.00'),
  row('u1', 'Asha Rao', 'OC', '3000.00'),
  row('u2', 'Asha Rao', 'US', '2000.10'),
  row('u3', 'Vikram Iyer', 'UK', '1500.20'),
  row('u3', 'Vikram Iyer', 'US', '999.70'),
];

function load({ property, globals = {} } = {}) {
  const warnings = [];
  const sandbox = loadScriptInclude(['ShiftPayExportSplit'], {
    gs: {
      getUserID: () => 'unit-test-user',
      getProperty: (name, fallback) =>
        name === 'x_1995110_shift_0.export_split_by' && property !== undefined ? property : fallback,
      info: () => {},
      warn: (msg) => warnings.push(msg),
    },
    ...globals,
  });
  return { ShiftPayExportSplit: sandbox.ShiftPayExportSplit, warnings };
}

const split = (rows, config = {}, opts = {}) => {
  const { ShiftPayExportSplit, warnings } = load(opts);
  const result = new ShiftPayExportSplit({ baseName: 'shiftpay_payroll_2026-10', ...config }).split(rows);
  return { result: plain(result), warnings };
};

/** A sys_user stub that serves cost centres and records how it was queried. */
function userTable(users, log) {
  return function GlideRecord(table) {
    let results = [];
    let i = -1;
    this.addQuery = (field, op, value) => {
      log.push({ table, field, op, value });
      const ids = String(value).split(',');
      results = users.filter((u) => ids.includes(u.sys_id));
    };
    this.query = () => {};
    this.next = () => ++i < results.length;
    this.getUniqueValue = () => results[i].sys_id;
    this.getValue = (f) => results[i][f] ?? null;
    this.getDisplayValue = (f) => results[i][`${f}_display`] ?? '';
  };
}

describe('default: one consolidated file', () => {
  test('no split configured means the consolidated file and nothing else', () => {
    const { result } = split(ROWS);
    assert.equal(result.splitBy, 'none');
    assert.equal(result.consolidated.name, 'shiftpay_payroll_2026-10.csv');
    assert.equal(result.consolidated.rowCount, 5);
    assert.equal(result.consolidated.employees, 3);
    assert.deepEqual(result.consolidated.totals, { INR: '9000.00' });
    assert.deepEqual(result.files, []);
    assert.equal(result.reconciliation.ok, true);
  });

  test('the system property selects the split when the caller does not', () => {
    assert.equal(split(ROWS, {}, { property: 'manager' }).result.files.length, 2);
    assert.equal(split(ROWS, {}, { property: 'none' }).result.files.length, 0);
  });

  test('an unknown setting falls back to the consolidated file and says so', () => {
    const { result, warnings } = split(ROWS, { splitBy: 'department' });
    assert.equal(result.splitBy, 'none');
    assert.deepEqual(result.files, []);
    assert.ok(warnings.some((w) => w.includes('department')));
  });

  test('cost_center is accepted as a spelling of cost_centre', () => {
    const { ShiftPayExportSplit } = load();
    assert.equal(new ShiftPayExportSplit({ splitBy: 'cost_center' }).splitBy, 'cost_centre');
    assert.equal(new ShiftPayExportSplit({ splitBy: ' Manager ' }).splitBy, 'manager');
  });
});

describe('split by manager', () => {
  test('one file per manager, alongside an unchanged consolidated file', () => {
    const { result } = split(ROWS, { splitBy: 'manager' });
    assert.equal(result.consolidated.rowCount, 5);
    assert.deepEqual(
      result.files.map((f) => [f.name, f.label, f.rowCount, f.employees, f.totals.INR]),
      [
        ['shiftpay_payroll_2026-10__asha-rao.csv', 'Asha Rao', 3, 2, '6500.10'],
        ['shiftpay_payroll_2026-10__vikram-iyer.csv', 'Vikram Iyer', 2, 1, '2499.90'],
      ]
    );
  });

  test('the split totals equal the consolidated total, to the paisa', () => {
    const { result } = split(ROWS, { splitBy: 'manager' });
    const r = result.reconciliation;
    assert.equal(r.ok, true);
    assert.deepEqual(r.splitTotals, r.totals);
    assert.equal(r.splitRowCount, r.rowCount);
    assert.equal(r.splitEmployees, r.employees);
    assert.equal(r.fileCount, 2);
  });

  test('money is summed in minor units, so float drift cannot fail a correct split', () => {
    // 0.1 + 0.2 !== 0.3 in floating point; 10 + 20 === 30 in paise.
    const rows = [row('a', 'M1', 'X', '0.10'), row('b', 'M2', 'X', '0.20'), row('c', 'M2', 'X', '0.30')];
    const { result } = split(rows, { splitBy: 'manager' });
    assert.equal(result.reconciliation.ok, true);
    assert.deepEqual(result.consolidated.totals, { INR: '0.60' });
  });

  test('a blank manager goes to an Unassigned file, last, instead of out of the run', () => {
    const rows = [...ROWS, row('u9', '', 'UK', '1500.00')];
    const { result } = split(rows, { splitBy: 'manager' });
    const last = result.files[result.files.length - 1];
    assert.equal(last.name, 'shiftpay_payroll_2026-10__unassigned.csv');
    assert.equal(last.label, 'Unassigned manager');
    assert.equal(last.rowCount, 1);
    assert.equal(result.reconciliation.ok, true);
    assert.deepEqual(result.consolidated.totals, { INR: '10500.00' });
  });

  test('an employee is never divided between files', () => {
    // u1 has one row under a second manager - a data quirk, since a timesheet
    // has one approver. Their whole month must still travel together.
    const rows = [...ROWS, row('u1', 'Vikram Iyer', 'US', '500.00')];
    const { result, warnings } = split(rows, { splitBy: 'manager' });
    const holding = result.files.filter((f) => f.rows.some((r) => r.userId === 'u1'));
    assert.equal(holding.length, 1);
    assert.equal(holding[0].rows.filter((r) => r.userId === 'u1').length, 3);
    assert.equal(result.reconciliation.ok, true);
    assert.ok(warnings.some((w) => w.includes('u1')));
  });

  test('two managers with the same name get two distinct file names', () => {
    const rows = [
      row('a', 'Priya Shah', 'UK', '100.00', { managerId: 'mgr-111111' }),
      row('b', 'Priya Shah', 'UK', '200.00', { managerId: 'mgr-222222' }),
    ];
    const { result } = split(rows, { splitBy: 'manager' });
    const names = result.files.map((f) => f.name);
    assert.equal(new Set(names).size, 2);
    assert.ok(names.every((n) => n.startsWith('shiftpay_payroll_2026-10__priya-shah')));
    assert.equal(result.reconciliation.ok, true);
  });

  test('rows keep every field the writer needs, in their original order', () => {
    const { result } = split(ROWS, { splitBy: 'manager' });
    assert.deepEqual(result.files[0].rows, [ROWS[0], ROWS[1], ROWS[2]]);
  });
});

describe('split by cost centre', () => {
  const USERS = [
    { sys_id: 'u1', cost_center: 'cc-ops', cost_center_display: 'Operations' },
    { sys_id: 'u2', cost_center: 'cc-fin', cost_center_display: 'Finance' },
    { sys_id: 'u3', cost_center: '', cost_center_display: '' },
  ];

  test('cost centres come from sys_user in one batched query', () => {
    const log = [];
    const { result } = split(ROWS, { splitBy: 'cost_centre' }, { globals: { GlideRecord: userTable(USERS, log) } });
    assert.equal(log.length, 1);
    assert.deepEqual(log[0], { table: 'sys_user', field: 'sys_id', op: 'IN', value: 'u1,u2,u3' });
    assert.deepEqual(
      result.files.map((f) => [f.name, f.employees, f.totals.INR]),
      [
        ['shiftpay_payroll_2026-10__finance.csv', 1, '2000.10'],
        ['shiftpay_payroll_2026-10__operations.csv', 1, '4500.00'],
        ['shiftpay_payroll_2026-10__unassigned.csv', 1, '2499.90'],
      ]
    );
    assert.equal(result.reconciliation.ok, true);
  });

  test('rows that already carry a cost centre are not looked up, and inputs are not mutated', () => {
    const rows = ROWS.map((r) => ({ ...r, costCentreId: 'cc-x', costCentreName: 'Shared' }));
    const before = JSON.stringify(rows);
    const { result } = split(rows, { splitBy: 'cost_centre' });   // default GlideRecord throws if reached
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].name, 'shiftpay_payroll_2026-10__shared.csv');
    assert.equal(JSON.stringify(rows), before);
  });
});

describe('reconciliation refuses a set that does not add up', () => {
  test('reconcile reports a missing row, its money and its employee', () => {
    const { ShiftPayExportSplit } = load();
    const splitter = new ShiftPayExportSplit({ splitBy: 'manager', baseName: 'run' });
    const { consolidated, files } = splitter.split(ROWS);
    files[1].rows = files[1].rows.slice(0, 1);       // lose u3's US row
    const r = plain(splitter.reconcile(consolidated, files));
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('INR total 8000.30') && p.includes('9000.00')));
    assert.ok(r.problems.some((p) => p.includes('4 rows')));
  });

  test('reconcile catches one employee appearing in two files', () => {
    const { ShiftPayExportSplit } = load();
    const splitter = new ShiftPayExportSplit({ splitBy: 'manager', baseName: 'run' });
    const { consolidated, files } = splitter.split(ROWS);
    // Move one of u1's two rows: same money, same rows, but u1 is now split.
    const [moved] = files[0].rows.splice(0, 1);
    files[1].rows.push(moved);
    const r = plain(splitter.reconcile(consolidated, files));
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('appears in both')));
  });

  test('a row with no numeric subtotal stops the run rather than counting as zero', () => {
    assert.throws(
      () => split([...ROWS, row('u7', 'Asha Rao', 'UK', '')], { splitBy: 'manager' }),
      /u7.*no numeric subtotal/
    );
  });
});

describe('currencies are reconciled separately', () => {
  test('INR and GBP never add together', () => {
    const rows = [
      row('a', 'M1', 'UK', '1000.00'),
      row('b', 'M2', 'UK', '50.25', { currency: 'GBP' }),
      row('c', 'M2', 'UK', '200.00'),
    ];
    const { result } = split(rows, { splitBy: 'manager' });
    assert.deepEqual(result.consolidated.totals, { GBP: '50.25', INR: '1200.00' });
    assert.deepEqual(result.files[1].totals, { GBP: '50.25', INR: '200.00' });
    assert.equal(result.reconciliation.ok, true);
  });
});
