var ShiftPayAggregator = Class.create();

/**
 * ShiftPayAggregator
 * ==================
 * Weekly + monthly shift aggregation with a rate snapshot, for ONE user.
 *
 * Lifted verbatim out of the "Fill Shift Calendar UI" widget server script so
 * that the manager approval widget can recompute a *reportee's* totals after
 * changing one of their days. The employee widget always aggregates the signed-in
 * user; the manager widget never does. Hard-wiring gs.getUserID() — which the
 * original did — is exactly what made it unusable from the manager side.
 *
 * Behaviour is intentionally identical to the original. See the note on
 * _getRateMap about active-only catalogue rows before "fixing" anything here.
 *
 * Scoped-app constraints: ES5 only (Rhino) — no let/const, arrow functions or
 * template literals.
 *
 * Usage:
 *   var agg = new ShiftPayAggregator({
 *     userId:       someSysId,          // defaults to gs.getUserID()
 *     dayTable:     '...',              // defaults below
 *     summaryTable: '...',
 *     catalogTable: '...'
 *   });
 *   agg.recompute(['2026-08-11', '2026-08-12']);
 *
 * Dates cross every boundary as 'YYYY-MM-DD' strings and are compared
 * lexically — that is deliberate and relied upon for window checks.
 *
 * Month convention: `month` arguments and the internal maps are 0-indexed
 * (0 = January); the stored u_month column is 1-indexed. The conversion
 * happens only in _writeSummary, on the way in and out of the table.
 */
ShiftPayAggregator.prototype = {

  initialize: function (config) {
    config = config || {};
    this.userId       = config.userId       || gs.getUserID();
    this.dayTable     = config.dayTable     || 'x_1995110_shift_0_u_shift_submission';
    this.summaryTable = config.summaryTable || 'x_1995110_shift_0_shift_submission_summary';
    this.catalogTable = config.catalogTable || 'x_1995110_shift_0_shift_type';
    this._rateMap     = null;
  },

  /**
   * Recompute every week and month touched by the given dates.
   *
   * Aggregates are recomputed, never incremented: each affected period row is
   * deleted and rewritten from the current day rows, snapshotting today's rate.
   *
   * @param {string[]} dates  'YYYY-MM-DD' strings; may span months.
   */
  recompute: function (dates) {
    if (!dates || !dates.length) return;

    var rateMap   = this._getRateMap();
    var monthsMap = {};
    var weeksMap  = {};

    for (var i = 0; i < dates.length; i++) {
      var dk = dates[i];
      if (!dk) continue;
      var p = dk.split('-');
      var y = parseInt(p[0], 10);
      var m = parseInt(p[1], 10) - 1; // 0-indexed

      var mKey = y + '-' + m;
      if (!monthsMap[mKey]) monthsMap[mKey] = { y: y, m: m };

      // A week row is clipped to the month it is being reported under, so a
      // week straddling month-end contributes to both months separately.
      var wStart = this._mondayOf(dk);
      var wKey   = wStart + '|' + mKey;
      if (!weeksMap[wKey]) {
        var fom  = this._firstOfMonthKey(y, m);
        var lom  = this._lastOfMonthKey(y, m);
        var wEnd = this._addDays(wStart, 6);
        weeksMap[wKey] = {
          periodStart: wStart,
          y: y,
          m: m,
          winStart: this._maxDate(wStart, fom),
          winEnd:   this._minDate(wEnd,   lom)
        };
      }
    }

    for (var mk in monthsMap) {
      var mo   = monthsMap[mk];
      var fom2 = this._firstOfMonthKey(mo.y, mo.m);
      var lom2 = this._lastOfMonthKey(mo.y, mo.m);
      this._writeSummary('month', fom2, mo.y, mo.m, fom2, lom2, rateMap);
    }
    for (var wk in weeksMap) {
      var we = weeksMap[wk];
      this._writeSummary('week', we.periodStart, we.y, we.m, we.winStart, we.winEnd, rateMap);
    }
  },

  // ============================================================ //
  // Internals                                                     //
  // ============================================================ //

  /**
   * Delete-then-insert one period's rows: one row per shift type with a
   * non-zero count, each carrying the rate snapshot taken right now.
   */
  _writeSummary: function (type, periodStart, year, month, winStart, winEnd, rateMap) {
    var del = new GlideRecord(this.summaryTable);
    del.addQuery('u_user',         this.userId);
    del.addQuery('u_period_type',  type);
    del.addQuery('u_period_start', periodStart);
    del.addQuery('u_year',         year);
    del.addQuery('u_month',        month + 1); // stored 1-indexed
    del.deleteMultiple();

    var gr = new GlideRecord(this.dayTable);
    gr.addQuery('u_user', this.userId);
    gr.addQuery('u_date', '>=', winStart);
    gr.addQuery('u_date', '<=', winEnd);
    gr.query();

    var counts = {};
    while (gr.next()) {
      var st = gr.getValue('u_shift_type');
      if (st) counts[st] = (counts[st] || 0) + 1;
    }

    for (var shiftId in counts) {
      var cnt = counts[shiftId];
      if (!cnt) continue;
      var rm     = rateMap[shiftId] || { rate: '0', currency: 'INR' };
      var amount = cnt * parseFloat(rm.rate || 0);

      var ins = new GlideRecord(this.summaryTable);
      ins.initialize();
      ins.setValue('u_user',          this.userId);
      ins.setValue('u_period_type',   type);
      ins.setValue('u_period_start',  periodStart);
      ins.setValue('u_year',          year);
      ins.setValue('u_month',         month + 1); // stored 1-indexed
      ins.setValue('u_shift_type',    shiftId);
      ins.setValue('u_count',         cnt);
      ins.setValue('u_rate_snapshot', rm.rate || 0);
      ins.setValue('u_amount',        amount);
      ins.setValue('u_currency',      rm.currency || 'INR');
      ins.insert();
    }
  },

  /**
   * sys_id -> { rate, currency }, loaded once per instance.
   *
   * NOTE: this reads ACTIVE catalogue rows only, matching the original widget
   * exactly. That means a shift type deactivated after being logged aggregates
   * at rate 0 on the next recompute. Preserved here on purpose so this refactor
   * is behaviour-neutral — it is a real issue, but it is a separate decision.
   */
  _getRateMap: function () {
    if (this._rateMap) return this._rateMap;
    var map = {};
    var gr = new GlideRecord(this.catalogTable);
    gr.addQuery('active', true);
    gr.query();
    while (gr.next()) {
      map[gr.getUniqueValue()] = {
        rate:     gr.getValue('rate')     || '0',
        currency: gr.getValue('currency') || 'INR'
      };
    }
    this._rateMap = map;
    return map;
  },

  // ---- date utilities (private copies; the widget keeps its own pad/daysInMonth) ----

  _mondayOf: function (dateKey) {
    var p = dateKey.split('-');
    var d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
    var dow = d.getDay(); // 0 = Sunday
    d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
    return d.getFullYear() + '-' + this._pad(d.getMonth() + 1) + '-' + this._pad(d.getDate());
  },

  _firstOfMonthKey: function (y, m) {
    return y + '-' + this._pad(m + 1) + '-01';
  },

  _lastOfMonthKey: function (y, m) {
    return y + '-' + this._pad(m + 1) + '-' + this._pad(this._daysInMonth(y, m));
  },

  _addDays: function (dateKey, n) {
    var p = dateKey.split('-');
    var d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + this._pad(d.getMonth() + 1) + '-' + this._pad(d.getDate());
  },

  _maxDate: function (a, b) { return a > b ? a : b; },
  _minDate: function (a, b) { return a < b ? a : b; },

  _pad: function (n) { return n < 10 ? '0' + n : '' + n; },

  _daysInMonth: function (y, m) { return new Date(y, m + 1, 0).getDate(); },

  type: 'ShiftPayAggregator'
};
