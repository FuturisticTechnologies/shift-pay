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
   * Shared logic. Nothing about shift rules or pay is reimplemented here:
   *   ShiftPayCalendarRules  what a reportee may legally log on a date
   *   ShiftPayEntitlements   the CO lifecycle (obtained via the rules object)
   *   ShiftPayAggregator     weekly/monthly totals with the rate snapshot
   * All three are parameterised by user, which is what makes a manager able to
   * act on a reportee at all. Forking any of them would let the two screens
   * disagree about someone's pay.
   *
   * Scoped app → ES5 only (Rhino): no let/const, arrow functions or template
   * literals in this file.
   */

  var TABLE_LOCK  = options.lock_table       || 'x_1995110_shift_0_monthly_timesheet';
  var TABLE_SUM   = options.summary_table    || 'x_1995110_shift_0_shift_submission_summary';
  var TABLE_CAT   = options.catalog_table    || 'x_1995110_shift_0_shift_type';
  var TABLE_DAY   = options.shift_table      || 'x_1995110_shift_0_u_shift_submission';
  var TABLE_AUDIT = options.audit_table      || 'x_1995110_shift_0_shift_day_change';
  var TABLE_ENT   = options.entitlement_table || 'x_1995110_shift_0_shift_co_entitlement';
  var MANAGER_FIELD = options.manager_field  || 'manager';

  var USER_ID = gs.getUserID();

  // Must match the employee calendar's option of the same name: a correction
  // applies the identical entitlement rules the employee was held to, and the
  // two screens disagreeing about whether CO exists would be worse than either
  // setting on its own.
  var CO_ENABLED = (options.enable_co_entitlement === undefined ||
                    options.enable_co_entitlement === '' ||
                    options.enable_co_entitlement === null)
                   ? true
                   : (options.enable_co_entitlement === true ||
                      options.enable_co_entitlement === 'true');

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
  // Read through ShiftPayCalendarRules, the same class the employee calendar
  // uses, so a correction is judged against exactly the rules the employee was
  // offered. The catalogue is user-independent, so it is read once here and
  // handed to each per-reportee rules object below.
  var CATALOGUE_RULES = new ShiftPayCalendarRules({
    catalogTable: TABLE_CAT,
    coEnabled:    CO_ENABLED
  });
  var catalogue   = CATALOGUE_RULES.catalogue();
  var catalogById = CATALOGUE_RULES.catalogById();
  data.shiftCatalogue = projectCatalogue(catalogue);
  data.configError    = CATALOGUE_RULES.configError();

  // ── Actions run before the re-read, so the response is already fresh ─────
  data.actionError = '';
  data.detail = null;   // populated only by the loadDetail action
  if (input && input.action) handleAction(input);

  // ── Build the queue ──────────────────────────────────────────────────────
  loadQueueInto(data, data.year, data.month);


  // ============================================================ //
  // Action dispatcher                                            //
  // ============================================================ //

  function handleAction(inp) {
    var action = inp.action;
    if (action === 'loadQueue') return;

    if (action === 'loadDetail') {
      // Read-only drill-in. Still gated: a manager may not read a
      // non-reportee's day-by-day detail any more than they may action it.
      if (!assertReportee(inp.userId)) return;
      data.detail = readDetail(inp.userId, data.year, data.month);
      return;
    }

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

    else if (action === 'correctDay') {
      correctDay(inp);
      // Re-read the panel the manager is looking at, whether or not the write
      // succeeded: on success it shows the new day and the new totals, on
      // failure it shows that nothing moved.
      if (reporteeMap[inp.userId]) {
        data.detail = readDetail(inp.userId, data.year, data.month);
      }
    }
  }

  /**
   * Change or clear one day of a reportee's submitted timesheet.
   *
   * The manager's most dangerous action: it rewrites someone else's pay. Every
   * guard below is server-side because `c.server.get({...})` is callable from
   * the browser with any payload, and the client's dropdown filtering is a
   * convenience, not a control.
   *
   * Passing an empty `shift` clears the day.
   */
  function correctDay(inp) {
    var userId = inp.userId;
    var date   = trim(inp.date);
    var reason = trim(inp.reason);
    // '' means clear. Normalised to null so the entitlement class picks the
    // "Cannot clear" wording rather than "Cannot change this entry".
    var newShift = trim(inp.shift) || null;

    if (!assertReportee(userId)) return false;

    // A correction to someone else's pay without a stated reason is unauditable.
    if (!reason) {
      fail('A reason is required to correct a day.');
      return false;
    }

    // The date must belong to the month on screen. Without this a hand-made
    // payload could edit a month whose status was never checked.
    if (!isDateInMonth(date, data.year, data.month)) {
      fail('That date is not in ' + data.monthLabel + '.');
      return false;
    }

    // BR-M12 / design decision 3: only a submitted month is the manager's to
    // correct. Approved is final, rejected is back with the employee, and a
    // month never submitted has nothing to correct.
    var ts = readTimesheets(userId, data.year, data.month)[userId] || null;
    var status = ts ? ts.status : '';
    if (status !== 'submitted') {
      fail(status === 'approved'
        ? 'That timesheet is already approved and can no longer be corrected.'
        : (status === 'rejected'
            ? 'That timesheet was rejected and is back with the employee to fix.'
            : 'That timesheet has not been submitted yet.'));
      return false;
    }

    // The reportee's own rule set — their entitlements, not the manager's.
    var rules = rulesFor(userId);
    var ent   = rules.entitlements();

    if (newShift && !rules.isValidShift(newShift)) {
      fail('That is not an active shift type.');
      return false;
    }

    // The correction must be a shift the employee could legally have logged
    // themselves: weekday/weekend role, the allow_* flags, and for CO an open
    // entitlement window. A manager may fix a mistake, not mint an exception.
    if (newShift && !rules.isAllowedOn(date, newShift)) {
      fail('That shift type is not allowed on ' + date + ' for this employee.');
      return false;
    }

    var prevShift = getDayShift(userId, date);
    if (prevShift === newShift || (!prevShift && !newShift)) {
      fail('That day already reads as requested — nothing to correct.');
      return false;
    }

    // ── The three-phase day change, bracketing the write ──
    // The entitlement decision has to be made before the row exists and
    // recorded after it does, so these three calls cannot be collapsed.
    var released = ent.releasePrevious(date, prevShift, newShift);
    if (!released.ok) {
      fail(released.error);
      return false;
    }

    var reserved = ent.reserveForNew(date, newShift, prevShift);
    if (!reserved.ok) {
      fail(reserved.error);
      return false;
    }

    var entrySysId = newShift ? upsertDay(userId, date, newShift) : null;
    if (!newShift) deleteDay(userId, date);

    ent.commitForNew(date, newShift, prevShift, entrySysId, reserved.entitlementId);

    // Audit before aggregating: if the recompute were to fail, the record of
    // who changed what still exists.
    writeAudit(userId, date, prevShift, newShift, reason);

    // Aggregates are recomputed, never incremented — and for the reportee, which
    // is the whole reason ShiftPayAggregator is parameterised by user.
    new ShiftPayAggregator({
      userId:       userId,
      dayTable:     TABLE_DAY,
      summaryTable: TABLE_SUM,
      catalogTable: TABLE_CAT
    }).recompute([date]);

    gs.addInfoMessage('Corrected ' + date + '.');
    return true;
  }

  /** A rules object scoped to one reportee, reusing the single catalogue read. */
  function rulesFor(userId) {
    return new ShiftPayCalendarRules({
      userId:           userId,
      catalogue:        catalogue,
      catalogTable:     TABLE_CAT,
      entitlementTable: TABLE_ENT,
      coEnabled:        CO_ENABLED
    });
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
  // Writes                                                       //
  // ============================================================ //

  function getDayShift(userId, date) {
    var gr = new GlideRecord(TABLE_DAY);
    gr.addQuery('u_user', userId);
    gr.addQuery('u_date', date);
    gr.setLimit(1);
    gr.query();
    return gr.next() ? gr.getValue('u_shift_type') : null;
  }

  /**
   * Set the shift on one day, leaving u_comment alone.
   *
   * The comment is the employee's own note. A manager correcting the shift type
   * has no business rewriting it, and the reason for the correction is captured
   * in the audit row instead.
   */
  function upsertDay(userId, date, shift) {
    var gr = new GlideRecord(TABLE_DAY);
    gr.addQuery('u_user', userId);
    gr.addQuery('u_date', date);
    gr.setLimit(1);
    gr.query();
    if (gr.next()) {
      gr.setValue('u_shift_type', shift);
      gr.update();
      return gr.getUniqueValue();
    }
    gr.initialize();
    gr.setValue('u_user',       userId);
    gr.setValue('u_date',       date);
    gr.setValue('u_shift_type', shift);
    return gr.insert();
  }

  function deleteDay(userId, date) {
    var gr = new GlideRecord(TABLE_DAY);
    gr.addQuery('u_user', userId);
    gr.addQuery('u_date', date);
    gr.query();
    while (gr.next()) gr.deleteRecord();
  }

  /**
   * One audit row per correction: who changed which day, from what to what, and
   * why. The employee sees this on their calendar and the manager sees it in the
   * review panel — a silent edit to someone's pay is the thing this prevents.
   */
  function writeAudit(userId, date, prevShift, newShift, reason) {
    var gr = new GlideRecord(TABLE_AUDIT);
    gr.initialize();
    gr.setValue('user',           userId);
    gr.setValue('date',           date);
    gr.setValue('previous_shift', prevShift || '');
    gr.setValue('new_shift',      newShift  || '');
    gr.setValue('reason',         reason);
    gr.setValue('changed_by',     USER_ID);
    gr.setValue('changed_on',     new GlideDateTime());
    gr.insert();
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

  /**
   * The catalogue as the client needs it — chip colours, names, grouping.
   *
   * Rates are stripped rather than hidden when show_pay_amounts is off: a
   * manager who may not see money must not receive it on `data` either.
   */
  function projectCatalogue(rows) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      out.push({
        sys_id:       r.sys_id,
        name:         r.name,
        description:  r.description,
        color_hex:    r.color_hex,
        day_category: r.day_category,
        rate:         SHOW_PAY ? r.rate : null,
        currency:     r.currency
      });
    }
    return out;
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

  /**
   * Everything behind the Review button for one reportee-month.
   *
   * Read-only. The money here is the same snapshot the queue shows — weekly
   * rows come from the summary table too, so the weekly split and the monthly
   * total cannot disagree with each other or with what gets exported.
   */
  function readDetail(userId, y, m) {
    var rep = null;
    for (var i = 0; i < reportees.length; i++) {
      if (reportees[i].userId === userId) { rep = reportees[i]; break; }
    }
    if (!rep) return null;

    var ts = readTimesheets(userId, y, m)[userId] || null;
    var status = ts ? ts.status : '';

    var detail = {
      userId:         rep.userId,
      name:           rep.name,
      initials:       rep.initials,
      employeeId:     rep.employeeId,
      year:           y,
      month:          m,
      monthLabel:     monthLabel(y, m),
      status:         status,
      statusLabel:    statusLabel(status),
      submittedOn:    ts ? ts.submittedOn : '',
      approver:       ts ? ts.approver : '',
      actionedOn:     ts ? ts.actionedOn : '',
      managerComment: ts ? ts.managerComment : '',
      canAction:      status === 'submitted',
      // Day corrections are limited to a submitted month, same rule as actioning.
      canEditDays:    status === 'submitted',
      weekdaysInMonth: weekdaysIn(y, m),
      weekdaysLogged:  0,
      days:     {},
      comments: [],
      ledger:   [],
      weeks:    [],
      changes:  [],
      // What this employee could legally log on each day of the month — the
      // reportee's own entitlement windows, not the manager's. The correction
      // dropdown filters on this; the server re-checks it on the write.
      allowedShifts: rulesFor(userId).allowedForMonth(y, m)
    };

    // ── day entries + the employee's own comments ──
    var from = y + '-' + pad(m + 1) + '-01';
    var to   = y + '-' + pad(m + 1) + '-' + pad(daysInMonth(y, m));
    var gr = new GlideRecord(TABLE_DAY);
    gr.addQuery('u_user', userId);
    gr.addQuery('u_date', '>=', from);
    gr.addQuery('u_date', '<=', to);
    gr.orderBy('u_date');
    gr.query();
    while (gr.next()) {
      var dk      = gr.getValue('u_date');
      var shiftId = gr.getValue('u_shift_type');
      var cat     = catalogById[shiftId] || {};
      detail.days[dk] = {
        shiftId:   shiftId,
        name:      cat.name || '(removed)',
        color_hex: cat.color_hex || '',
        comment:   gr.getValue('u_comment') || ''
      };
      if (!isWeekend(dk)) detail.weekdaysLogged++;
      var cmt = gr.getValue('u_comment');
      if (cmt) detail.comments.push({ date: dk, text: cmt });
    }

    // ── monthly ledger: count x snapshot rate = amount, per shift type ──
    var monthly = readSummaries(userId, y, m)[userId];
    if (monthly) {
      detail.ledger      = monthly.mix;
      detail.totalShifts = monthly.totalShifts;
      if (SHOW_PAY) {
        detail.totalAmount = monthly.totalAmount;
        detail.currency    = monthly.currency;
      }
    } else {
      detail.totalShifts = 0;
      if (SHOW_PAY) { detail.totalAmount = 0; detail.currency = 'INR'; }
    }

    // ── weekly split, from the same snapshotted summary rows ──
    var wk = new GlideRecord(TABLE_SUM);
    wk.addQuery('u_user', userId);
    wk.addQuery('u_period_type', 'week');
    wk.addQuery('u_year',  y);
    wk.addQuery('u_month', m + 1);
    wk.orderBy('u_period_start');
    wk.query();
    var weekMap = {}, weekOrder = [];
    while (wk.next()) {
      var ps = wk.getValue('u_period_start');
      if (!weekMap[ps]) {
        weekMap[ps] = { periodStart: ps, count: 0, amount: 0 };
        weekOrder.push(ps);
      }
      weekMap[ps].count += parseInt(wk.getValue('u_count'), 10) || 0;
      if (SHOW_PAY) weekMap[ps].amount += parseFloat(wk.getValue('u_amount')) || 0;
    }
    for (var w = 0; w < weekOrder.length; w++) {
      var row = weekMap[weekOrder[w]];
      if (!SHOW_PAY) row.amount = null;
      detail.weeks.push(row);
    }

    // ── manager corrections already made to this month ──
    var au = new GlideRecord(TABLE_AUDIT);
    au.addQuery('user', userId);
    au.addQuery('date', '>=', from);
    au.addQuery('date', '<=', to);
    au.orderByDesc('changed_on');
    au.query();
    while (au.next()) {
      var pv = catalogById[au.getValue('previous_shift')] || {};
      var nv = catalogById[au.getValue('new_shift')]      || {};
      detail.changes.push({
        date:      au.getValue('date'),
        fromName:  pv.name || '(empty)',
        fromColor: pv.color_hex || '',
        toName:    nv.name || '(cleared)',
        toColor:   nv.color_hex || '',
        reason:    au.getValue('reason') || '',
        changedBy: au.getDisplayValue('changed_by') || '',
        changedOn: au.getDisplayValue('changed_on') || ''
      });
    }

    return detail;
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

  /**
   * Is 'YYYY-MM-DD' a real date inside the given month?
   *
   * Parsed rather than string-prefixed so '2026-08-99' cannot pass. Dates are
   * compared as strings everywhere else in ShiftPay; this is the one place the
   * value arrives from the browser and has to be proved well-formed first.
   */
  function isDateInMonth(dateKey, y, m) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey || '')) return false;
    var p = dateKey.split('-');
    var yy = parseInt(p[0], 10), mm = parseInt(p[1], 10), dd = parseInt(p[2], 10);
    if (yy !== y || mm !== m + 1) return false;
    return dd >= 1 && dd <= daysInMonth(y, m);
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
