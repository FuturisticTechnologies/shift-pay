/**
 * One-time dummy data seed for Shift Pay Management.
 *
 * Run from ServiceNow Scripts - Background while the Shift Pay application scope
 * is active. Review CONFIG before running.
 *
 * What it does:
 * - Finds users from a sys_user encoded query.
 * - Inserts or updates daily shift submissions for a few months.
 * - Skips existing non-dummy submissions by default.
 * - Recomputes week/month summary rows for the generated date range.
 *
 * It deliberately uses plain weekday/weekend shifts only. CO entitlement data is
 * not generated here because CO has dependency rules that are better tested
 * through the widget workflow.
 */
(function () {
  var CONFIG = {
    seedMarker: 'SPM_DUMMY_SHIFT_DATA_2026_06',
    skipExistingNonDummyRows: true,
    userEncodedQuery: 'active=true^user_nameLIKEshiftpay.demo',
    userLimit: 5,

    // Current month is 0. Example: [-2, -1, 0] seeds previous two months plus current month.
    // The current month only gets its first half seeded; past/future months are seeded fully.
    monthOffsets: [-2, -1, 0],

    tables: {
      day: 'x_1995110_shift_0_u_shift_submission',
      catalog: 'x_1995110_shift_0_shift_type',
      summary: 'x_1995110_shift_0_shift_submission_summary'
    }
  };

  var stats = {
    usersFound: 0,
    daysInserted: 0,
    daysUpdated: 0,
    daysDeleted: 0,
    daysSkipped: 0,
    summariesInserted: 0,
    summariesDeleted: 0,
    warnings: []
  };

  var users = resolveUsers(CONFIG.userEncodedQuery);
  var shifts = loadRequiredShifts();
  var months = resolveMonths(CONFIG.monthOffsets);

  if (!users.length) {
    gs.error('[ShiftPay dummy seed] No users resolved. Nothing to do.');
    return;
  }

  if (!shifts.UK || !shifts.US || !shifts.L || !shifts.OC) {
    gs.error('[ShiftPay dummy seed] Missing required shift catalogue rows. Need active names: UK, US, L, OC.');
    logStats();
    return;
  }

  for (var u = 0; u < users.length; u++) {
    for (var m = 0; m < months.length; m++) {
      seedMonth(users[u], months[m].year, months[m].month);
      recomputeMonthSummaries(users[u], months[m].year, months[m].month);
    }
  }

  logStats();

  function resolveUsers(encodedQuery) {
    var resolved = [];
    if (!encodedQuery) {
      stats.warnings.push('CONFIG.userEncodedQuery is empty. Refusing to seed all sys_user records.');
      return resolved;
    }
    var gr = new GlideRecord('sys_user');
    gr.addEncodedQuery(encodedQuery);
    gr.orderBy('user_name');
    if (CONFIG.userLimit && CONFIG.userLimit > 0) gr.setLimit(CONFIG.userLimit);
    gr.query();
    while (gr.next()) {
      resolved.push({ sys_id: gr.getUniqueValue(), user_name: gr.getValue('user_name') });
      stats.usersFound++;
    }
    return resolved;
  }

  function loadRequiredShifts() {
    var result = {};
    var names = ['UK', 'US', 'L', 'OC'];
    var gr = new GlideRecord(CONFIG.tables.catalog);
    gr.addQuery('name', 'IN', names.join(','));
    if (gr.isValidField('active')) gr.addQuery('active', true);
    gr.query();
    while (gr.next()) {
      result[gr.getValue('name')] = {
        sys_id: gr.getUniqueValue(),
        name: gr.getValue('name'),
        rate: gr.getValue('rate') || '0',
        currency: gr.getValue('currency') || 'INR'
      };
    }
    return result;
  }

  function resolveMonths(offsets) {
    var now = new Date();
    var result = [];
    for (var i = 0; i < offsets.length; i++) {
      var d = new Date(now.getFullYear(), now.getMonth() + offsets[i], 1);
      result.push({ year: d.getFullYear(), month: d.getMonth() });
    }
    return result;
  }

  function seedMonth(user, year, month) {
    var days = seedThroughDay(year, month);
    for (var d = 1; d <= days; d++) {
      var dateKey = year + '-' + pad(month + 1) + '-' + pad(d);
      var shift = chooseShift(user, year, month, d);
      upsertDay(user, dateKey, shift.sys_id);
    }
    deleteCurrentMonthDummyRowsAfter(user, year, month, days);
  }

  function seedThroughDay(year, month) {
    var days = daysInMonth(year, month);
    var now = new Date();
    if (year === now.getFullYear() && month === now.getMonth()) return Math.floor(days / 2);
    return days;
  }

  function deleteCurrentMonthDummyRowsAfter(user, year, month, throughDay) {
    var now = new Date();
    if (year !== now.getFullYear() || month !== now.getMonth()) return;

    var afterDate = year + '-' + pad(month + 1) + '-' + pad(throughDay);
    var monthEnd = lastOfMonthKey(year, month);
    var gr = new GlideRecord(CONFIG.tables.day);
    gr.addQuery('u_user', user.sys_id);
    gr.addQuery('u_date', '>', afterDate);
    gr.addQuery('u_date', '<=', monthEnd);
    gr.addQuery('u_comment', 'CONTAINS', CONFIG.seedMarker);
    gr.query();
    while (gr.next()) {
      gr.deleteRecord();
      stats.daysDeleted++;
    }
  }

  function chooseShift(user, year, month, day) {
    var date = new Date(year, month, day);
    var dow = date.getDay();
    var userSeed = parseInt(user.sys_id.substring(0, 2), 16) || 0;
    var selector = (day + month + userSeed) % 10;

    if (dow === 0 || dow === 6) return shifts.OC;
    if (selector === 0) return shifts.L;
    if (selector === 1 || selector === 2 || selector === 3) return shifts.US;
    return shifts.UK;
  }

  function upsertDay(user, dateKey, shiftSysId) {
    var comment = 'Generated dummy shift data (' + CONFIG.seedMarker + ')';
    var gr = new GlideRecord(CONFIG.tables.day);
    gr.addQuery('u_user', user.sys_id);
    gr.addQuery('u_date', dateKey);
    gr.setLimit(1);
    gr.query();

    if (gr.next()) {
      var existingComment = gr.getValue('u_comment') || '';
      var isDummy = existingComment.indexOf(CONFIG.seedMarker) >= 0;
      if (CONFIG.skipExistingNonDummyRows && !isDummy) {
        stats.daysSkipped++;
        return;
      }
      gr.setValue('u_shift_type', shiftSysId);
      gr.setValue('u_comment', comment);
      gr.update();
      stats.daysUpdated++;
      return;
    }

    gr.initialize();
    gr.setValue('u_user', user.sys_id);
    gr.setValue('u_date', dateKey);
    gr.setValue('u_shift_type', shiftSysId);
    gr.setValue('u_comment', comment);
    gr.insert();
    stats.daysInserted++;
  }

  function recomputeMonthSummaries(user, year, month) {
    var first = firstOfMonthKey(year, month);
    var last = lastOfMonthKey(year, month);
    writeSummary(user, 'month', first, year, month, first, last);

    var weeks = {};
    var dayCount = daysInMonth(year, month);
    for (var d = 1; d <= dayCount; d++) {
      var dateKey = year + '-' + pad(month + 1) + '-' + pad(d);
      var weekStart = mondayOf(dateKey);
      if (!weeks[weekStart]) {
        weeks[weekStart] = {
          start: weekStart,
          winStart: maxDate(weekStart, first),
          winEnd: minDate(addDays(weekStart, 6), last)
        };
      }
    }

    for (var key in weeks) {
      writeSummary(user, 'week', weeks[key].start, year, month, weeks[key].winStart, weeks[key].winEnd);
    }
  }

  function writeSummary(user, type, periodStart, year, month, winStart, winEnd) {
    var del = new GlideRecord(CONFIG.tables.summary);
    del.addQuery('u_user', user.sys_id);
    del.addQuery('u_period_type', type);
    del.addQuery('u_period_start', periodStart);
    del.addQuery('u_year', year);
    del.addQuery('u_month', month + 1);
    del.query();
    while (del.next()) {
      del.deleteRecord();
      stats.summariesDeleted++;
    }

    var counts = {};
    var gr = new GlideRecord(CONFIG.tables.day);
    gr.addQuery('u_user', user.sys_id);
    gr.addQuery('u_date', '>=', winStart);
    gr.addQuery('u_date', '<=', winEnd);
    gr.query();
    while (gr.next()) {
      var shift = gr.getValue('u_shift_type');
      if (shift) counts[shift] = (counts[shift] || 0) + 1;
    }

    var rateMap = loadRateMap();
    for (var shiftSysId in counts) {
      var count = counts[shiftSysId];
      if (!count) continue;

      var rate = rateMap[shiftSysId] ? rateMap[shiftSysId].rate : '0';
      var currency = rateMap[shiftSysId] ? rateMap[shiftSysId].currency : 'INR';
      var amount = count * parseFloat(rate || 0);

      var ins = new GlideRecord(CONFIG.tables.summary);
      ins.initialize();
      ins.setValue('u_user', user.sys_id);
      ins.setValue('u_period_type', type);
      ins.setValue('u_period_start', periodStart);
      ins.setValue('u_year', year);
      ins.setValue('u_month', month + 1);
      ins.setValue('u_shift_type', shiftSysId);
      ins.setValue('u_count', count);
      ins.setValue('u_rate_snapshot', rate || 0);
      ins.setValue('u_amount', amount);
      ins.setValue('u_currency', currency || 'INR');
      ins.insert();
      stats.summariesInserted++;
    }
  }

  function loadRateMap() {
    var map = {};
    var gr = new GlideRecord(CONFIG.tables.catalog);
    gr.query();
    while (gr.next()) {
      map[gr.getUniqueValue()] = {
        rate: gr.getValue('rate') || '0',
        currency: gr.getValue('currency') || 'INR'
      };
    }
    return map;
  }

  function mondayOf(dateKey) {
    var p = dateKey.split('-');
    var d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
    var dow = d.getDay();
    d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function firstOfMonthKey(year, month) {
    return year + '-' + pad(month + 1) + '-01';
  }

  function lastOfMonthKey(year, month) {
    return year + '-' + pad(month + 1) + '-' + pad(daysInMonth(year, month));
  }

  function addDays(dateKey, amount) {
    var p = dateKey.split('-');
    var d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
    d.setDate(d.getDate() + amount);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function maxDate(a, b) {
    return a > b ? a : b;
  }

  function minDate(a, b) {
    return a < b ? a : b;
  }

  function daysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
  }

  function pad(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function logStats() {
    gs.info('[ShiftPay dummy seed] usersFound=' + stats.usersFound +
      ', daysInserted=' + stats.daysInserted +
      ', daysUpdated=' + stats.daysUpdated +
      ', daysDeleted=' + stats.daysDeleted +
      ', daysSkipped=' + stats.daysSkipped +
      ', summariesDeleted=' + stats.summariesDeleted +
      ', summariesInserted=' + stats.summariesInserted);

    for (var i = 0; i < stats.warnings.length; i++) {
      gs.warn('[ShiftPay dummy seed] ' + stats.warnings[i]);
    }
  }
})();
