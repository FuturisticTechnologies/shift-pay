import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadScriptInclude, plain } from './load-script-include.mjs';
import { fakeGlide } from './fake-glide.mjs';

/**
 * The landing page's CO balance tile (SP-84). The widget server script is run
 * from source with the real rule layer, against an in-memory instance.
 *
 * "Remaining" means unused AND the window has not closed, which is what the
 * Reports widget calls open. A lapsed entitlement is not a day still owed.
 */

const SCRIPT = fs.readFileSync(
  new URL('../../Landing Page UI Widget/widget.server-script.js', import.meta.url), 'utf8');
const ENT = 'x_1995110_shift_0_shift_co_entitlement';
const CAT = 'x_1995110_shift_0_shift_type';
const TODAY = '2026-11-18';

const ent = (u_oc_window_end, extra = {}) => ({
  u_user: 'emp-1', oc_date: '2026-11-01', u_oc_window_end, u_co_entry: '', ...extra,
});

function run(entitlements, options = {}) {
  const sandbox = loadScriptInclude(['ShiftPayEntitlements', 'ShiftPayCalendarRules'], {
    gs: {
      getUserID: () => 'emp-1',
      getUser: () => ({ getFirstName: () => 'Asha', getDisplayName: () => 'Asha Rao' }),
      getProperty: (_name, fallback) => fallback,
    },
    GlideRecord: fakeGlide({ [ENT]: entitlements, [CAT]: [] }),
    // The user's local date, which is what decides whether a window has closed.
    GlideDateTime: function () {
      const [y, m, d] = TODAY.split('-').map(Number);
      this.getYearLocalTime = () => y;
      this.getMonthLocalTime = () => m;
      this.getDayOfMonthLocalTime = () => d;
    },
  });
  sandbox.data = {};
  sandbox.options = options;
  vm.runInContext(SCRIPT, sandbox);
  return plain(sandbox.data);
}

describe('landing page CO balance', () => {
  test('a closed window is not part of the balance or the next expiry', () => {
    const data = run([ent('2026-11-10'), ent('2026-11-25'), ent('2026-11-20')]);
    assert.equal(data.coBalance, 2);
    assert.equal(data.coNextExpiry, '2026-11-20');
  });

  test('a window closing today still counts: the end date is inclusive', () => {
    const data = run([ent(TODAY)]);
    assert.equal(data.coBalance, 1);
    assert.equal(data.coNextExpiry, TODAY);
  });

  test('only lapsed entitlements reads as nothing outstanding', () => {
    const data = run([ent('2026-11-17')]);
    assert.equal(data.coBalance, 0);
    assert.equal(data.coNextExpiry, '');
  });

  test('used entitlements and other people\'s are not counted', () => {
    const data = run([
      ent('2026-11-25', { u_co_entry: 'day-1' }),
      ent('2026-11-25', { u_user: 'emp-2' }),
    ]);
    assert.equal(data.coBalance, 0);
  });

  test('with CO off the tile is hidden', () => {
    const data = run([ent('2026-11-25')], { enable_co_entitlement: 'false' });
    assert.equal(data.showCoBalance, false);
    assert.equal(data.coBalance, 0);
  });
});
