/**
 * One-time re-attribution of sys_created_by / sys_updated_by.
 *
 * Run as a **Fix Script (sys_script_fix) whose Application is Global** — not as
 * a background script. Every table it touches except the timesheet table is a
 * global platform table, and a fix script records the scope on the record
 * itself, so what it will run as is a fact you can read rather than a session
 * setting you have to trust. Review CONFIG before running.
 *
 * Running this in the Shift Pay scope by mistake does more than fail: the
 * platform silently auto-grants the app cross-scope read privileges
 * (sys_scope_privilege rows) for every platform table touched, which then has
 * to be cleaned up. That happened once; hence the insistence.
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

    // ONLY this application's artifacts. sys_dictionary, sys_choice, sp_widget
    // and sys_script_include are instance-wide, so matching on the user alone
    // is a blanket sweep dressed up as an explicit list — the first dry run
    // proved it, offering to rewrite two CAF Compliance widgets, an unrelated
    // Global widget and a "RP VS Sync test" Script Include, one of them
    // authored by rp32s1715 and merely *touched* by reyantech. Retiring an
    // account from ShiftPay is not licence to rewrite authorship on other
    // people's work.
    appScope:    'bbd97549938183507f08f2a0ed03d60b',  // Shift Pay Management
    tablePrefix: 'x_1995110_shift_0',                 // this app's table names

    // The confining key differs by table, and getting it wrong is silent in
    // both directions:
    //   'tablePrefix' — the row's `name` IS a table name. Required for
    //                   sys_dictionary: 36 of its 53 ShiftPay rows carry an
    //                   EMPTY sys_scope (the auto-generated sys_* columns), so
    //                   a scope filter drops them and the fix looks done when
    //                   it is not.
    //   'scope'       — no table name to key on; sys_scope is the only handle.
    //   'none'        — the app's own data tables. They ARE the application;
    //                   there is nothing to confine them to.
    tables: [
      { table: 'sys_dictionary',     match: 'tablePrefix' },
      { table: 'sys_choice',         match: 'tablePrefix' },
      { table: 'sys_db_object',      match: 'tablePrefix' },
      { table: 'sys_script_include', match: 'scope' },
      { table: 'sp_widget',          match: 'scope' },
      { table: 'x_1995110_shift_0_monthly_timesheet', match: 'none' },
      { table: 'x_1995110_shift_0_shift_day_change',  match: 'none' }
    ]
  };

  var totalFound = 0;
  var totalWritten = 0;
  var lines = [];

  for (var i = 0; i < CONFIG.tables.length; i++) {
    var spec  = CONFIG.tables[i];
    var table = spec.table;
    var found = 0, written = 0;

    var gr = new GlideRecord(table);
    if (!gr.isValid()) {
      lines.push('SKIP  ' + table + ' — table not found');
      continue;
    }

    // Confine to this application FIRST, before the user match. Both clauses
    // are ANDed, so the order is only readability — but this is the clause that
    // keeps the sweep out of other people's records, so it reads first.
    var how = spec.match;
    if (how === 'tablePrefix') {
      gr.addQuery('name', 'STARTSWITH', CONFIG.tablePrefix);
    } else if (how === 'scope') {
      gr.addQuery('sys_scope', CONFIG.appScope);
    } else if (how !== 'none') {
      lines.push('SKIP  ' + table + ' — unknown match mode "' + how + '"');
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
    lines.push((found ? 'FOUND ' : 'clean ') + table + ' — ' + found +
               ' row(s)  [confined by ' + how + ']');
  }

  say('[ShiftPay reattribute] ' + (CONFIG.dryRun ? 'DRY RUN — nothing written' : 'WROTE ' + totalWritten + ' row(s)'));
  say('[ShiftPay reattribute] matched ' + totalFound + ' row(s) for ' + CONFIG.fromUser);
  for (var L = 0; L < lines.length; L++) say('[ShiftPay reattribute] ' + lines[L]);

  if (CONFIG.dryRun) {
    say('[ShiftPay reattribute] Set CONFIG.dryRun = false and re-run to apply.');
  } else {
    say('[ShiftPay reattribute] Done. Re-run to confirm it now reports 0 rows.');
  }

  /**
   * Emit to both the results page and the syslog.
   *
   * gs.print echoes onto the page, which is the whole point of a dry run you
   * are meant to read before writing — but it is blocked inside a scoped
   * application ("Function print is not allowed in scope ..."), so it is
   * guarded. gs.info always runs, leaving a durable trail that can be read back
   * with a syslog query even if the page shows nothing.
   */
  function say(msg) {
    try { gs.print(msg); } catch (e) { /* scoped execution: page output unavailable */ }
    gs.info(msg);
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
