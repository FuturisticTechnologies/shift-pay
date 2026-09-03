/**
 * Clear allow_weekend_holiday on the two shift types that should never have
 * carried it.
 * ===========================================================================
 * SP-58 / TC-SP-005. A Saturday currently offers six shift types where
 * README §Business Rules allows four. The rule engine is behaving correctly —
 * ShiftPayCalendarRules.baseAllowedSysIds does exactly what the catalogue tells
 * it. The catalogue is wrong, so this is a data fix and not a code fix.
 *
 * Run this as a **Fix Script** (sys_script_fix), not through Scripts -
 * Background. A fix script carries its scope as a field, so what it will run as
 * can be read back and asserted before anything executes; a background script
 * silently inherits whatever scope the session happens to be in.
 *
 * Idempotent. Re-running reports 0 updated and changes nothing, which makes it
 * safe to use as the standing check that the fix is still in place — a future
 * catalogue import could reintroduce the flags without anyone noticing.
 *
 * Matching is by the semantic columns and the display name together, not by
 * name alone. Names are cosmetic in this application and keying behaviour on
 * them is the exact mistake SP-39 removed; the name is used here only to narrow
 * an already-narrow set, and every candidate is logged before it is touched.
 */
(function fixWeekendShiftFlags() {
  var CATALOG_TABLE = 'u_shift_type_catalog';

  // The two rows README says are weekday-only. Kept as display names because a
  // sys_id differs per instance and this script has to run on more than one.
  var WEEKDAY_ONLY_NAMES = ['L', 'Not Eligible'];

  var DRY_RUN = false;   // flip to true to list candidates without writing

  var log = function (msg) {
    gs.info('[fix-weekend-shift-flags] ' + msg);
    // gs.print is blocked inside a scoped app; pair it with gs.info so the
    // output survives in the syslog either way.
    if (typeof gs.print === 'function') {
      try { gs.print('[fix-weekend-shift-flags] ' + msg); } catch (e) {}
    }
  };

  var examined = 0;
  var updated = 0;

  var gr = new GlideRecord(CATALOG_TABLE);
  gr.addQuery('active', true);
  gr.addQuery('allow_weekend_holiday', true);
  gr.addQuery('name', 'IN', WEEKDAY_ONLY_NAMES.join(','));
  gr.query();

  while (gr.next()) {
    examined++;
    var name = gr.getValue('name');
    var sysId = gr.getUniqueValue();
    var ocRole = gr.getValue('oc_role');

    // Never touch a row that participates in the CO lifecycle. Those are
    // weekday-bound by their own rules and a flag change here would collide
    // with the entitlement window arithmetic.
    if (ocRole && ocRole !== 'none') {
      log('SKIP ' + name + ' (' + sysId + '): oc_role=' + ocRole + ', leaving alone');
      continue;
    }

    log((DRY_RUN ? 'WOULD CLEAR ' : 'CLEARING ') + name + ' (' + sysId +
        '): allow_weekend_holiday true -> false');

    if (!DRY_RUN) {
      gr.setValue('allow_weekend_holiday', false);
      gr.update();
      updated++;
    }
  }

  log('examined ' + examined + ', updated ' + updated +
      (DRY_RUN ? ' (dry run, nothing written)' : ''));
  log('re-run TC-SP-005 to confirm a Saturday now offers four shift types');
})();
