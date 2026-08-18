/**
 * Replace the old dummy-seed marker comments with something a person would write.
 * ==============================================================================
 *
 * generate-dummy-shift-data.js stamped every day it created with
 *
 *     Generated dummy shift data (SPM_DUMMY_SHIFT_DATA_2026_06)
 *
 * and u_comment is the employee's own note, shown on their calendar. So the
 * marker is visible in the demo, on every seeded day, including admin's — which
 * is the account the employee-calendar walkthrough runs on.
 *
 * seed-demo-data.js fixed this for the months and users it rewrites. This sweeps
 * up what it does not touch: admin's whole calendar, and Melinda's April, which
 * is deliberately excluded there because her April timesheet is approved and is
 * quoted as baseline in testing/TEST-CASES-SHIFTPAY.md.
 *
 * SAFETY: this writes u_comment and nothing else. No shift type is changed, no
 * row is inserted or deleted, no aggregate moves. Comments carry no behaviour —
 * nothing in the widgets or the Script Includes branches on u_comment — so the
 * worst case is wrong wording, fixed by editing the map and running again.
 *
 * Scope: ES5 only (Rhino). Run as a Fix Script, not Scripts - Background.
 */
(function () {

  var CONFIG = {
    dryRun: false,
    marker: 'SPM_DUMMY',
    dayTable:     'x_1995110_shift_0_u_shift_submission',
    catalogTable: 'x_1995110_shift_0_shift_type'
  };

  /**
   * Keyed on catalogue name purely for readability — this is a cosmetic sweep,
   * so a rename costs a wrong sentence, not wrong behaviour. Anything not listed
   * falls through to bySemantics() below.
   *
   * "Not Eligible" maps to empty on purpose. There is nothing to say about a day
   * you were not eligible to log.
   */
  var BY_NAME = {
    'UK':           'Worked UK shift',
    'US':           'Worked US shift',
    'L':            'On leave',
    'Not Eligible': '',
    'OC':           'On-call cover',
    'CO':           'Compensatory off'
  };

  var stats = { scanned: 0, updated: 0, cleared: 0, unchanged: 0, noShift: 0 };

  var catalog = loadCatalog();

  var gr = new GlideRecord(CONFIG.dayTable);
  gr.addQuery('u_comment', 'CONTAINS', CONFIG.marker);
  gr.query();

  while (gr.next()) {
    stats.scanned++;

    var shiftId = gr.getValue('u_shift_type');
    if (!shiftId || !catalog[shiftId]) {
      // A commented day with no resolvable shift type. Leave it alone rather
      // than invent a description of work that may not have happened.
      stats.noShift++;
      continue;
    }

    var comment = commentFor(catalog[shiftId]);
    if (comment === gr.getValue('u_comment')) { stats.unchanged++; continue; }

    if (comment === '') stats.cleared++; else stats.updated++;
    if (CONFIG.dryRun) continue;

    gr.setValue('u_comment', comment);
    gr.update();
  }

  gs.info('[ShiftPay comment sweep] ' + (CONFIG.dryRun ? 'DRY RUN — nothing written. ' : 'APPLIED. ') +
    'scanned=' + stats.scanned +
    ', updated=' + stats.updated +
    ', cleared=' + stats.cleared +
    ', unchanged=' + stats.unchanged +
    ', noShiftType=' + stats.noShift);

  function commentFor(row) {
    if (BY_NAME.hasOwnProperty(row.name)) return BY_NAME[row.name];
    return bySemantics(row);
  }

  /**
   * Fallback for catalogue rows the map does not name — the compound OC types,
   * and anything added later. Semantics, not the name, decide.
   */
  function bySemantics(row) {
    if (row.ocRole === 'grants_co')   return 'On-call cover';
    if (row.ocRole === 'consumes_co') return 'Compensatory off';
    if (row.dayCategory === 'off')    return '';
    if (row.dayCategory === 'holiday') return 'On-call cover';
    return 'Worked ' + row.name + ' shift';
  }

  function loadCatalog() {
    var map = {};
    var c = new GlideRecord(CONFIG.catalogTable);
    c.query(); // active and inactive: a logged day may reference a retired type
    while (c.next()) {
      map[c.getUniqueValue()] = {
        name:        c.getValue('name'),
        ocRole:      c.getValue('oc_role'),
        dayCategory: c.getValue('day_category')
      };
    }
    return map;
  }
})();
