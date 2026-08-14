(function () {
  /**
   * Team Timesheet Approvals — Server Script
   * ========================================
   * The manager-facing half of ShiftPay. Lists each direct reportee's timesheet
   * for one month with its shift mix and cost, and lets the manager approve or
   * reject it.
   *
   * Tables (all names configurable via widget options). NOTE the defaults are
   * the real, fully-qualified table names on the instance — the employee widget
   * ships generic `u_`-prefixed defaults that are always overridden by instance
   * options and have therefore never actually run.
   *
   * Month convention matches the calendar widget:
   *   input.month / data.month           →  0-indexed (0 = January)
   *   stored u_month on timesheet/summary →  1-indexed
   *
   * SECURITY. Reportee scoping is enforced on every action, not just on the
   * read. `assertReportee` re-checks the target against the manager hierarchy
   * before any write, because `c.server.get({...})` is callable from the
   * browser with any payload the user cares to type.
   *
   * Scoped app → ES5 only (Rhino): no let/const, arrow functions or template
   * literals in this file.
   */

  var TABLE_LOCK  = options.lock_table       || 'x_1995110_shift_0_monthly_timesheet';
  var TABLE_SUM   = options.summary_table    || 'x_1995110_shift_0_shift_submission_summary';
  var TABLE_CAT   = options.catalog_table    || 'x_1995110_shift_0_shift_type';
  var TABLE_DAY   = options.shift_table      || 'x_1995110_shift_0_u_shift_submission';
  var TABLE_AUDIT = options.audit_table      || 'x_1995110_shift_0_shift_day_change';
  var MANAGER_FIELD = options.manager_field  || 'manager';

  var USER_ID = gs.getUserID();

  // Whether this manager may see money at all. Enforced server-side: when off,
  // amounts are never put on `data`, rather than merely hidden by the template.
  var SHOW_PAY = (options.show_pay_amounts === undefined ||
                  options.show_pay_amounts === '' ||
                  options.show_pay_amounts === null)
                 ? true
                 : (options.show_pay_amounts === true ||
                    options.show_pay_amounts === 'true');

  data.showPay = SHOW_PAY;

  // ── Which month are we showing ───────────────────────────────────────────
  var now = new GlideDateTime();
  data.year  = (input && input.year  != null) ? parseInt(input.year,  10)
                                              : parseInt(now.getYearLocalTime(), 10);
  data.month = (input && input.month != null) ? parseInt(input.month, 10)
                                              : parseInt(now.getMonthLocalTime(), 10) - 1;
  data.monthLabel = monthLabel(data.year, data.month);

  // ── Who reports to me ────────────────────────────────────────────────────
  // Built before any action runs: it is both the queue's row set and the
  // authorisation set every write is checked against.
  var reportees   = loadReportees();
  var reporteeMap = {};
  for (var ri = 0; ri < reportees.length; ri++) reporteeMap[reportees[ri].userId] = true;

  data.canManage      = reportees.length > 0;
  data.reporteeCount  = reportees.length;

  // ── Catalogue (chip colours, names, order) ───────────────────────────────
  var catalogue   = loadCatalogue();
  var catalogById = {};
  for (var ci = 0; ci < catalogue.length; ci++) catalogById[catalogue[ci].sys_id] = catalogue[ci];
  data.shiftCatalogue = catalogue;

  // ── Actions run before the re-read, so the response is already fresh ─────
  data.actionError = '';
  if (input && input.action) handleAction(input);

  // ── Build the queue ──────────────────────────────────────────────────────
  loadQueueInto(data, data.year, data.month);


  // ============================================================ //
  // Action dispatcher                                            //
  // ============================================================ //

  function handleAction(inp) {
    var action = inp.action;
    if (action === 'loadQueue') return;

    if (action === 'approve') {
      actionOne(inp.userId, data.year, data.month, 'approved', inp.comment || '');
    }

    else if (action === 'reject') {
      // A reason is the entire point of a rejection — the employee has to know
      // what to fix. Enforced here, not only in the dialog.
      if (!trim(inp.comment)) {
        fail('A reason is required to reject a timesheet.');
        return;
      }
      actionOne(inp.userId, data.year, data.month, 'rejected', trim(inp.comment));
    }
  }

  /**
   * Approve or reject one timesheet.
   *
   * Every guard runs per row so that the bulk paths (added later) get the same
   * protection for free by looping this rather than writing their own query.
   */
  function actionOne(userId, y, m, newStatus, comment) {
    if (!assertReportee(userId)) return false;

    var gr = new GlideRecord(TABLE_LOCK);
    gr.addQuery('u_user',  userId);
    gr.addQuery('u_year',  y);
    gr.addQuery('u_month', m + 1);
    gr.setLimit(1);
    gr.query();

    if (!gr.next()) {
      fail('That timesheet has not been submitted yet.');
      return false;
    }

    // Only Submitted → Approved / Rejected is legal. Anything else means the
    // screen was stale or the payload was hand-made.
    var current = gr.getValue('status') || 'submitted';
    if (current !== 'submitted') {
      fail('That timesheet is already ' + current + ' and cannot be actioned again.');
      return false;
    }

    gr.setValue('status',          newStatus);
    gr.setValue('approver',        USER_ID);
    gr.setValue('actioned_on',     new GlideDateTime());
    gr.setValue('manager_comment', comment);
    gr.update();
    return true;
  }

  /**
   * The authorisation gate. A manager may only ever touch a direct reportee's
   * timesheet; anything else is refused without saying whether the user exists.
   */
  function assertReportee(userId) {
    if (userId && reporteeMap[userId]) return true;
    fail('You can only action timesheets for your own direct reportees.');
    gs.warn('[ShiftPay] ' + USER_ID + ' attempted to action a non-reportee timesheet (' + userId + ')');
    return false;
  }

  function fail(msg) {
    data.actionError = msg;
    gs.addErrorMessage(msg);
  }


  // ============================================================ //
  // Reads                                                        //
  // ============================================================ //

  function loadReportees() {
    var rows = [];
    var gr = new GlideRecord('sys_user');
    gr.addQuery(MANAGER_FIELD, USER_ID);
    gr.addQuery('active', true);
    gr.orderBy('name');
    gr.query();
    while (gr.next()) {
      var nm = gr.getValue('name') || gr.getValue('user_name') || '';
      rows.push({
        userId:     gr.getUniqueValue(),
        name:       nm,
        initials:   initialsOf(nm),
        employeeId: gr.getValue('employee_number') || '',
        title:      gr.getValue('title') || ''
      });
    }
    return rows;
  }

  function loadCatalogue() {
    var result = [];
    var gr = new GlideRecord(TABLE_CAT);
    gr.addQuery('active', true);
    gr.orderBy('name');
    gr.query();
    while (gr.next()) {
      result.push({
        sys_id:       gr.getUniqueValue(),
        name:         gr.getValue('name')         || '',
        description:  gr.getValue('description')  || '',
        color_hex:    gr.getValue('color_hex')    || '',
        day_category: gr.getValue('day_category') || '',
        rate:         SHOW_PAY ? (gr.getValue('rate') || '0') : null,
        currency:     gr.getValue('currency')     || 'INR'
      });
    }
    return result;
  }

  function loadQueueInto(out, y, m) {
    out.rows = [];
    out.counts = { submitted: 0, approved: 0, rejected: 0, notSubmitted: 0, all: 0 };
    out.totals = { pendingAmount: 0, approvedAmount: 0, currency: 'INR' };
    out.weekdaysInMonth = weekdaysIn(y, m);

    if (!reportees.length) return;

    var ids = [];
    for (var i = 0; i < reportees.length; i++) ids.push(reportees[i].userId);
    var idList = ids.join(',');

    var timesheets = readTimesheets(idList, y, m);
    var summaries  = readSummaries(idList, y, m);
    var coverage   = readCoverage(idList, y, m);

    for (var r = 0; r < reportees.length; r++) {
      var rep = reportees[r];
      var ts  = timesheets[rep.userId] || null;
      var sum = summaries[rep.userId]  || { mix: [], totalShifts: 0, totalAmount: 0, currency: 'INR' };
      var cov = coverage[rep.userId]   || { weekdaysLogged: 0 };

      var status = ts ? ts.status : '';
      var row = {
        userId:         rep.userId,
        name:           rep.name,
        initials:       rep.initials,
        employeeId:     rep.employeeId,
        status:         status,
        statusLabel:    statusLabel(status),
        submittedOn:    ts ? ts.submittedOn : '',
        approver:       ts ? ts.approver : '',
        actionedOn:     ts ? ts.actionedOn : '',
        managerComment: ts ? ts.managerComment : '',
        mix:            sum.mix,
        totalShifts:    sum.totalShifts,
        weekdaysLogged: cov.weekdaysLogged,
        // Only a submitted timesheet is actionable — BR-M1.
        canAction:      status === 'submitted'
      };
      if (SHOW_PAY) {
        row.totalAmount = sum.totalAmount;
        row.currency    = sum.currency;
      }
      out.rows.push(row);

      out.counts.all++;
      if (status === 'submitted')      out.counts.submitted++;
      else if (status === 'approved')  out.counts.approved++;
      else if (status === 'rejected')  out.counts.rejected++;
      else                             out.counts.notSubmitted++;

      if (SHOW_PAY) {
        if (status === 'submitted')     out.totals.pendingAmount  += sum.totalAmount;
        else if (status === 'approved') out.totals.approvedAmount += sum.totalAmount;
        if (sum.currency) out.totals.currency = sum.currency;
      }
    }

    if (!SHOW_PAY) out.totals = null;
  }

  function readTimesheets(idList, y, m) {
    var map = {};
    var gr = new GlideRecord(TABLE_LOCK);
    gr.addQuery('u_user', 'IN', idList);
    gr.addQuery('u_year',  y);
    gr.addQuery('u_month', m + 1);
    gr.query();
    while (gr.next()) {
      map[gr.getValue('u_user')] = {
        sysId:          gr.getUniqueValue(),
        // Rows written before the status column existed read empty; their mere
        // presence used to mean "submitted", so that is what they become.
        status:         gr.getValue('status') || 'submitted',
        submittedOn:    gr.getDisplayValue('u_submitted_on') || '',
        approver:       gr.getDisplayValue('approver') || '',
        actionedOn:     gr.getDisplayValue('actioned_on') || '',
        managerComment: gr.getValue('manager_comment') || ''
      };
    }
    return map;
  }

  /**
   * Monthly aggregates, one query for the whole team.
   *
   * This is the payroll truth: u_rate_snapshot / u_amount were frozen when the
   * month was aggregated, so a catalogue rate change afterwards cannot silently
   * move what the manager is approving.
   */
  function readSummaries(idList, y, m) {
    var map = {};
    var gr = new GlideRecord(TABLE_SUM);
    gr.addQuery('u_user', 'IN', idList);
    gr.addQuery('u_period_type', 'month');
    gr.addQuery('u_year',  y);
    gr.addQuery('u_month', m + 1);
    gr.query();
    while (gr.next()) {
      var uid = gr.getValue('u_user');
      if (!map[uid]) map[uid] = { mix: [], totalShifts: 0, totalAmount: 0, currency: 'INR' };
      var bucket  = map[uid];
      var shiftId = gr.getValue('u_shift_type');
      var cat     = catalogById[shiftId] || {};
      var count   = parseInt(gr.getValue('u_count'), 10) || 0;
      var amount  = parseFloat(gr.getValue('u_amount')) || 0;

      var entry = {
        shiftId:   shiftId,
        name:      cat.name || '(removed shift type)',
        color_hex: cat.color_hex || '',
        count:     count
      };
      if (SHOW_PAY) {
        entry.rate   = gr.getValue('u_rate_snapshot') || '0';
        entry.amount = amount;
      }
      bucket.mix.push(entry);
      bucket.totalShifts += count;
      if (SHOW_PAY) bucket.totalAmount += amount;
      bucket.currency = gr.getValue('u_currency') || bucket.currency;
    }

    // Present the mix in catalogue order so every row's chips line up.
    for (var uid2 in map) map[uid2].mix.sort(byCatalogueOrder);
    return map;
  }

  /**
   * Weekday coverage — "has this person actually filled the month in".
   *
   * One bounded query for the whole team for one month, not a scan per user.
   * It cannot come from the summary, which counts every shift including weekend
   * on-call and so overstates weekday coverage.
   */
  function readCoverage(idList, y, m) {
    var map = {};
    var from = y + '-' + pad(m + 1) + '-01';
    var to   = y + '-' + pad(m + 1) + '-' + pad(daysInMonth(y, m));
    var gr = new GlideRecord(TABLE_DAY);
    gr.addQuery('u_user', 'IN', idList);
    gr.addQuery('u_date', '>=', from);
    gr.addQuery('u_date', '<=', to);
    gr.query();
    while (gr.next()) {
      var uid = gr.getValue('u_user');
      if (!map[uid]) map[uid] = { weekdaysLogged: 0 };
      if (!isWeekend(gr.getValue('u_date'))) map[uid].weekdaysLogged++;
    }
    return map;
  }

  function byCatalogueOrder(a, b) {
    var an = (a.name || '').toLowerCase();
    var bn = (b.name || '').toLowerCase();
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  }


  // ============================================================ //
  // Utilities                                                    //
  // ============================================================ //

  function statusLabel(status) {
    if (status === 'submitted') return 'Submitted';
    if (status === 'approved')  return 'Approved';
    if (status === 'rejected')  return 'Rejected';
    return 'Not submitted';
  }

  function initialsOf(name) {
    if (!name) return '?';
    var parts = name.replace(/\s+/g, ' ').split(' ');
    var first = parts[0] ? parts[0].charAt(0) : '';
    var last  = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
    return (first + last).toUpperCase() || '?';
  }

  function isWeekend(dateKey) {
    if (!dateKey) return false;
    var p = dateKey.split('-');
    var dow = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10)).getDay();
    return dow === 0 || dow === 6;
  }

  function weekdaysIn(y, m) {
    var n = 0, dim = daysInMonth(y, m);
    for (var d = 1; d <= dim; d++) {
      var dow = new Date(y, m, d).getDay();
      if (dow !== 0 && dow !== 6) n++;
    }
    return n;
  }

  function monthLabel(y, m) {
    var names = ['January', 'February', 'March', 'April', 'May', 'June',
                 'July', 'August', 'September', 'October', 'November', 'December'];
    return names[m] + ' ' + y;
  }

  function trim(s) {
    if (s === null || s === undefined) return '';
    return ('' + s).replace(/^\s+|\s+$/g, '');
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

})();
