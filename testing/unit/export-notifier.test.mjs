import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadScriptInclude, plain } from './load-script-include.mjs';
import { fakeGlide } from './fake-glide.mjs';

/**
 * ShiftPayExportNotifier - NF-5, NF-6, FR-X7, FR-X8.
 *
 * The contract that matters: a run with no file is never announced as a
 * success, payroll's event never fires on failure, and no problem is silent.
 */

const COMPLETED = 'x_1995110_shift_0.export.completed';
const EXCEPTION = 'x_1995110_shift_0.export.exception';
const TS = 'x_1995110_shift_0_monthly_timesheet';
const DAY = 'x_1995110_shift_0_u_shift_submission';

const FIELDS = ['period_label', 'target_record', 'exception_summary',
  'exception_detail', 'excluded_count', 'excluded_list'];

function setup({ tables = { [TS]: [], [DAY]: [] }, GlideRecord, fields = FIELDS } = {}) {
  const log = [];
  const errors = [];
  const stored = {};
  const run = {
    isValidField: (f) => fields.includes(f),
    setValue: (f, v) => { stored[f] = v; },
    update: () => log.push({ saved: true }),
  };
  const { ShiftPayExportNotifier } = loadScriptInclude(['ShiftPayExportNotifier'], {
    gs: {
      eventQueue: (name, record, parm1, parm2) => log.push({ name, record, parm1, parm2 }),
      error: (m) => errors.push(m),
    },
    GlideRecord: GlideRecord || fakeGlide(tables),
  });
  const notifier = new ShiftPayExportNotifier();
  return {
    notifier, run, stored, log, errors,
    report: (result) => plain(notifier.report(run, { year: 2026, month: 9, ...result })),
  };
}

const ok = { approvedCount: 3, targetRecord: 'RITM0010001', excluded: [] };
const pending = [{ employee: 'Asha Rao', reason: 'Submitted, awaiting approval' }];

describe('which events fire', () => {
  const cases = [
    ['clean run', ok, 'completed', [COMPLETED]],
    ['run with exclusions', { ...ok, excluded: pending }, 'completed_with_exclusions', [COMPLETED, EXCEPTION]],
    ['zero approved', { approvedCount: 0, excluded: pending }, 'no_approved_timesheets', [EXCEPTION]],
    ['no target record', { approvedCount: 3, excluded: [] }, 'no_target_record', [EXCEPTION]],
    ['error', { ...ok, error: 'boom' }, 'failed', [EXCEPTION]],
    ['no approved count', { targetRecord: 'RITM0010001', excluded: [] }, 'failed', [EXCEPTION]],
  ];
  for (const [name, result, outcome, events] of cases) {
    test(name, () => {
      const actual = setup().report(result);
      assert.equal(actual.outcome, outcome);
      assert.deepEqual(actual.events, events);
    });
  }
});

describe('what the notification reads', () => {
  test('success names the month and the record, and is saved before queueing', () => {
    const s = setup();
    s.report(ok);
    assert.equal(s.stored.period_label, 'October 2026');
    assert.equal(s.stored.target_record, 'RITM0010001');
    assert.equal(s.stored.excluded_list, 'None');
    assert.equal(s.log[0].saved, true);
    assert.equal(s.log[1].record, s.run);
    assert.equal(s.log[1].parm1, 'October 2026');
  });

  test('a failure carries the error and the excluded list', () => {
    const s = setup();
    s.report({ error: 'Catalog item not found', excluded: pending });
    assert.equal(s.stored.exception_summary, 'Export failed; 1 timesheet(s) excluded');
    assert.equal(s.stored.exception_detail, 'Catalog item not found');
    assert.equal(s.stored.excluded_list, 'Asha Rao - Submitted, awaiting approval');
  });

  test('a broken lookup still alerts and never claims nothing was excluded', () => {
    const s = setup({ GlideRecord: function () { throw new Error('no access'); } });
    const result = s.report({ approvedCount: 3, targetRecord: 'RITM0010001' });
    assert.deepEqual(result.events, [COMPLETED, EXCEPTION]);
    assert.equal(result.excludedCount, null);
    assert.equal(s.stored.excluded_count, '');
    assert.match(s.stored.excluded_list, /Could not be determined/);
    assert.match(s.stored.exception_detail, /no access/);
    assert.equal(s.errors.length, 1);
  });

  test('a missing run table column is logged by name', () => {
    const s = setup({ fields: FIELDS.filter((f) => f !== 'excluded_list') });
    s.report(ok);
    assert.match(s.errors[0], /excluded_list/);
  });
});

describe('findExcluded', () => {
  const sheet = (u_user, status, u_month = 10) => ({ u_user, status, u_year: 2026, u_month });
  const day = (u_user, u_date) => ({ u_user, u_date });

  test('lists everything unapproved for the month, once per employee', () => {
    const tables = {
      [TS]: [
        sheet('approved', 'approved'),
        sheet('exported', 'exported'),
        sheet('waiting', 'submitted'),
        sheet('legacy', ''),
        sheet('rejected', 'rejected'),
        sheet('other-month', 'submitted', 9),
      ],
      [DAY]: [
        day('approved', '2026-10-01'),
        day('draft', '2026-10-01'),
        day('draft', '2026-10-31'),
        day('september', '2026-09-30'),
        day('november', '2026-11-01'),
      ],
    };
    const { notifier } = setup({ tables });
    assert.deepEqual(plain(notifier.findExcluded(2026, 9)), [
      { employee: 'draft', reason: 'Days logged, not submitted' },
      { employee: 'legacy', reason: 'Submitted, awaiting approval' },
      { employee: 'rejected', reason: 'Rejected, not resubmitted' },
      { employee: 'waiting', reason: 'Submitted, awaiting approval' },
    ]);
  });
});

describe('installer agrees with the Script Include', () => {
  const installer = fs.readFileSync(
    new URL('../../One Time Scripts/install-export-notifications.js', import.meta.url), 'utf8');
  const { ShiftPayExportNotifier } = loadScriptInclude(['ShiftPayExportNotifier']);

  test('same event names', () => {
    assert.ok(installer.includes(`'${ShiftPayExportNotifier.EVENT_COMPLETED}'`));
    assert.ok(installer.includes(`'${ShiftPayExportNotifier.EVENT_EXCEPTION}'`));
  });

  test('every ${field} in a template is one the notifier writes', () => {
    const tokens = [...installer.matchAll(/\$\{(\w+)\}/g)]
      .map((m) => m[1])
      .filter((t) => t !== 'URI_REF' && t !== 'field');
    const written = plain(ShiftPayExportNotifier.RUN_FIELDS);
    assert.ok(tokens.length > 0);
    assert.deepEqual(tokens.filter((t) => !written.includes(t)), []);
  });
});
