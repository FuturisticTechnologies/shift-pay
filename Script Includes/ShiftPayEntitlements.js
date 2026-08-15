var ShiftPayEntitlements = Class.create();

/**
 * ShiftPayEntitlements
 * ====================
 * The compensatory-off (CO) entitlement lifecycle for ONE user.
 *
 * Lifted verbatim out of the "Fill Shift Calendar UI" widget server script,
 * for the same reason ShiftPayAggregator was: the manager approval widget has
 * to run these rules against a *reportee* when it corrects one of their days,
 * and the original hard-wired gs.getUserID() throughout. A second copy of
 * these rules would be a pay bug waiting to happen — logging a grants_co shift
 * creates a right to a day off, and the two copies would drift over who owes
 * whom a day.
 *
 * Behaviour is intentionally identical to the original, including the error
 * message wording, which differs between changing a day and clearing one.
 *
 * WHAT THIS OWNS
 *   - the entitlement table lifecycle (insert / consume / release / delete)
 *   - which unconsumed entitlement windows cover a given date
 *   - the ordering rules around changing a day that grants or consumes a CO
 *
 * WHAT THIS DOES NOT OWN
 *   Weekend/holiday detection and the catalogue allow_weekday /
 *   allow_weekend_holiday flags. Those belong to ShiftPayCalendarRules, which
 *   composes the two: base calendar role from there, plus the CO window from
 *   hasUnconsumedFor() here. Callers wanting an allowed-shift list should ask
 *   ShiftPayCalendarRules.allowedForDate / allowedForMonth rather than
 *   assembling it themselves — it builds and owns the instance of this class.
 *
 * Scoped-app constraints: ES5 only (Rhino) — no let/const, arrow functions or
 * template literals.
 *
 * Usage:
 *   var ent = new ShiftPayEntitlements({
 *     userId:           someSysId,        // defaults to gs.getUserID()
 *     entitlementTable: '...',            // defaults below
 *     catalogTable:     '...',
 *     enabled:          true,             // the enable_co_entitlement option
 *     coSysId:          '...',            // optional; derived if omitted
 *     compoundOcIds:    { sysId: true }   // optional; derived if omitted
 *   });
 *
 * The three-phase day change, which must bracket the day write:
 *   var rel = ent.releasePrevious(date, prevShift, newShift);
 *   if (!rel.ok) { fail(rel.error); return; }
 *   var res = ent.reserveForNew(date, newShift, prevShift);
 *   if (!res.ok) { fail(res.error); return; }
 *   var entrySysId = ...write the day...
 *   ent.commitForNew(date, newShift, prevShift, entrySysId, res.entitlementId);
 *
 * Dates cross every boundary as 'YYYY-MM-DD' strings and are compared
 * lexically — deliberate, and relied upon for the window checks.
 */
ShiftPayEntitlements.prototype = {

  initialize: function (config) {
    config = config || {};
    this.userId           = config.userId           || gs.getUserID();
    this.entitlementTable = config.entitlementTable || 'x_1995110_shift_0_shift_co_entitlement';
    this.catalogTable     = config.catalogTable     || 'x_1995110_shift_0_shift_type';

    // Matches the enable_co_entitlement widget option: when off, every branch
    // below short-circuits and CO / compound-OC behave as ordinary shifts.
    this.enabled = (config.enabled === undefined || config.enabled === null)
                   ? true : !!config.enabled;

    // Entitlement window: 7 *weekdays* after the OC date.
    this.windowWeekdays = config.windowWeekdays || 7;

    // Catalogue semantics. Callers that already loaded the catalogue pass these
    // so we do not query it a second time; otherwise they are derived lazily.
    this._coSysId       = config.coSysId || null;
    this._compoundOcIds = config.compoundOcIds || null;
    this._semanticsProvided = !!config.compoundOcIds;
  },

  // ============================================================ //
  // Catalogue semantics                                           //
  // ============================================================ //

  /** sys_id of the shift type whose oc_role is consumes_co, or null. */
  coShiftId: function () {
    this._ensureSemantics();
    return this._coSysId;
  },

  /** True when this shift type grants a CO right (oc_role = grants_co). */
  isCompoundOc: function (sysId) {
    this._ensureSemantics();
    return !!this._compoundOcIds[sysId];
  },

  /**
   * CO and compound-OC shifts must be logged one day at a time: the
   * entitlement validation is too involved to apply across a bulk selection.
   * Only meaningful while entitlement is enabled.
   */
  blocksBulk: function (sysId) {
    if (!this.enabled) return false;
    return sysId === this.coShiftId() || this.isCompoundOc(sysId);
  },

  _ensureSemantics: function () {
    if (this._semanticsProvided) return;
    this._compoundOcIds = {};
    this._coSysId = null;
    var gr = new GlideRecord(this.catalogTable);
    gr.addQuery('active', true);
    gr.query();
    while (gr.next()) {
      var role = gr.getValue('oc_role') || 'none';
      if (role === 'consumes_co') this._coSysId = gr.getUniqueValue();
      if (role === 'grants_co')   this._compoundOcIds[gr.getUniqueValue()] = true;
    }
    this._semanticsProvided = true;
  },

  // ============================================================ //
  // Window queries (reads)                                        //
  // ============================================================ //

  /**
   * Every unconsumed entitlement for this user, in one query.
   *
   * Callers computing a whole month of allowed shifts should call this once and
   * pass the result to hasUnconsumedFor for each day, rather than querying per
   * day — that is what the calendar does.
   */
  loadUnconsumed: function () {
    var rows = [];
    if (!this.enabled) return rows;
    var gr = new GlideRecord(this.entitlementTable);
    gr.addQuery('u_user', this.userId);
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
  },

  /**
   * Is dateKey covered by an unconsumed window?
   *
   * Strictly after the OC date and on or before the window end — a CO can never
   * be taken on the OC day itself. String comparison is intentional.
   */
  hasUnconsumedFor: function (unconsumed, dateKey) {
    if (!this.enabled) return false;
    for (var i = 0; i < unconsumed.length; i++) {
      var e = unconsumed[i];
      if (e.oc_date < dateKey && e.window_end >= dateKey) return true;
    }
    return false;
  },

  // ============================================================ //
  // The three-phase day change                                    //
  // ============================================================ //

  /**
   * Phase 1 — undo whatever the day used to mean, before it is overwritten.
   *
   * Pass newShift as null/'' when clearing the day; the refusal wording differs
   * between changing and clearing, which is why the two are distinguished here
   * rather than by the caller.
   *
   * Refuses when the previous shift granted a CO that has since been taken:
   * removing it would leave the CO unpaid for.
   *
   * @return {{ok: boolean, error: string}}
   */
  releasePrevious: function (date, prevShift, newShift) {
    if (!this.enabled || !prevShift || prevShift === newShift) return { ok: true, error: '' };

    if (this.isCompoundOc(prevShift)) {
      var oldEnt = this._findByOcDate(date);
      if (oldEnt && oldEnt.co_entry) {
        return {
          ok: false,
          error: newShift
            ? 'Cannot change this entry — a CO on ' + oldEnt.co_date + ' depends on it.'
            : 'Cannot clear — CO on ' + oldEnt.co_date + ' depends on this entry.'
        };
      }
      if (oldEnt) this._deleteRow(oldEnt.sysid);
    }

    if (prevShift === this.coShiftId()) {
      var oldCoEnt = this._findConsumedByCoDate(date);
      if (oldCoEnt) this._release(oldCoEnt.sysid);
    }

    return { ok: true, error: '' };
  },

  /**
   * Phase 2 — claim an entitlement for a CO, BEFORE the day row is written.
   *
   * Checked up front so a CO that cannot be justified never reaches the
   * submission table; the caller writes the day only once this returns ok.
   *
   * @return {{ok: boolean, error: string, entitlementId: string|null}}
   */
  reserveForNew: function (date, newShift, prevShift) {
    if (!this.enabled || newShift === prevShift || newShift !== this.coShiftId()) {
      return { ok: true, error: '', entitlementId: null };
    }
    var ent = this._findEarliestUnconsumedFor(date);
    if (!ent) {
      return {
        ok: false,
        entitlementId: null,
        error: 'CO not available for ' + date + ' — log an OC+CO shift on a prior holiday first.'
      };
    }
    return { ok: true, error: '', entitlementId: ent.sysid };
  },

  /**
   * Phase 3 — record what the newly written day means, AFTER it exists.
   *
   * A grants_co shift opens a new window; a CO consumes the entitlement
   * reserved in phase 2. entrySysId must be the row just written, so the
   * entitlement can point back at it.
   */
  commitForNew: function (date, newShift, prevShift, entrySysId, entitlementId) {
    if (!this.enabled || newShift === prevShift) return;
    if (this.isCompoundOc(newShift)) this._insertRow(date, entrySysId);
    if (newShift === this.coShiftId() && entitlementId) {
      this._consume(entitlementId, date, entrySysId);
    }
  },

  // ============================================================ //
  // Table access                                                  //
  // ============================================================ //

  _findByOcDate: function (date) {
    var gr = new GlideRecord(this.entitlementTable);
    gr.addQuery('u_user',  this.userId);
    gr.addQuery('oc_date', date);
    gr.setLimit(1);
    gr.query();
    if (!gr.next()) return null;
    return {
      sysid:    gr.getUniqueValue(),
      co_entry: gr.getValue('u_co_entry'),
      co_date:  gr.getValue('u_co_date')
    };
  },

  _findConsumedByCoDate: function (date) {
    var gr = new GlideRecord(this.entitlementTable);
    gr.addQuery('u_user',    this.userId);
    gr.addQuery('u_co_date', date);
    gr.setLimit(1);
    gr.query();
    if (!gr.next()) return null;
    return { sysid: gr.getUniqueValue(), oc_date: gr.getValue('oc_date') };
  },

  /** Earliest still-open window covering date — oldest entitlement is spent first. */
  _findEarliestUnconsumedFor: function (date) {
    var gr = new GlideRecord(this.entitlementTable);
    gr.addQuery('u_user',           this.userId);
    gr.addNullQuery('u_co_entry');
    gr.addQuery('oc_date',          '<',  date);
    gr.addQuery('u_oc_window_end',  '>=', date);
    gr.orderBy('oc_date');
    gr.setLimit(1);
    gr.query();
    if (!gr.next()) return null;
    return { sysid: gr.getUniqueValue() };
  },

  _insertRow: function (date, entrySysId) {
    var gr = new GlideRecord(this.entitlementTable);
    gr.initialize();
    gr.setValue('u_user',          this.userId);
    gr.setValue('u_oc_entry',      entrySysId);
    gr.setValue('oc_date',         date);
    gr.setValue('u_oc_window_end', this._nthWeekdayAfter(date, this.windowWeekdays));
    gr.insert();
  },

  _consume: function (entSysId, coDate, coEntrySysId) {
    var gr = new GlideRecord(this.entitlementTable);
    if (!gr.get(entSysId)) return;
    gr.setValue('u_co_entry', coEntrySysId);
    gr.setValue('u_co_date',  coDate);
    gr.update();
  },

  _release: function (entSysId) {
    var gr = new GlideRecord(this.entitlementTable);
    if (!gr.get(entSysId)) return;
    gr.setValue('u_co_entry', null);
    gr.setValue('u_co_date',  null);
    gr.update();
  },

  _deleteRow: function (entSysId) {
    var gr = new GlideRecord(this.entitlementTable);
    if (!gr.get(entSysId)) return;
    gr.deleteRecord();
  },

  // ---- date utilities ----

  /** The date n weekdays after dateKey, skipping Saturdays and Sundays. */
  _nthWeekdayAfter: function (dateKey, n) {
    var p = dateKey.split('-');
    var d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
    var count = 0;
    while (count < n) {
      d.setDate(d.getDate() + 1);
      var dow = d.getDay();
      if (dow !== 0 && dow !== 6) count++;
    }
    return d.getFullYear() + '-' + this._pad(d.getMonth() + 1) + '-' + this._pad(d.getDate());
  },

  _pad: function (n) { return n < 10 ? '0' + n : '' + n; },

  type: 'ShiftPayEntitlements'
};
