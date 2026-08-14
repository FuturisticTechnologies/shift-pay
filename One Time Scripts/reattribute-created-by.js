/**
 * One-time re-attribution of sys_created_by / sys_updated_by.
 *
 * Run from ServiceNow Scripts - Background in the **Global** scope (not the
 * Shift Pay app scope): every table it touches except the timesheet table is a
 * global platform table. Review CONFIG before running.
 *
 * Why this exists
 * ---------------
 * The manager-approval schema (approval columns, the day-change audit table,
 * the ShiftPayAggregator Script Include) was created through the REST Table API
 * while authenticated as `reyantech`, an account being retired. `sys_updated_by`
 * has since been corrected by re-touching each record as `admin`, but
 * **`sys_created_by` cannot be set through the Table API** — ServiceNow silently
 * ignores the field and keeps the session user. Verified directly: the PUT
 * returned 200 and the value did not move.
 *
 * The only lever is `autoSysFields(false)`, a GlideRecord method with no REST
 * equivalent, which is why this has to be a background script rather than
 * something the tooling can do.
 *
 *   gr.autoSysFields(false)  stop the platform stamping sys_* on write, so our
 *                            own setValue survives
 *   gr.setWorkflow(false)    stop business rules firing — important on
 *                            sys_dictionary, where they can trigger table work
 *
 * What it does
 * ------------
 * For each table in CONFIG.tables, finds rows with sys_created_by = fromUser
 * and rewrites that field (and sys_updated_by, if also stale) to toUser.
 * Timestamps are deliberately left alone — when a thing was made is still true;
 * only the attribution was wrong.
 *
 * Idempotent: re-running finds nothing and reports zero. Safe to run twice.
 *
 * NOTE: this only rewrites attribution. It does not delete or recreate anything,
 * so no schema is touched and no data is lost.
 */
(function () {
  var CONFIG = {
    dryRun:   true,          // set false to actually write
    fromUser: 'reyantech',   // user_name to replace
    toUser:   'admin',       // user_name to put in its place

    // Deliberately an explicit list. A blanket "everything created by X" sweep
    // across the instance is not something a one-time script should offer.
    tables: [
      'sys_dictionary',
      'sys_choice',
      'sys_db_object',
      'sys_script_include',
      'sp_widget',
      'x_1995110_shift_0_monthly_timesheet',
      'x_1995110_shift_0_shift_day_change'
    ]
  };

  var totalFound = 0;
  var totalWritten = 0;
  var lines = [];

  for (var i = 0; i < CONFIG.tables.length; i++) {
    var table = CONFIG.tables[i];
    var found = 0, written = 0;

    var gr = new GlideRecord(table);
    if (!gr.isValid()) {
      lines.push('SKIP  ' + table + ' — table not found');
      continue;
    }

    // Match on either field so a record stamped by the old account in *any*
    // capacity gets cleaned up in one pass.
    var qc = gr.addQuery('sys_created_by', CONFIG.fromUser);
    qc.addOrCondition('sys_updated_by', CONFIG.fromUser);
    gr.query();

    while (gr.next()) {
      found++;
      var what = describe(gr, table);

      if (!CONFIG.dryRun) {
        gr.autoSysFields(false);   // the whole point: keep our sys_* values
        gr.setWorkflow(false);     // no business rules, no side effects
        if (gr.getValue('sys_created_by') === CONFIG.fromUser) {
          gr.setValue('sys_created_by', CONFIG.toUser);
        }
        if (gr.getValue('sys_updated_by') === CONFIG.fromUser) {
          gr.setValue('sys_updated_by', CONFIG.toUser);
        }
        gr.update();
        written++;
      }
      lines.push('  ' + table + ' :: ' + what);
    }

    totalFound += found;
    totalWritten += written;
    lines.push((found ? 'FOUND ' : 'clean ') + table + ' — ' + found + ' row(s)');
  }

  gs.info('[ShiftPay reattribute] ' + (CONFIG.dryRun ? 'DRY RUN — nothing written' : 'WROTE ' + totalWritten + ' row(s)'));
  gs.info('[ShiftPay reattribute] matched ' + totalFound + ' row(s) for ' + CONFIG.fromUser);
  for (var L = 0; L < lines.length; L++) gs.info('[ShiftPay reattribute] ' + lines[L]);

  if (CONFIG.dryRun) {
    gs.info('[ShiftPay reattribute] Set CONFIG.dryRun = false and re-run to apply.');
  } else {
    gs.info('[ShiftPay reattribute] Done. Re-run to confirm it now reports 0 rows.');
  }

  /** A human-readable handle for the row, so the log is reviewable. */
  function describe(gr, table) {
    var bits = [];
    if (table === 'sys_dictionary') {
      bits.push(gr.getValue('name') + '.' + gr.getValue('element'));
    } else if (table === 'sys_choice') {
      bits.push(gr.getValue('name') + '.' + gr.getValue('element') + ' = ' + gr.getValue('value'));
    } else if (table === 'x_1995110_shift_0_monthly_timesheet') {
      bits.push(gr.getDisplayValue('u_user') + ' ' + gr.getValue('u_year') + '-' + gr.getValue('u_month'));
    } else {
      bits.push(gr.getValue('name') || gr.getUniqueValue());
    }
    bits.push('created_by=' + gr.getValue('sys_created_by'));
    return bits.join('  ');
  }
})();
