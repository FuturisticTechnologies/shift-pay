/**
 * One-time re-attribution of sys_created_by / sys_updated_by across the whole
 * application, keyed on sys_metadata rather than a hand-written table list.
 *
 * Run as a **Fix Script (sys_script_fix) whose Application is Global** — not as
 * a background script. The reason outlived the script that taught it: a
 * background script inherits the session scope silently, and running this in
 * the Shift Pay scope makes the platform auto-grant the app cross-scope read
 * privileges (sys_scope_privilege rows) for every platform table touched.
 * Two such rows are still sitting in this app's scope from the last time that
 * happened; this script re-attributes them, it does not delete them.
 *
 * Why this exists — the sequel
 * ----------------------------
 * The first pass (15 Aug 2026, since deleted) listed seven tables by hand:
 * sys_dictionary, sys_choice, sys_db_object, sys_script_include, sp_widget and
 * the two app data tables. Those seven were left clean, and re-running it
 * reported 0 — which is exactly why it looked finished. It was not. An
 * application file is any row on a table extending **sys_metadata**, and the
 * app owns nine further classes the list never mentioned:
 *
 *     sys_documentation (17)   field labels
 *     sys_app_module (7)       application-menu modules
 *     sys_choice_set (3)       choice sets behind the semantic columns
 *     sys_scope_privilege (2)  the cross-scope grants noted above
 *     sys_script_fix (2)       the earlier one-time scripts themselves
 *     sys_ui_list (2)          list layouts
 *     sp_instance (1)          the calendar widget's portal placement
 *     sys_ui_form (1)          form layout
 *     ua_table_licensing_config (1)
 *
 * 36 rows in total, all stamped `reyantech`; 29 of them created AND updated by
 * it, 7 created by admin and merely touched. Enumerating classes by hand is
 * what produced the gap, so this script does not enumerate them: it queries the
 * sys_metadata base table and lets the scope do the confining. Any class added
 * to the app later is covered without editing this file.
 *
 * The lever is still autoSysFields(false) — sys_created_by cannot be set over
 * the Table API; the PUT returns 200 and the value does not move.
 *
 * What it does
 * ------------
 * Phase 1  sys_metadata WHERE sys_scope = the app — every application file,
 *          whatever its class. Rows are collected first and written second, so
 *          each write goes through a GlideRecord on the row's *real* class
 *          (the field list and ACLs on sys_metadata are not the child's).
 * Phase 2  sys_dictionary / sys_choice / sys_db_object keyed on `name
 *          STARTSWITH x_1995110_shift_0`. These extend sys_metadata but 36 of
 *          the app's 53 dictionary rows (the auto-generated sys_* columns)
 *          carry an EMPTY sys_scope, so phase 1 cannot see them. Currently
 *          clean; kept so this script stands alone.
 * Phase 3  the app's own data tables. They ARE the application — nothing to
 *          confine them to.
 *
 * Timestamps are left alone: when a thing was made is still true, only the
 * attribution was wrong. Idempotent — re-running reports 0.
 */
(function () {
  var CONFIG = {
    dryRun:   true,          // set false to actually write
    fromUser: 'reyantech',   // user_name to replace
    toUser:   'admin',       // user_name to put in its place

    appScope:    'bbd97549938183507f08f2a0ed03d60b',  // Shift Pay Management
    tablePrefix: 'x_1995110_shift_0',                 // this app's table names

    // Phase 2. Confined by `name`, not sys_scope — see header.
    prefixTables: ['sys_dictionary', 'sys_choice', 'sys_db_object'],

    // Phase 3.
    dataTables: [
      'x_1995110_shift_0_monthly_timesheet',
      'x_1995110_shift_0_shift_day_change'
    ]
  };

  var seen = {};             // sys_id -> true, so a row is never counted twice
  var totalFound = 0, totalWritten = 0;
  var lines = [];

  // ---- phase 1: every application file in the scope, class-agnostic --------
  //
  // sys_metadata_delete is excluded deliberately. Its rows are tombstones for
  // things already deleted; rewriting who deleted what would be a lie, and the
  // records they refer to are gone anyway.
  var meta = new GlideRecord('sys_metadata');
  meta.addQuery('sys_scope', CONFIG.appScope);
  meta.addQuery('sys_class_name', '!=', 'sys_metadata_delete');
  var mq = meta.addQuery('sys_created_by', CONFIG.fromUser);
  mq.addOrCondition('sys_updated_by', CONFIG.fromUser);
  meta.query();

  // Collect before writing. Updating rows while the cursor that produced them
  // is still open is asking for a partial pass, and the write has to happen on
  // the child class anyway, which needs a second GlideRecord regardless.
  var targets = [];
  while (meta.next()) {
    targets.push({
      sysId: meta.getUniqueValue(),
      cls:   meta.getValue('sys_class_name'),
      name:  meta.getValue('sys_name') || '(unnamed)'
    });
  }

  var byClass = {};
  for (var t = 0; t < targets.length; t++) {
    var tgt = targets[t];
    if (seen[tgt.sysId]) continue;
    seen[tgt.sysId] = true;
    totalFound++;
    byClass[tgt.cls] = (byClass[tgt.cls] || 0) + 1;

    // Open the row on its real class. sys_metadata is the base table, so a
    // GlideRecord on it can read every row — but writing through the child
    // class is what a human editing the record would do, and keeps the child's
    // own field list and ACLs in the picture.
    var child = new GlideRecord(tgt.cls);
    if (!child.isValid() || !child.get(tgt.sysId)) {
      lines.push('  SKIP  ' + tgt.cls + ' :: ' + tgt.name +
                 ' — cannot open on its own class (' + tgt.sysId + ')');
      continue;
    }

    var before = child.getValue('sys_created_by') + ' / ' + child.getValue('sys_updated_by');
    if (!CONFIG.dryRun) {
      if (rewrite(child)) totalWritten++;
    }
    lines.push('  ' + tgt.cls + ' :: ' + tgt.name + '  [' + before + ']');
  }

  var classNames = [];
  for (var k in byClass) if (byClass.hasOwnProperty(k)) classNames.push(k + '=' + byClass[k]);
  classNames.sort();
  lines.push('PHASE 1  sys_metadata in scope — ' + totalFound + ' row(s): ' +
             (classNames.length ? classNames.join(', ') : 'none'));

  // ---- phase 2 and 3: the keys sys_metadata cannot express -----------------
  sweep(CONFIG.prefixTables, 'tablePrefix');
  sweep(CONFIG.dataTables,   'none');

  say('[ShiftPay reattribute/meta] ' +
      (CONFIG.dryRun ? 'DRY RUN — nothing written' : 'WROTE ' + totalWritten + ' row(s)'));
  say('[ShiftPay reattribute/meta] matched ' + totalFound + ' row(s) for ' + CONFIG.fromUser);
  for (var L = 0; L < lines.length; L++) say('[ShiftPay reattribute/meta] ' + lines[L]);
  say('[ShiftPay reattribute/meta] ' + (CONFIG.dryRun
      ? 'Set CONFIG.dryRun = false and re-run to apply.'
      : 'Done. Re-run to confirm it now reports 0 rows.'));

  /** Phases 2 and 3: tables queried directly, because their key is not sys_scope. */
  function sweep(tables, how) {
    for (var i = 0; i < tables.length; i++) {
      var table = tables[i];
      var found = 0;

      var gr = new GlideRecord(table);
      if (!gr.isValid()) {
        lines.push('SKIP  ' + table + ' — table not found');
        continue;
      }
      if (how === 'tablePrefix') gr.addQuery('name', 'STARTSWITH', CONFIG.tablePrefix);
      var qc = gr.addQuery('sys_created_by', CONFIG.fromUser);
      qc.addOrCondition('sys_updated_by', CONFIG.fromUser);
      gr.query();

      while (gr.next()) {
        if (seen[gr.getUniqueValue()]) continue;   // already done in phase 1
        seen[gr.getUniqueValue()] = true;
        found++;
        totalFound++;
        var label = (gr.getValue('name') || gr.getUniqueValue()) +
                    '  [' + gr.getValue('sys_created_by') + ' / ' + gr.getValue('sys_updated_by') + ']';
        if (!CONFIG.dryRun) {
          if (rewrite(gr)) totalWritten++;
        }
        lines.push('  ' + table + ' :: ' + label);
      }
      lines.push((found ? 'FOUND ' : 'clean ') + table + ' — ' + found +
                 ' row(s)  [confined by ' + how + ']');
    }
  }

  /**
   * The actual write.
   *
   *   autoSysFields(false)  stop the platform stamping sys_* on write, so our
   *                         own setValue survives — this is the only lever that
   *                         moves sys_created_by, and it has no REST equivalent
   *   setWorkflow(false)    no business rules; important on dictionary-adjacent
   *                         tables where they can trigger real table work
   */
  function rewrite(gr) {
    gr.autoSysFields(false);
    gr.setWorkflow(false);
    if (gr.getValue('sys_created_by') === CONFIG.fromUser) {
      gr.setValue('sys_created_by', CONFIG.toUser);
    }
    if (gr.getValue('sys_updated_by') === CONFIG.fromUser) {
      gr.setValue('sys_updated_by', CONFIG.toUser);
    }
    return !!gr.update();
  }

  /**
   * Emit to both the results page and the syslog. gs.print is blocked inside a
   * scoped app, so it is guarded; gs.info always runs and leaves a trail that
   * survives even when the page shows nothing.
   */
  function say(msg) {
    try { gs.print(msg); } catch (e) { /* scoped execution: page output unavailable */ }
    gs.info(msg);
  }
})();
