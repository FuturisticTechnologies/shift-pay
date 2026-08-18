/**
 * Demo data seed for ShiftPay — manager-queue edition.
 * =====================================================
 *
 * Supersedes generate-dummy-shift-data.js, which is kept only for reference.
 * Three things are different here and each was a deliberate fix:
 *
 *   1. NO SEED MARKER IN THE COMMENT. The old script wrote
 *      "Generated dummy shift data (SPM_DUMMY_SHIFT_DATA_2026_06)" into u_comment
 *      on every single day, which is what the employee sees on their own calendar.
 *      Comments here read like something a person would write, and Not Eligible
 *      days carry no comment at all — there is nothing to say about a day you
 *      were not eligible for. Seeded rows are identified by user + date range
 *      instead, which is safe because every user in ROSTER is a demo persona.
 *
 *   2. AGGREGATES GO THROUGH ShiftPayAggregator. The old script carried its own
 *      copy of the weekly/monthly maths. Per CLAUDE.md that is exactly the fork
 *      that must not exist — a second copy of payroll arithmetic that drifts is
 *      a pay bug. This calls the Script Include.
 *
 *   3. IT SEEDS THE MANAGER SIDE. Day rows alone leave the approval queue empty.
 *      This also writes monthly_timesheet rows so the queue has something in it.
 *
 * Scope: ES5 only (Rhino). No let/const/arrow functions/template literals.
 *
 * HOW TO RUN: as a Fix Script (sys_script_fix), not Scripts - Background.
 * A Fix Script carries its scope as a field, so what it will run as can be read
 * back and asserted before anything executes. See CLAUDE.md.
 *
 * DRY_RUN is true by default. Read the log, then flip it.
 */
(function () {

  var CONFIG = {
    dryRun: true,

    managerUserName: 'admin',

    // Everyone who should report to the manager. The first three already do;
    // the last three get their manager field set by this script.
    roster: [
      'melinda.carleton',
      'jewel.agresta',
      'billie.cowley',
      'abel.tuter',
      'amelia.caputo',
      'angelo.ferentz'
    ],

    // Day rows are rewritten for these months only. 2026-04 is deliberately
    // excluded: Melinda's April timesheet is approved and is quoted as baseline
    // in testing/TEST-CASES-SHIFTPAY.md.
    seedMonths: [
      { year: 2026, month: 4 },  // May  (0-indexed)
      { year: 2026, month: 5 },  // June
      { year: 2026, month: 6 }   // July
    ],

    // The demo month — 0-indexed, exactly like seedMonths above. writeTimesheet
    // applies the +1 for storage, so putting 7 here writes AUGUST. That is not a
    // hypothetical: the first run of this script did exactly that, creating six
    // timesheets for a month with no day rows behind them. Guarded below.
    demoMonth: { year: 2026, month: 6 },  // July

    // Exactly one July timesheet is already approved. This matters beyond
    // realism: the manager widget's "Awaiting action" tile is bound to the total
    // row count instead of the submitted count (the deliberate TC-SP-009
    // defect). If every reportee were submitted, both numbers would agree and
    // the defect would stop being visible — the demo and the test would both
    // silently lose their point. Keep at least one row in another state.
    approvedJulyUser: 'melinda.carleton',

    submittedOn: '2026-08-03 09:15:00',
    actionedOn:  '2026-08-05 14:20:00',
    approvalComment: 'Checked against the on-call roster. Approved.',

    // Months given an approved timesheet so the History tab has content.
    historyMonths: [
      { year: 2026, month: 4 },
      { year: 2026, month: 5 }
    ],

    tables: {
      day:         'x_1995110_shift_0_u_shift_submission',
      catalog:     'x_1995110_shift_0_shift_type',
      summary:     'x_1995110_shift_0_shift_submission_summary',
      timesheet:   'x_1995110_shift_0_monthly_timesheet',
      entitlement: 'x_1995110_shift_0_shift_co_entitlement'
    }
  };

  // Comment pools. Index chosen deterministically so a rerun is stable.
  // Not Eligible is absent on purpose — those days get no comment.
  var COMMENTS = {
    UK: ['Worked UK shift', 'UK shift cover', 'UK shift as rostered'],
    US: ['Worked US shift', 'US shift cover', 'US shift as rostered'],
    L:  ['On leave', 'Annual leave', 'Personal leave'],
    OC: ['On-call cover', 'Weekend on-call', 'On-call for the weekend']
  };

  var stats = {
    managersSet: 0, daysInserted: 0, daysUpdated: 0, daysCleared: 0, daysProtected: 0,
    timesheetsInserted: 0, timesheetsUpdated: 0, timesheetsLeftAlone: 0,
    usersAggregated: 0, warnings: []
  };

  // ---------------------------------------------------------------- run ----

  // A timesheet for a month whose days were never seeded gives the manager a
  // queue row that drills into an empty calendar. Cheap to assert, and it is
  // the exact mistake this script made on its first run.
  var demoIsSeeded = false;
  for (var s = 0; s < CONFIG.seedMonths.length; s++) {
    if (CONFIG.seedMonths[s].year === CONFIG.demoMonth.year &&
        CONFIG.seedMonths[s].month === CONFIG.demoMonth.month) demoIsSeeded = true;
  }
  if (!demoIsSeeded) {
    return abort('demoMonth ' + CONFIG.demoMonth.year + '-' + (CONFIG.demoMonth.month + 1) +
      ' is not in seedMonths. Both are 0-indexed. Timesheets would point at a month with no day rows.');
  }

  var manager = findUser(CONFIG.managerUserName);
  if (!manager) return abort('Manager ' + CONFIG.managerUserName + ' not found.');

  var shifts = loadShifts();
  if (!shifts) return;

  var users = [];
  for (var r = 0; r < CONFIG.roster.length; r++) {
    var u = findUser(CONFIG.roster[r]);
    if (!u) { stats.warnings.push('Roster user not found, skipped: ' + CONFIG.roster[r]); continue; }
    if (u.sys_id === manager.sys_id) { stats.warnings.push('Refusing to seed the manager as their own reportee.'); continue; }
    users.push(u);
  }
  if (!users.length) return abort('No roster users resolved.');

  for (var i = 0; i < users.length; i++) {
    ensureManager(users[i], manager);

    // Days that a CO entitlement depends on. Rewriting one would orphan the
    // entitlement row: the granting OC would become a plain shift, or the
    // consuming CO would vanish while the row still claims it was used. The
    // instance's single entitlement (Melinda, OC 2026-06-07 consumed
    // 2026-06-09) sits inside a month this script rewrites, so this is a live
    // hazard rather than a theoretical one, and TC-SP-003 asserts that baseline.
    var protectedDates = loadProtectedDates(users[i]);

    var touched = [];
    for (var m = 0; m < CONFIG.seedMonths.length; m++) {
      touched = touched.concat(
        seedMonth(users[i], CONFIG.seedMonths[m].year, CONFIG.seedMonths[m].month, protectedDates));
    }

    // Insert-only: never restate a decision that already exists. Melinda's May
    // and June are submitted and are quoted as baseline in
    // testing/TEST-CASES-SHIFTPAY.md; flipping them to approved would rewrite
    // recorded test data to make a demo look fuller.
    for (var h = 0; h < CONFIG.historyMonths.length; h++) {
      writeTimesheet(users[i], CONFIG.historyMonths[h].year, CONFIG.historyMonths[h].month,
        'approved', manager, true);
    }

    var isApproved = (users[i].user_name === CONFIG.approvedJulyUser);
    writeTimesheet(users[i], CONFIG.demoMonth.year, CONFIG.demoMonth.month,
      isApproved ? 'approved' : 'submitted', manager);

    recompute(users[i], touched);
  }

  logStats();

  // ----------------------------------------------------------- seeding ----

  /**
   * Rewrite one user-month of day rows. Returns the date keys touched, so the
   * aggregator can be handed the exact set rather than guessing.
   */
  function seedMonth(user, year, month, protectedDates) {
    var dates = [];
    var total = daysInMonth(year, month);

    for (var d = 1; d <= total; d++) {
      var dateKey = year + '-' + pad(month + 1) + '-' + pad(d);
      dates.push(dateKey);

      // Entitlement-bearing day: keep the shift exactly as it is, but still
      // clean the comment, which is the one part of the row that is cosmetic.
      if (protectedDates[dateKey]) {
        stats.daysProtected++;
        setCommentOnly(user, dateKey, protectedDates[dateKey]);
        continue;
      }

      var pick = chooseShift(user, year, month, d);
      if (!pick) { clearDay(user, dateKey); continue; }
      writeDay(user, dateKey, pick.shift, pick.comment);
    }
    return dates;
  }

  /**
   * Every date this user's entitlement rows depend on, mapped to the comment
   * that honestly describes it. Both ends are protected: the OC that granted
   * the right, and the CO that consumed it.
   */
  function loadProtectedDates(user) {
    var map = {};
    var gr = new GlideRecord(CONFIG.tables.entitlement);
    gr.addQuery('u_user', user.sys_id);
    gr.query();
    while (gr.next()) {
      var oc = gr.getValue('oc_date');
      var co = gr.getValue('u_co_date');
      if (oc) map[oc] = 'On-call cover';
      if (co) map[co] = 'Compensatory off';
    }
    return map;
  }

  function setCommentOnly(user, dateKey, comment) {
    var gr = new GlideRecord(CONFIG.tables.day);
    gr.addQuery('u_user', user.sys_id);
    gr.addQuery('u_date', dateKey);
    gr.setLimit(1);
    gr.query();
    if (!gr.next()) return;
    if (CONFIG.dryRun) return;
    gr.setValue('u_comment', comment);
    gr.update();
  }

  /**
   * The weekday mix is weighted towards real work with leave and ineligible
   * days sprinkled in; most weekends are empty, because nobody is on call every
   * single weekend and a calendar that says otherwise does not read as real.
   *
   * L and Not Eligible are placed on weekdays only. Both carry
   * allow_weekend_holiday = true in the catalogue, which is the TC-SP-005
   * finding — seeding weekend leave would be building demo data on top of a
   * known bug.
   *
   * Returns null for "leave this day empty".
   */
  function chooseShift(user, year, month, day) {
    var dow = new Date(year, month, day).getDay();
    var n = hash(user.sys_id + '|' + year + '-' + month + '-' + day);

    if (dow === 0 || dow === 6) {
      // Roughly one weekend day in six is an on-call day.
      if (n % 6 !== 0) return null;
      return { shift: shifts.OC, comment: pickComment('OC', n) };
    }

    var roll = n % 20;
    if (roll === 0 || roll === 1)  return { shift: shifts.L,  comment: pickComment('L', n) };
    if (roll === 2)                return { shift: shifts.NE, comment: '' };  // no comment, by design
    if (roll >= 3 && roll <= 8)    return { shift: shifts.US, comment: pickComment('US', n) };
    return { shift: shifts.UK, comment: pickComment('UK', n) };
  }

  function pickComment(key, n) {
    var pool = COMMENTS[key];
    return pool[n % pool.length];
  }

  function writeDay(user, dateKey, shift, comment) {
    var gr = new GlideRecord(CONFIG.tables.day);
    gr.addQuery('u_user', user.sys_id);
    gr.addQuery('u_date', dateKey);
    gr.setLimit(1);
    gr.query();

    if (gr.next()) {
      if (CONFIG.dryRun) { stats.daysUpdated++; return; }
      gr.setValue('u_shift_type', shift);
      gr.setValue('u_comment', comment);
      gr.update();
      stats.daysUpdated++;
      return;
    }

    if (CONFIG.dryRun) { stats.daysInserted++; return; }
    gr.initialize();
    gr.setValue('u_user', user.sys_id);
    gr.setValue('u_date', dateKey);
    gr.setValue('u_shift_type', shift);
    gr.setValue('u_comment', comment);
    gr.insert();
    stats.daysInserted++;
  }

  function clearDay(user, dateKey) {
    var gr = new GlideRecord(CONFIG.tables.day);
    gr.addQuery('u_user', user.sys_id);
    gr.addQuery('u_date', dateKey);
    gr.query();
    while (gr.next()) {
      stats.daysCleared++;
      if (!CONFIG.dryRun) gr.deleteRecord();
    }
  }

  // -------------------------------------------------------- timesheets ----

  /**
   * One row per user-month, reused rather than duplicated — submitMonth does the
   * same on resubmission, and two rows for one employee-month is a state the
   * widget cannot represent.
   */
  function writeTimesheet(user, year, month, status, manager, insertOnly) {
    var gr = new GlideRecord(CONFIG.tables.timesheet);
    gr.addQuery('u_user', user.sys_id);
    gr.addQuery('u_year', year);
    gr.addQuery('u_month', month + 1); // stored 1-indexed
    gr.setLimit(1);
    gr.query();

    var existing = gr.next();
    if (existing && insertOnly) { stats.timesheetsLeftAlone++; return; }

    if (CONFIG.dryRun) {
      if (existing) stats.timesheetsUpdated++; else stats.timesheetsInserted++;
      return;
    }

    if (!existing) {
      gr.initialize();
      gr.setValue('u_user', user.sys_id);
      gr.setValue('u_year', year);
      gr.setValue('u_month', month + 1);
    }

    gr.setValue('u_submitted_on', CONFIG.submittedOn);
    gr.setValue('status', status);

    if (status === 'approved') {
      gr.setValue('approver', manager.sys_id);
      gr.setValue('actioned_on', CONFIG.actionedOn);
      gr.setValue('manager_comment', CONFIG.approvalComment);
    } else {
      // A submitted month has no decision on it yet.
      gr.setValue('approver', '');
      gr.setValue('actioned_on', '');
      gr.setValue('manager_comment', '');
    }

    if (existing) { gr.update(); stats.timesheetsUpdated++; }
    else          { gr.insert(); stats.timesheetsInserted++; }
  }

  // ------------------------------------------------------------- users ----

  function findUser(userName) {
    var gr = new GlideRecord('sys_user');
    gr.addQuery('user_name', userName);
    gr.addQuery('active', true);
    gr.setLimit(1);
    gr.query();
    if (!gr.next()) return null;
    return { sys_id: gr.getUniqueValue(), user_name: gr.getValue('user_name'), name: gr.getValue('name') };
  }

  function ensureManager(user, manager) {
    var gr = new GlideRecord('sys_user');
    if (!gr.get(user.sys_id)) return;
    if (gr.getValue('manager') === manager.sys_id) return;

    stats.managersSet++;
    if (CONFIG.dryRun) return;
    gr.setValue('manager', manager.sys_id);
    gr.update();
  }

  // ------------------------------------------------------- aggregation ----

  /**
   * Delegated to the Script Include on purpose. Never fork this — see CLAUDE.md.
   */
  function recompute(user, dates) {
    if (!dates.length) return;
    stats.usersAggregated++;
    if (CONFIG.dryRun) return;

    new ShiftPayAggregator({
      userId:       user.sys_id,
      dayTable:     CONFIG.tables.day,
      summaryTable: CONFIG.tables.summary,
      catalogTable: CONFIG.tables.catalog
    }).recompute(dates);
  }

  // --------------------------------------------------------- catalogue ----

  /**
   * Resolved by name for readability, then checked against the semantic columns
   * that actually drive behaviour. Names are cosmetic in this app; if someone
   * has renamed or reconfigured a row, this aborts rather than seeding days that
   * the widget would refuse to display.
   */
  function loadShifts() {
    var wanted = { 'UK': 'UK', 'US': 'US', 'L': 'L', 'Not Eligible': 'NE', 'OC': 'OC' };
    var found = {};

    var gr = new GlideRecord(CONFIG.tables.catalog);
    gr.addQuery('active', true);
    gr.query();
    while (gr.next()) {
      var key = wanted[gr.getValue('name')];
      if (!key) continue;
      found[key] = {
        sys_id: gr.getUniqueValue(),
        weekday: gr.getValue('allow_weekday') === 'true' || gr.getValue('allow_weekday') === '1',
        weekend: gr.getValue('allow_weekend_holiday') === 'true' || gr.getValue('allow_weekend_holiday') === '1',
        ocRole: gr.getValue('oc_role')
      };
    }

    var need = ['UK', 'US', 'L', 'NE', 'OC'];
    for (var i = 0; i < need.length; i++) {
      if (!found[need[i]]) return abort('Missing active catalogue row for ' + need[i] + '.');
      if (found[need[i]].ocRole === 'grants_co' || found[need[i]].ocRole === 'consumes_co') {
        return abort(need[i] + ' carries oc_role ' + found[need[i]].ocRole +
          '. This script seeds plain shifts only and will not create entitlement rows.');
      }
    }
    if (!found.UK.weekday || !found.US.weekday || !found.L.weekday || !found.NE.weekday) {
      return abort('A weekday shift type is not allow_weekday. Catalogue has changed.');
    }
    if (!found.OC.weekend) return abort('OC is not allow_weekend_holiday. Catalogue has changed.');

    return {
      UK: found.UK.sys_id, US: found.US.sys_id, L: found.L.sys_id,
      NE: found.NE.sys_id, OC: found.OC.sys_id
    };
  }

  // ------------------------------------------------------------- utils ----

  /** Deterministic per user+date, so reruns produce the same calendar. */
  function hash(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h = h & h;
    }
    return Math.abs(h);
  }

  function daysInMonth(year, month) { return new Date(year, month + 1, 0).getDate(); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function abort(message) {
    gs.error('[ShiftPay seed] ABORTED: ' + message);
    return null;
  }

  function logStats() {
    gs.info('[ShiftPay seed] ' + (CONFIG.dryRun ? 'DRY RUN — nothing written. ' : 'APPLIED. ') +
      'managersSet=' + stats.managersSet +
      ', daysInserted=' + stats.daysInserted +
      ', daysUpdated=' + stats.daysUpdated +
      ', daysCleared=' + stats.daysCleared +
      ', daysProtected=' + stats.daysProtected +
      ', timesheetsInserted=' + stats.timesheetsInserted +
      ', timesheetsUpdated=' + stats.timesheetsUpdated +
      ', timesheetsLeftAlone=' + stats.timesheetsLeftAlone +
      ', usersAggregated=' + stats.usersAggregated);

    for (var i = 0; i < stats.warnings.length; i++) {
      gs.warn('[ShiftPay seed] ' + stats.warnings[i]);
    }
  }
})();
