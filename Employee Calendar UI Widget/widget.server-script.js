(function () {
  /**
   * My Shift Submissions — Server Script
   * =====================================
   * Tables (all names configurable via widget options):
   *   u_shift_type_catalog        catalogue of shift types (confirm exact name)
   *   u_shift_submission          per-day shift log
   *   u_shift_submission_lock     per-month submission lock
   *   u_shift_submission_summary  weekly/monthly aggregates for payroll
   *   u_shift_co_entitlement      tracks which compound-OC entries have granted CO rights
   *
   * Holiday dates come from a cmn_schedule record whose sys_id is stored in
   * system property x_shiftpay.holiday_schedule.
   *
   * Month convention:
   *   client / JS / data.month / input.month  →  0-indexed (0 = January)
   *   stored u_month in lock/summary tables   →  1-indexed (1 = January)
   */

  var TABLE_DAY  = options.shift_table       || 'u_shift_submission';
  var TABLE_LOCK = options.lock_table        || 'u_shift_submission_lock';
  var TABLE_CAT  = options.catalog_table     || 'u_shift_type_catalog';
  var TABLE_SUM  = options.summary_table     || 'u_shift_submission_summary';
  var TABLE_ENT  = options.entitlement_table || 'u_shift_co_entitlement';
  var HOLIDAY_PROP = 'x_shiftpay.holiday_schedule';
  var USER_ID    = gs.getUserID();

  // CO entitlement is an optional capability. When disabled, the server skips
  // all entitlement reads/writes and treats CO/compound-OC rows as ordinary
  // shifts governed purely by their u_allow_* flags.
  var CO_ENABLED = (options.enable_co_entitlement === undefined ||
                    options.enable_co_entitlement === '' ||
                    options.enable_co_entitlement === null)
                   ? true
                   : (options.enable_co_entitlement === true ||
                      options.enable_co_entitlement === 'true');

  // ── Load catalogue (needed by validation + client rendering) ────────────
  var catalogue = loadCatalogue();
  data.shiftCatalogue = catalogue;

  // Lookup maps derived from catalogue.
  // Semantics are driven by catalogue columns (oc_role etc.), never by the
  // display `name`, so renaming a shift type never changes behaviour.
  var catalogById   = {};   // sys_id → row
  var compoundOcIds = {};   // sys_id → true for shifts whose oc_role grants a CO
  var coSysId       = null; // sys_id of the shift whose oc_role consumes a CO
  for (var ci = 0; ci < catalogue.length; ci++) {
    var crow = catalogue[ci];
    catalogById[crow.sys_id] = crow;
    if (crow.oc_role === 'consumes_co') coSysId = crow.sys_id;
    if (crow.oc_role === 'grants_co')   compoundOcIds[crow.sys_id] = true;
  }

  // The CO entitlement lifecycle lives in the ShiftPayEntitlements Script
  // Include so the manager approval widget can run the identical rules against
  // a reportee's days. The catalogue semantics are handed over rather than
  // re-derived, so this stays a single catalogue read.
  var ENTITLEMENTS = new ShiftPayEntitlements({
    userId:           USER_ID,
    entitlementTable: TABLE_ENT,
    catalogTable:     TABLE_CAT,
    enabled:          CO_ENABLED,
    coSysId:          coSysId,
    compoundOcIds:    compoundOcIds
  });

  // ── Validate catalogue configuration (fail loudly, not silently) ─────────
  validateCatalogue();

  // ── Load holidays ────────────────────────────────────────────────────────
  var holidaySet = loadHolidays();

  // ── Determine which month we are showing ─────────────────────────────────
  var now = new GlideDateTime();
  var nowYear  = parseInt(now.getYearLocalTime(),  10);
  var nowMonth = parseInt(now.getMonthLocalTime(), 10) - 1; // → 0-indexed

  data.year  = (input && input.year  != null) ? parseInt(input.year,  10) : nowYear;
  data.month = (input && input.month != null) ? parseInt(input.month, 10) : nowMonth;
  data.todayKey = isoDate(now);

  // ── Handle write actions before re-reading the month ─────────────────────
  if (input && input.action) handleAction(input);

  // ── Load current month entries + lock status + allowedShifts ─────────────
  loadMonthInto(data, data.year, data.month);

  // ── Load last month (read-only summary panel) ─────────────────────────────
  var lmY = data.year, lmM = data.month - 1;
  if (lmM < 0) { lmM = 11; lmY--; }
  data.lastMonthYear      = lmY;
  data.lastMonthMonth     = lmM;
  data.lastMonthEntries   = readMonthEntries(lmY, lmM);
  data.lastMonthSubmitted = readSubmittedOn(lmY, lmM);


  // ============================================================ //
  // Helpers — catalogue & holidays                               //
  // ============================================================ //

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
        rate:         gr.getValue('rate')          || '0',
        currency:     gr.getValue('currency')      || 'INR',
        effective_date: gr.getValue('effective_date') || '',
        color_hex:    gr.getValue('color_hex')   || '',
        // Semantic columns — the contract the code branches on.
        oc_role:                gr.getValue('oc_role')                  || 'none',
        allow_weekday:          isTrue(gr.getValue('allow_weekday')),
        allow_weekend_holiday:  isTrue(gr.getValue('allow_weekend_holiday')),
        day_category:           gr.getValue('day_category')             || ''
      });
    }
    return result;
  }

  function validateCatalogue() {
    var problems = [];
    var hasConsumer = false;
    for (var i = 0; i < catalogue.length; i++) {
      var row = catalogue[i];
      if (!row.day_category) {
        problems.push('Shift type "' + row.name + '" is missing a day category.');
      }
      if (row.oc_role === 'consumes_co') hasConsumer = true;
    }
    if (CO_ENABLED && !hasConsumer) {
      problems.push('CO entitlement is enabled but no shift type has the "consumes_co" role.');
    }
    data.configError = problems.length ? problems.join(' ') : '';
  }

  function loadHolidays() {
    var set = {};
    var schedSysId = gs.getProperty(HOLIDAY_PROP, '');
    if (!schedSysId) return set;
    var gr = new GlideRecord('cmn_schedule_span');
    gr.addQuery('schedule', schedSysId);
    gr.query();
    while (gr.next()) {
      var startStr = gr.getValue('start_date_time');
      if (startStr) {
        var gdt = new GlideDateTime(startStr);
        set[isoDate(gdt)] = true;
      }
    }
    return set;
  }

  function isHoliday(dateKey) { return !!holidaySet[dateKey]; }

  function isWeekend(dateKey) {
    var p = dateKey.split('-');
    var dow = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10)).getDay();
    return dow === 0 || dow === 6;
  }


  // ============================================================ //
  // Helpers — allowed-shifts computation                         //
  // ============================================================ //

  function baseAllowedSysIds(dateKey) {
    // Returns sys_ids allowed by calendar role alone. When CO is enabled the
    // consumes_co row is excluded here and added separately by entitlement
    // window; when CO is disabled it is treated as an ordinary shift.
    var weekendOrHoliday = isWeekend(dateKey) || isHoliday(dateKey);
    var ids = [];
    for (var i = 0; i < catalogue.length; i++) {
      var row = catalogue[i];
      if (CO_ENABLED && row.oc_role === 'consumes_co') continue;
      var allowed = weekendOrHoliday ? row.allow_weekend_holiday : row.allow_weekday;
      if (allowed) ids.push(row.sys_id);
    }
    return ids;
  }

  function computeAllowedShifts(y, m) {
    var result = {};
    var dim = daysInMonth(y, m);
    // Load all unconsumed entitlements for this user once, bucket for fast lookup
    var unconsumed = ENTITLEMENTS.loadUnconsumed();
    for (var d = 1; d <= dim; d++) {
      var dk = y + '-' + pad(m + 1) + '-' + pad(d);
      var allowed = baseAllowedSysIds(dk);
      // CO available on plain weekdays when an unconsumed entitlement window covers dk
      if (CO_ENABLED && coSysId && !isWeekend(dk) && !isHoliday(dk)) {
        if (ENTITLEMENTS.hasUnconsumedFor(unconsumed, dk)) allowed.push(coSysId);
      }
      result[dk] = allowed;
    }
    return result;
  }


  // ============================================================ //
  // Action dispatcher                                            //
  // ============================================================ //

  function handleAction(inp) {
    var action = inp.action;
    if (action === 'loadMonth') return;

    if (isMonthLocked(data.year, data.month) && action !== 'submitMonth') {
      gs.addErrorMessage('This month is already submitted and locked.');
      return;
    }

    if (action === 'saveDay') {
      var date = inp.date, newShift = inp.shift;
      if (!date || !newShift || !isValidShift(newShift)) return;

      var prevShift = getPrevShift(date);

      // --- Entitlement side-effects for removing prevShift ---
      var released = ENTITLEMENTS.releasePrevious(date, prevShift, newShift);
      if (!released.ok) {
        gs.addErrorMessage(released.error);
        return;
      }

      // --- Pre-check CO entitlement before writing ---
      var reserved = ENTITLEMENTS.reserveForNew(date, newShift, prevShift);
      if (!reserved.ok) {
        gs.addErrorMessage(reserved.error);
        return;
      }

      // --- Write the submission row ---
      var newEntrySysId = upsertDay(date, newShift, inp.comment);

      // --- Entitlement side-effects for adding newShift ---
      ENTITLEMENTS.commitForNew(date, newShift, prevShift, newEntrySysId, reserved.entitlementId);

      recomputeAggregates([date]);
    }

    else if (action === 'clearDay') {
      var clDate = inp.date;
      if (!clDate) return;
      var clPrev = getPrevShift(clDate);
      // No new shift: passing null selects the "cannot clear" wording.
      var clReleased = ENTITLEMENTS.releasePrevious(clDate, clPrev, null);
      if (!clReleased.ok) {
        gs.addErrorMessage(clReleased.error);
        return;
      }
      deleteDay(clDate);
      recomputeAggregates([clDate]);
    }

    else if (action === 'bulkSave') {
      var bShift = inp.shift;
      if (!isValidShift(bShift)) return;
      // CO and compound-OC must be logged individually (entitlement validation too complex for bulk).
      // Only relevant while CO entitlement is enabled; otherwise they are ordinary shifts.
      if (ENTITLEMENTS.blocksBulk(bShift)) {
        gs.addErrorMessage('This shift type cannot be applied in bulk — please log it on each date individually.');
        return;
      }
      var bDates = inp.dates || [];
      for (var i = 0; i < bDates.length; i++) upsertDay(bDates[i], bShift, null);
      if (bDates.length) recomputeAggregates(bDates);
    }

    else if (action === 'submitMonth') {
      submitMonth(inp.year, inp.month);
    }
  }


  // ============================================================ //
  // Read helpers                                                  //
  // ============================================================ //

  function loadMonthInto(out, y, m) {
    var ts = readTimesheet(y, m);
    out.entries        = readMonthEntries(y, m);
    out.comments       = readMonthComments(y, m);
    out.locked         = ts.locked;
    out.submittedOn    = ts.submittedOn;
    // Approval state, for the banner. status is '' when nothing was ever submitted.
    out.status         = ts.status;
    out.managerComment = ts.managerComment;
    out.approver       = ts.approver;
    out.actionedOn     = ts.actionedOn;
    out.allowedShifts  = computeAllowedShifts(y, m);
  }

  function readMonthEntries(y, m) {
    var entries = {};
    var gr = monthGr(y, m);
    while (gr.next()) entries[gr.getValue('u_date')] = gr.getValue('u_shift_type');
    return entries;
  }

  function readMonthComments(y, m) {
    var comments = {};
    var gr = monthGr(y, m);
    while (gr.next()) {
      var cmt = gr.getValue('u_comment');
      if (cmt) comments[gr.getValue('u_date')] = cmt;
    }
    return comments;
  }

  function monthGr(y, m) {
    var from = y + '-' + pad(m + 1) + '-01';
    var to   = y + '-' + pad(m + 1) + '-' + pad(daysInMonth(y, m));
    var gr = new GlideRecord(TABLE_DAY);
    gr.addQuery('u_user', USER_ID);
    gr.addQuery('u_date', '>=', from);
    gr.addQuery('u_date', '<=', to);
    gr.query();
    return gr;
  }

  /**
   * The whole approval state of one month, in a single read.
   *
   * A month is LOCKED when a timesheet row exists and it has not been rejected.
   * Rejection deliberately reopens the month so the employee can fix and
   * resubmit — before the approval flow existed, the mere presence of this row
   * meant "locked forever" and there was no way back.
   */
  function readTimesheet(y, m) {
    var gr = new GlideRecord(TABLE_LOCK);
    gr.addQuery('u_user',  USER_ID);
    gr.addQuery('u_year',  y);
    gr.addQuery('u_month', m + 1);
    gr.setLimit(1);
    gr.query();

    if (!gr.next()) {
      return {
        exists: false, sysId: '', status: '', submittedOn: '',
        managerComment: '', approver: '', actionedOn: '', locked: false
      };
    }

    // Rows written before the status column existed read as empty; treat those
    // as submitted, which is what their presence used to mean.
    var status = gr.getValue('status') || 'submitted';
    return {
      exists:         true,
      sysId:          gr.getUniqueValue(),
      status:         status,
      submittedOn:    gr.getDisplayValue('u_submitted_on') || '',
      managerComment: gr.getValue('manager_comment') || '',
      approver:       gr.getDisplayValue('approver') || '',
      actionedOn:     gr.getDisplayValue('actioned_on') || '',
      locked:         status !== 'rejected'
    };
  }

  function readSubmittedOn(y, m) {
    return readTimesheet(y, m).submittedOn;
  }

  function isMonthLocked(y, m) {
    return readTimesheet(y, m).locked;
  }

  function getPrevShift(date) {
    var gr = new GlideRecord(TABLE_DAY);
    gr.addQuery('u_user', USER_ID);
    gr.addQuery('u_date', date);
    gr.setLimit(1);
    gr.query();
    return gr.next() ? gr.getValue('u_shift_type') : null;
  }


  // ============================================================ //
  // Write helpers                                                 //
  // ============================================================ //

  function upsertDay(date, shift, comment) {
    if (!date || !shift) return null;
    var gr = new GlideRecord(TABLE_DAY);
    gr.addQuery('u_user', USER_ID);
    gr.addQuery('u_date', date);
    gr.setLimit(1);
    gr.query();
    if (gr.next()) {
      gr.setValue('u_shift_type', shift);
      if (comment !== null && comment !== undefined) gr.setValue('u_comment', comment);
      gr.update();
      return gr.getUniqueValue();
    } else {
      gr.initialize();
      gr.setValue('u_user',       USER_ID);
      gr.setValue('u_date',       date);
      gr.setValue('u_shift_type', shift);
      gr.setValue('u_comment',    comment || '');
      return gr.insert();
    }
  }

  function deleteDay(date) {
    if (!date) return;
    var gr = new GlideRecord(TABLE_DAY);
    gr.addQuery('u_user', USER_ID);
    gr.addQuery('u_date', date);
    gr.query();
    while (gr.next()) gr.deleteRecord();
  }

  function submitMonth(y, m) {
    var ts = readTimesheet(y, m);
    // Already with the manager, or already approved — nothing to do.
    if (ts.exists && ts.status !== 'rejected') return;

    var entries = readMonthEntries(y, m);
    var missing = 0, dim = daysInMonth(y, m);
    for (var d = 1; d <= dim; d++) {
      var dt = new Date(y, m, d), dow = dt.getDay();
      if (dow === 0 || dow === 6) continue;
      if (!entries[y + '-' + pad(m + 1) + '-' + pad(d)]) missing++;
    }
    if (missing > 0) {
      gs.addErrorMessage('Cannot submit: ' + missing + ' weekday(s) still unlogged.');
      return;
    }

    var gr = new GlideRecord(TABLE_LOCK);
    if (ts.exists) {
      // Resubmitting after a rejection: reuse the row and clear the old
      // decision, so one month never has two timesheet rows. The manager must
      // act again — a resubmission restarts the approval step.
      if (!gr.get(ts.sysId)) return;
      gr.setValue('status',          'submitted');
      gr.setValue('approver',        '');
      gr.setValue('actioned_on',     '');
      gr.setValue('manager_comment', '');
      gr.setValue('u_submitted_on',  new GlideDateTime());
      gr.update();
      gs.addInfoMessage('Shift submissions for ' + y + '-' + pad(m + 1) + ' resubmitted for approval.');
    } else {
      gr.initialize();
      gr.setValue('u_user',         USER_ID);
      gr.setValue('u_year',         y);
      gr.setValue('u_month',        m + 1);
      gr.setValue('status',         'submitted');
      gr.setValue('u_submitted_on', new GlideDateTime());
      gr.insert();
      gs.addInfoMessage('Shift submissions for ' + y + '-' + pad(m + 1) + ' submitted for approval.');
    }
  }


  // Entitlement helpers moved to the ShiftPayEntitlements Script Include —
  // find/insert/consume/release/delete and the weekday window arithmetic all
  // live there now, parameterised by user so the manager widget shares them.


  // ============================================================ //
  // Aggregate helpers                                             //
  // ============================================================ //

  // Weekly/monthly aggregation lives in the ShiftPayAggregator Script Include so
  // the manager approval widget can run the identical logic against a reportee's
  // data. Everything it needs is passed in; it hard-wires nothing about "me".
  function recomputeAggregates(dates) {
    new ShiftPayAggregator({
      userId:       USER_ID,
      dayTable:     TABLE_DAY,
      summaryTable: TABLE_SUM,
      catalogTable: TABLE_CAT
    }).recompute(dates);
  }


  // ============================================================ //
  // Date utilities                                                //
  // ============================================================ //

  // mondayOf / firstOfMonthKey / lastOfMonthKey / addDays / maxDate / minDate
  // moved to the ShiftPayAggregator Script Include — they were used only by the
  // aggregate code. pad() and daysInMonth() stay: the rest of this script uses them.

  function isValidShift(sysId) { return !!catalogById[sysId]; }

  // glide_boolean getValue() yields '1'/'0'; tolerate 'true' too.
  function isTrue(v) { return v === '1' || v === 'true' || v === true; }

  function isoDate(gdt) { return gdt.getDate().getValue(); }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

})();
