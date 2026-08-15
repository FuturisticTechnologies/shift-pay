var ShiftPayCalendarRules = Class.create();

/**
 * ShiftPayCalendarRules
 * =====================
 * Which shift types a given user may log on a given date.
 *
 * The third and last lift out of the "Fill Shift Calendar UI" widget server
 * script, after ShiftPayAggregator and ShiftPayEntitlements. Those two left a
 * deliberate hole, recorded in the ShiftPayEntitlements header: weekend/holiday
 * detection and the catalogue allow_weekday / allow_weekend_holiday flags were
 * still inline in the widget, so a caller computing an allowed-shift list had
 * to own half the rule itself. The manager approval widget cannot correct a
 * reportee's day without that list, and re-deriving it there would be the same
 * fork this codebase keeps refusing to make.
 *
 * Behaviour is intentionally identical to the original loadCatalogue /
 * validateCatalogue / loadHolidays / isWeekend / isHoliday /
 * baseAllowedSysIds / computeAllowedShifts.
 *
 * WHAT THIS OWNS
 *   - the shift-type catalogue read, with its semantic columns
 *   - catalogue configuration validation (the configError banner text)
 *   - holiday dates, from the cmn_schedule named by a system property
 *   - weekend / holiday classification of a date
 *   - the allowed-shift list for a date or a whole month, CO window included
 *
 * WHAT THIS DOES NOT OWN
 *   The CO entitlement lifecycle. Opening, consuming and releasing entitlements
 *   is ShiftPayEntitlements' job; this class only asks it whether an open window
 *   covers a date. The two compose: base calendar role from here, CO window from
 *   there, and `allowedForDate` is where they meet.
 *
 * Scoped-app constraints: ES5 only (Rhino) — no let/const, arrow functions or
 * template literals.
 *
 * Usage — the calendar, which has already loaded the catalogue and built an
 * entitlements object, hands both over so neither is queried twice:
 *   var rules = new ShiftPayCalendarRules({
 *     catalogue:    catalogue,        // optional; read on first use if omitted
 *     entitlements: ENTITLEMENTS,     // optional; built on first use if omitted
 *     catalogTable: '...',
 *     coEnabled:    true
 *   });
 *
 * Usage — the manager widget, which knows only a reportee's sys_id and lets
 * this class assemble the rest for that user:
 *   var rules = new ShiftPayCalendarRules({ userId: reporteeSysId });
 *   if (!rules.isAllowedOn('2026-08-17', shiftSysId)) { ...refuse... }
 *
 * Dates cross every boundary as 'YYYY-MM-DD' strings and are compared
 * lexically — deliberate, and relied upon for the window checks.
 *
 * Month convention: `month` arguments are 0-indexed (0 = January), matching the
 * client and the other two Script Includes. Nothing here touches a stored
 * 1-indexed u_month column.
 */
ShiftPayCalendarRules.prototype = {

  initialize: function (config) {
    config = config || {};
    this.userId          = config.userId          || gs.getUserID();
    this.catalogTable    = config.catalogTable    || 'x_1995110_shift_0_shift_type';
    this.holidayProperty = config.holidayProperty || 'x_shiftpay.holiday_schedule';

    // Matches the enable_co_entitlement widget option. When off, the
    // consumes_co row stops being special-cased and is allowed purely on its own
    // allow_* flags, exactly as the widget used to do.
    this.coEnabled = (config.coEnabled === undefined || config.coEnabled === null)
                     ? true : !!config.coEnabled;

    // Everything below is lazy: constructing this object costs no queries.
    this._catalogue     = config.catalogue    || null;
    this._entitlements  = config.entitlements || null;
    this._entitlementTable = config.entitlementTable || null;
    this._catalogById   = null;
    this._coSysId       = null;
    this._compoundOcIds = null;
    this._holidays      = null;
  },

  // ============================================================ //
  // Catalogue                                                     //
  // ============================================================ //

  /**
   * Active shift types, ordered by name, with the semantic columns the rules
   * branch on. Read once per instance.
   *
   * Semantics are keyed by sys_id and carried in columns — oc_role,
   * allow_weekday, allow_weekend_holiday, day_category. The name and
   * description are cosmetic; renaming a shift type changes no behaviour.
   */
  catalogue: function () {
    if (this._catalogue) return this._catalogue;
    var result = [];
    var gr = new GlideRecord(this.catalogTable);
    gr.addQuery('active', true);
    gr.orderBy('name');
    gr.query();
    while (gr.next()) {
      result.push({
        sys_id:         gr.getUniqueValue(),
        name:           gr.getValue('name')           || '',
        description:    gr.getValue('description')    || '',
        rate:           gr.getValue('rate')           || '0',
        currency:       gr.getValue('currency')       || 'INR',
        effective_date: gr.getValue('effective_date') || '',
        color_hex:      gr.getValue('color_hex')      || '',
        // Semantic columns — the contract the code branches on.
        oc_role:               gr.getValue('oc_role') || 'none',
        allow_weekday:         this._isTrue(gr.getValue('allow_weekday')),
        allow_weekend_holiday: this._isTrue(gr.getValue('allow_weekend_holiday')),
        day_category:          gr.getValue('day_category') || ''
      });
    }
    this._catalogue = result;
    return result;
  },

  /** sys_id -> catalogue row. */
  catalogById: function () {
    if (this._catalogById) return this._catalogById;
    var map = {}, cat = this.catalogue();
    for (var i = 0; i < cat.length; i++) map[cat[i].sys_id] = cat[i];
    this._catalogById = map;
    return map;
  },

  /** Is this sys_id an active shift type at all? */
  isValidShift: function (sysId) {
    return !!this.catalogById()[sysId];
  },

  /** sys_id of the shift type whose oc_role is consumes_co, or null. */
  coShiftId: function () {
    this._deriveSemantics();
    return this._coSysId;
  },

  /** sys_id -> true for every shift type whose oc_role grants a CO. */
  compoundOcIds: function () {
    this._deriveSemantics();
    return this._compoundOcIds;
  },

  /**
   * Configuration problems with the catalogue, as one sentence-joined string
   * ('' when there are none). This is the configError banner: a catalogue that
   * cannot drive the rules should say so loudly rather than quietly behave
   * strangely.
   */
  configError: function () {
    var problems = [];
    var hasConsumer = false;
    var cat = this.catalogue();
    for (var i = 0; i < cat.length; i++) {
      if (!cat[i].day_category) {
        problems.push('Shift type "' + cat[i].name + '" is missing a day category.');
      }
      if (cat[i].oc_role === 'consumes_co') hasConsumer = true;
    }
    if (this.coEnabled && !hasConsumer) {
      problems.push('CO entitlement is enabled but no shift type has the "consumes_co" role.');
    }
    return problems.length ? problems.join(' ') : '';
  },

  _deriveSemantics: function () {
    if (this._compoundOcIds) return;
    this._compoundOcIds = {};
    this._coSysId = null;
    var cat = this.catalogue();
    for (var i = 0; i < cat.length; i++) {
      if (cat[i].oc_role === 'consumes_co') this._coSysId = cat[i].sys_id;
      if (cat[i].oc_role === 'grants_co')   this._compoundOcIds[cat[i].sys_id] = true;
    }
  },

  // ============================================================ //
  // Entitlements (composed, not owned)                            //
  // ============================================================ //

  /**
   * The entitlement lifecycle object for this user, built on first use.
   *
   * Callers that already have one pass it to the constructor. Callers that only
   * know a user sys_id — the manager widget — get one wired to the same
   * catalogue semantics derived here, so the catalogue is never read twice.
   */
  entitlements: function () {
    if (this._entitlements) return this._entitlements;
    var cfg = {
      userId:        this.userId,
      catalogTable:  this.catalogTable,
      enabled:       this.coEnabled,
      coSysId:       this.coShiftId(),
      compoundOcIds: this.compoundOcIds()
    };
    if (this._entitlementTable) cfg.entitlementTable = this._entitlementTable;
    this._entitlements = new ShiftPayEntitlements(cfg);
    return this._entitlements;
  },

  // ============================================================ //
  // Calendar role of a date                                       //
  // ============================================================ //

  /**
   * Holiday dates as a { 'YYYY-MM-DD': true } set, read once per instance.
   *
   * The schedule is named by a system property rather than configured per
   * widget, so every screen agrees on which days are holidays. No property, no
   * holidays — weekends still apply.
   */
  holidays: function () {
    if (this._holidays) return this._holidays;
    var set = {};
    var schedSysId = gs.getProperty(this.holidayProperty, '');
    if (!schedSysId) { this._holidays = set; return set; }
    var gr = new GlideRecord('cmn_schedule_span');
    gr.addQuery('schedule', schedSysId);
    gr.query();
    while (gr.next()) {
      var startStr = gr.getValue('start_date_time');
      if (startStr) {
        var gdt = new GlideDateTime(startStr);
        set[gdt.getDate().getValue()] = true;
      }
    }
    this._holidays = set;
    return set;
  },

  isHoliday: function (dateKey) { return !!this.holidays()[dateKey]; },

  isWeekend: function (dateKey) {
    if (!dateKey) return false;
    var p = dateKey.split('-');
    var dow = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10)).getDay();
    return dow === 0 || dow === 6;
  },

  // ============================================================ //
  // Allowed shifts                                                //
  // ============================================================ //

  /**
   * Shift types allowed by calendar role alone.
   *
   * While CO is enabled the consumes_co row is excluded here and added back by
   * `allowedForDate` only where an open entitlement window covers the date —
   * a CO is earned, not merely permitted. With CO disabled it is an ordinary
   * shift governed by its own allow_* flags.
   */
  baseAllowedSysIds: function (dateKey) {
    var weekendOrHoliday = this.isWeekend(dateKey) || this.isHoliday(dateKey);
    var ids = [], cat = this.catalogue();
    for (var i = 0; i < cat.length; i++) {
      var row = cat[i];
      if (this.coEnabled && row.oc_role === 'consumes_co') continue;
      var allowed = weekendOrHoliday ? row.allow_weekend_holiday : row.allow_weekday;
      if (allowed) ids.push(row.sys_id);
    }
    return ids;
  },

  /**
   * The complete allowed list for one date: calendar role, plus CO when an
   * unconsumed entitlement window covers this plain weekday.
   *
   * @param {string}   dateKey
   * @param {Array=}   unconsumed  pre-loaded rows from
   *        ShiftPayEntitlements.loadUnconsumed(); pass it when looping a month
   *        so the entitlement table is queried once rather than once per day.
   */
  allowedForDate: function (dateKey, unconsumed) {
    var allowed = this.baseAllowedSysIds(dateKey);
    var co = this.coShiftId();
    if (this.coEnabled && co && !this.isWeekend(dateKey) && !this.isHoliday(dateKey)) {
      var ent  = this.entitlements();
      var rows = unconsumed || ent.loadUnconsumed();
      if (ent.hasUnconsumedFor(rows, dateKey)) allowed.push(co);
    }
    return allowed;
  },

  /**
   * { 'YYYY-MM-DD': [sys_id, ...] } for every day of the month.
   *
   * This is `data.allowedShifts`: computed server-side, enforced client-side by
   * filtering the dropdowns. The enforcement that matters is still the server
   * refusing an illegal write.
   */
  allowedForMonth: function (y, m) {
    var result = {};
    var dim = this._daysInMonth(y, m);
    var unconsumed = this.entitlements().loadUnconsumed();
    for (var d = 1; d <= dim; d++) {
      var dk = y + '-' + this._pad(m + 1) + '-' + this._pad(d);
      result[dk] = this.allowedForDate(dk, unconsumed);
    }
    return result;
  },

  /**
   * May this user log this shift type on this date?
   *
   * The single-date server-side gate. Reads entitlement state fresh, so it is
   * safe to call immediately after a write that changed it.
   */
  isAllowedOn: function (dateKey, shiftId) {
    if (!dateKey || !shiftId) return false;
    var ids = this.allowedForDate(dateKey);
    for (var i = 0; i < ids.length; i++) {
      if (ids[i] === shiftId) return true;
    }
    return false;
  },

  // ---- utilities ----

  // glide_boolean getValue() yields '1'/'0'; tolerate 'true' too.
  _isTrue: function (v) { return v === '1' || v === 'true' || v === true; },

  _pad: function (n) { return n < 10 ? '0' + n : '' + n; },

  _daysInMonth: function (y, m) { return new Date(y, m + 1, 0).getDate(); },

  type: 'ShiftPayCalendarRules'
};
