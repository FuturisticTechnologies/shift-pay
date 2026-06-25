/**
 * One-time backfill for the data-driven shift semantics migration.
 *
 * Run from ServiceNow Scripts - Background while the Shift Pay application scope
 * is active, AFTER the new columns exist on the shift-type catalogue table:
 *   oc_role               (choice: none | grants_co | consumes_co)
 *   allow_weekday         (true/false)
 *   allow_weekend_holiday (true/false)
 *   day_category          (choice: regular | off | holiday)
 *   color_hex             (string, already present)
 *
 * What it does, for every catalogue row matched by its current `name`:
 * - Sets the four semantic columns to reproduce the old hard-coded behaviour.
 * - Sets color_hex only if currently blank (the soft tint is now derived in
 *   the client script, so only the main colour is stored).
 * Rows whose name is not in the map are left untouched and reported as a warning
 * so nothing is silently missed.
 *
 * Idempotent: safe to re-run. Review CONFIG.dryRun before running for real.
 */
(function () {
  var CONFIG = {
    dryRun: true,                                   // set false to actually write
    catalogTable: 'x_1995110_shift_0_shift_type',
    onlyActive: false                               // backfill inactive rows too
  };

  // name -> semantics + seed colour (mirrors the pre-migration hard-coded maps).
  var MAP = {
    'UK':           { oc_role: 'none',        weekday: true,  weekend: false, category: 'regular', color: '#1E3A8A' },
    'US':           { oc_role: 'none',        weekday: true,  weekend: false, category: 'regular', color: '#B45309' },
    'L':            { oc_role: 'none',        weekday: true,  weekend: true,  category: 'off',     color: '#15803D' },
    'Not Eligible': { oc_role: 'none',        weekday: true,  weekend: true,  category: 'off',     color: '#64748B' },
    'OC':           { oc_role: 'none',        weekday: false, weekend: true,  category: 'holiday', color: '#7C3AED' },
    'CO':           { oc_role: 'consumes_co', weekday: true,  weekend: false, category: 'holiday', color: '#0E7490' },
    'OC + CO':      { oc_role: 'grants_co',   weekday: false, weekend: true,  category: 'holiday', color: '#9333EA' },
    'OC + UK + CO': { oc_role: 'grants_co',   weekday: false, weekend: true,  category: 'holiday', color: '#4338CA' },
    'OC + US + CO': { oc_role: 'grants_co',   weekday: false, weekend: true,  category: 'holiday', color: '#A16207' }
  };

  var stats = { matched: 0, updated: 0, skipped: 0, colorsSet: 0, warnings: [] };

  var gr = new GlideRecord(CONFIG.catalogTable);
  if (CONFIG.onlyActive && gr.isValidField('active')) gr.addQuery('active', true);
  gr.query();
  while (gr.next()) {
    var name = gr.getValue('name') || '';
    var spec = MAP[name];
    if (!spec) {
      stats.warnings.push('No mapping for shift type "' + name + '" (' + gr.getUniqueValue() + ') — left untouched.');
      stats.skipped++;
      continue;
    }
    stats.matched++;

    gr.setValue('oc_role',               spec.oc_role);
    gr.setValue('allow_weekday',         spec.weekday);
    gr.setValue('allow_weekend_holiday', spec.weekend);
    gr.setValue('day_category',          spec.category);

    if (!(gr.getValue('color_hex') || '')) {
      gr.setValue('color_hex', spec.color);
      stats.colorsSet++;
    }

    if (CONFIG.dryRun) {
      gs.info('[ShiftPay backfill][dryRun] would update "' + name + '" -> ' +
        spec.oc_role + ', weekday=' + spec.weekday + ', weekend=' + spec.weekend +
        ', category=' + spec.category);
    } else {
      gr.update();
      stats.updated++;
    }
  }

  gs.info('[ShiftPay backfill] dryRun=' + CONFIG.dryRun +
    ', matched=' + stats.matched +
    ', updated=' + stats.updated +
    ', colorsSet=' + stats.colorsSet +
    ', skipped=' + stats.skipped);
  for (var i = 0; i < stats.warnings.length; i++) {
    gs.warn('[ShiftPay backfill] ' + stats.warnings[i]);
  }
})();
