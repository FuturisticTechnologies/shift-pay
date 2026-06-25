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

  function isCompoundOc(sysId) { return !!compoundOcIds[sysId]; }


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
    var unconsumed = CO_ENABLED ? loadUnconsumedEntitlements() : [];
    for (var d = 1; d <= dim; d++) {
      var dk = y + '-' + pad(m + 1) + '-' + pad(d);
      var allowed = baseAllowedSysIds(dk);
      // CO available on plain weekdays when an unconsumed entitlement window covers dk
      if (CO_ENABLED && coSysId && !isWeekend(dk) && !isHoliday(dk)) {
        if (hasUnconsumedEntitlementFor(unconsumed, dk)) allowed.push(coSysId);
      }
      result[dk] = allowed;
    }
    return result;
  }

  function loadUnconsumedEntitlements() {
    var rows = [];
    var gr = new GlideRecord(TABLE_ENT);
    gr.addQuery('u_user', USER_ID);
    gr.addNullQuery('u_co_entry');
    gr.query();
    while (gr.next()) {
      rows.push({
        sysid:      gr.getUniqueValue(),
        oc_date:    gr.getValue('oc_date'),
        window_end: gr.getValue('u_oc_window_end')
      });
    }
    return rows;
  }

  function hasUnconsumedEntitlementFor(unconsumed, dateKey) {
    for (var i = 0; i < unconsumed.length; i++) {
      var e = unconsumed[i];
      if (e.oc_date < dateKey && e.window_end >= dateKey) return true;
    }
    return false;
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
      if (CO_ENABLED && prevShift && prevShift !== newShift) {
        if (isCompoundOc(prevShift)) {
          var oldEnt = findEntitlementByOcDate(date);
          if (oldEnt && oldEnt.co_entry) {
            gs.addErrorMessage('Cannot change this entry — a CO on ' + oldEnt.co_date + ' depends on it.');
            return;
          }
          if (oldEnt) deleteEntitlementRow(oldEnt.sysid);
        }
        if (prevShift === coSysId) {
          var oldCoEnt = findEntitlementConsumedByCoDate(date);
          if (oldCoEnt) releaseEntitlement(oldCoEnt.sysid);
        }
      }

      // --- Pre-check CO entitlement before writing ---
      var eligibleEnt = null;
      if (CO_ENABLED && newShift !== prevShift && newShift === coSysId) {
        eligibleEnt = findEarliestUnconsumedEntitlementFor(date);
        if (!eligibleEnt) {
          gs.addErrorMessage('CO not available for ' + date + ' — log an OC+CO shift on a prior holiday first.');
          return;
        }
      }

      // --- Write the submission row ---
      var newEntrySysId = upsertDay(date, newShift, inp.comment);

      // --- Entitlement side-effects for adding newShift ---
      if (CO_ENABLED && newShift !== prevShift) {
        if (isCompoundOc(newShift)) insertEntitlementRow(date, newEntrySysId);
        if (newShift === coSysId && eligibleEnt) consumeEntitlement(eligibleEnt.sysid, date, newEntrySysId);
      }

      recomputeAggregates([date]);
    }

    else if (action === 'clearDay') {
      var clDate = inp.date;
      if (!clDate) return;
      var clPrev = getPrevShift(clDate);
      if (CO_ENABLED && clPrev) {
        if (isCompoundOc(clPrev)) {
          var clEnt = findEntitlementByOcDate(clDate);
          if (clEnt && clEnt.co_entry) {
            gs.addErrorMessage('Cannot clear — CO on ' + clEnt.co_date + ' depends on this entry.');
            return;
          }
          if (clEnt) deleteEntitlementRow(clEnt.sysid);
        }
        if (clPrev === coSysId) {
          var clCoEnt = findEntitlementConsumedByCoDate(clDate);
          if (clCoEnt) releaseEntitlement(clCoEnt.sysid);
        }
      }
      deleteDay(clDate);
      recomputeAggregates([clDate]);
    }

    else if (action === 'bulkSave') {
      var bShift = inp.shift;
      if (!isValidShift(bShift)) return;
      // CO and compound-OC must be logged individually (entitlement validation too complex for bulk).
      // Only relevant while CO entitlement is enabled; otherwise they are ordinary shifts.
      if (CO_ENABLED && (bShift === coSysId || isCompoundOc(bShift))) {
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
    out.entries      = readMonthEntries(y, m);
    out.comments     = readMonthComments(y, m);
    out.locked       = isMonthLocked(y, m);
    out.submittedOn  = out.locked ? readSubmittedOn(y, m) : '';
    out.allowedShifts = computeAllowedShifts(y, m);
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

  function readSubmittedOn(y, m) {
    var gr = new GlideRecord(TABLE_LOCK);
    gr.addQuery('u_user',  USER_ID);
    gr.addQuery('u_year',  y);
    gr.addQuery('u_month', m + 1);
    gr.setLimit(1);
    gr.query();
    return gr.next() ? gr.getDisplayValue('u_submitted_on') : '';
  }

  function isMonthLocked(y, m) {
    var gr = new GlideRecord(TABLE_LOCK);
    gr.addQuery('u_user',  USER_ID);
    gr.addQuery('u_year',  y);
    gr.addQuery('u_month', m + 1);
    gr.setLimit(1);
    gr.query();
    return gr.hasNext();
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
    if (isMonthLocked(y, m)) return;
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
    gr.initialize();
    gr.setValue('u_user',        USER_ID);
    gr.setValue('u_year',        y);
    gr.setValue('u_month',       m + 1);
    gr.setValue('u_submitted_on', new GlideDateTime());
    gr.insert();
    gs.addInfoMessage('Shift submissions for ' + y + '-' + pad(m + 1) + ' locked.');
  }


  // ============================================================ //
  // Entitlement helpers                                           //
  // ============================================================ //

  function findEntitlementByOcDate(date) {
    var gr = new GlideRecord(TABLE_ENT);
    gr.addQuery('u_user',    USER_ID);
    gr.addQuery('oc_date', date);
    gr.setLimit(1);
    gr.query();
    if (!gr.next()) return null;
    return { sysid: gr.getUniqueValue(), co_entry: gr.getValue('u_co_entry'), co_date: gr.getValue('u_co_date') };
  }

  function findEntitlementConsumedByCoDate(date) {
    var gr = new GlideRecord(TABLE_ENT);
    gr.addQuery('u_user',    USER_ID);
    gr.addQuery('u_co_date', date);
    gr.setLimit(1);
    gr.query();
    if (!gr.next()) return null;
    return { sysid: gr.getUniqueValue(), oc_date: gr.getValue('oc_date') };
  }

  function findEarliestUnconsumedEntitlementFor(date) {
    var gr = new GlideRecord(TABLE_ENT);
    gr.addQuery('u_user',          USER_ID);
    gr.addNullQuery('u_co_entry');
    gr.addQuery('oc_date',       '<',  date);
    gr.addQuery('u_oc_window_end', '>=', date);
    gr.orderBy('oc_date');
    gr.setLimit(1);
    gr.query();
    if (!gr.next()) return null;
    return { sysid: gr.getUniqueValue() };
  }

  function insertEntitlementRow(date, entrySysId) {
    var windowEnd = nthWeekdayAfter(date, 7);
    var gr = new GlideRecord(TABLE_ENT);
    gr.initialize();
    gr.setValue('u_user',          USER_ID);
    gr.setValue('u_oc_entry',      entrySysId);
    gr.setValue('oc_date',       date);
    gr.setValue('u_oc_window_end', windowEnd);
    gr.insert();
  }

  function consumeEntitlement(entSysId, coDate, coEntrySysId) {
    var gr = new GlideRecord(TABLE_ENT);
    if (!gr.get(entSysId)) return;
    gr.setValue('u_co_entry', coEntrySysId);
    gr.setValue('u_co_date',  coDate);
    gr.update();
  }

  function releaseEntitlement(entSysId) {
    var gr = new GlideRecord(TABLE_ENT);
    if (!gr.get(entSysId)) return;
    gr.setValue('u_co_entry', null);
    gr.setValue('u_co_date',  null);
    gr.update();
  }

  function deleteEntitlementRow(entSysId) {
    var gr = new GlideRecord(TABLE_ENT);
    if (!gr.get(entSysId)) return;
    gr.deleteRecord();
  }


  // ============================================================ //
  // Aggregate helpers                                             //
  // ============================================================ //

  function recomputeAggregates(dates) {
    var rateMap = loadRateMap();
    var monthsMap = {}, weeksMap = {};

    for (var i = 0; i < dates.length; i++) {
      var dk = dates[i];
      var p = dk.split('-');
      var y = parseInt(p[0], 10), m = parseInt(p[1], 10) - 1; // 0-indexed

      var mKey = y + '-' + m;
      if (!monthsMap[mKey]) monthsMap[mKey] = { y: y, m: m };

      var wStart = mondayOf(dk);
      var wKey   = wStart + '|' + mKey;
      if (!weeksMap[wKey]) {
        var fom    = firstOfMonthKey(y, m);
        var lom    = lastOfMonthKey(y, m);
        var wEnd   = addDays(wStart, 6);
        weeksMap[wKey] = {
          periodStart: wStart, y: y, m: m,
          winStart: maxDate(wStart, fom),
          winEnd:   minDate(wEnd,   lom)
        };
      }
    }

    for (var mk in monthsMap) {
      var mo = monthsMap[mk];
      var fom2 = firstOfMonthKey(mo.y, mo.m);
      var lom2 = lastOfMonthKey(mo.y, mo.m);
      writeSummary('month', fom2, mo.y, mo.m, fom2, lom2, rateMap);
    }
    for (var wk in weeksMap) {
      var we = weeksMap[wk];
      writeSummary('week', we.periodStart, we.y, we.m, we.winStart, we.winEnd, rateMap);
    }
  }

  function writeSummary(type, periodStart, year, month, winStart, winEnd, rateMap) {
    // Delete existing rows for this (user, type, period_start, year, month)
    var del = new GlideRecord(TABLE_SUM);
    del.addQuery('u_user',         USER_ID);
    del.addQuery('u_period_type',  type);
    del.addQuery('u_period_start', periodStart);
    del.addQuery('u_year',         year);
    del.addQuery('u_month',        month + 1);
    del.deleteMultiple();

    // Aggregate submission rows within the window
    var gr = new GlideRecord(TABLE_DAY);
    gr.addQuery('u_user', USER_ID);
    gr.addQuery('u_date', '>=', winStart);
    gr.addQuery('u_date', '<=', winEnd);
    gr.query();
    var counts = {};
    while (gr.next()) {
      var st = gr.getValue('u_shift_type');
      if (st) counts[st] = (counts[st] || 0) + 1;
    }

    // Insert one row per non-zero shift
    for (var st in counts) {
      var cnt = counts[st];
      if (!cnt) continue;
      var rm = rateMap[st] || { rate: '0', currency: 'INR' };
      var amount = cnt * parseFloat(rm.rate || 0);
      var ins = new GlideRecord(TABLE_SUM);
      ins.initialize();
      ins.setValue('u_user',           USER_ID);
      ins.setValue('u_period_type',    type);
      ins.setValue('u_period_start',   periodStart);
      ins.setValue('u_year',           year);
      ins.setValue('u_month',          month + 1);
      ins.setValue('u_shift_type',     st);
      ins.setValue('u_count',          cnt);
      ins.setValue('u_rate_snapshot',  rm.rate || 0);
      ins.setValue('u_amount',         amount);
      ins.setValue('u_currency',       rm.currency || 'INR');
      ins.insert();
    }
  }

  function loadRateMap() {
    var map = {};
    for (var i = 0; i < catalogue.length; i++) {
      var row = catalogue[i];
      map[row.sys_id] = { rate: row.rate, currency: row.currency };
    }
    return map;
  }


  // ============================================================ //
  // Date utilities                                                //
  // ============================================================ //

  function mondayOf(dateKey) {
    var p = dateKey.split('-');
    var d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
    var dow = d.getDay(); // 0=Sun
    d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function firstOfMonthKey(y, m) { return y + '-' + pad(m + 1) + '-01'; }

  function lastOfMonthKey(y, m) {
    return y + '-' + pad(m + 1) + '-' + pad(daysInMonth(y, m));
  }

  function addDays(dateKey, n) {
    var p = dateKey.split('-');
    var d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function maxDate(a, b) { return a > b ? a : b; }
  function minDate(a, b) { return a < b ? a : b; }

  function nthWeekdayAfter(dateKey, n) {
    var p = dateKey.split('-');
    var d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
    var count = 0;
    while (count < n) {
      d.setDate(d.getDate() + 1);
      var dow = d.getDay();
      if (dow !== 0 && dow !== 6) count++;
    }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function isValidShift(sysId) { return !!catalogById[sysId]; }

  // glide_boolean getValue() yields '1'/'0'; tolerate 'true' too.
  function isTrue(v) { return v === '1' || v === 'true' || v === true; }

  function isoDate(gdt) { return gdt.getDate().getValue(); }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

})();
