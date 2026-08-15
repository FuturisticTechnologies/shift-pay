(function () {
  /**
   * ShiftPay Reporting — Server Script
   * ==================================
   * Six reports over the data the rest of ShiftPay already writes: cost/shift
   * trend, shift-type mix, team comparison, a person-by-month activity
   * heatmap, submission/approval timeliness, and CO entitlement health.
   *
   * READ-ONLY. There is no action dispatcher here and there must never be one.
   * Every request re-runs this whole script with `input.scope` / `input.year` /
   * `input.month` / `input.months` and returns a fresh `data` — the same
   * contract as the other widgets, minus the writes.
   *
   * THE SOURCE IS THE SUMMARY TABLE, NOT THE DAY TABLE. u_shift_submission_summary
   * already holds one row per user per period per shift type, with u_amount and
   * u_rate_snapshot frozen at compute time. Reporting off the day rows instead
   * would mean re-deriving pay at read time against *today's* catalogue rates,
   * so a rate change would silently rewrite history and the charts would stop
   * agreeing with what the manager approved. Read the snapshot.
   *
   * Nothing about shift semantics is reimplemented: ShiftPayCalendarRules
   * supplies the catalogue, its colours and its semantic columns. In particular
   * "on-call load" is derived from allow_weekend_holiday / allow_weekday, never
   * from a shift type called "OC" — see ON-CALL below.
   *
   * SECURITY. `data.scope` is resolved server-side against what this user is
   * actually allowed to see; `input.scope` is a request, not an instruction. A
   * scope the caller is not entitled to falls back to 'me' rather than erroring,
   * and the user-id filter is applied to every query through applyScope(). This
   * matters more here than anywhere else in the app: c.server.get({scope:'org'})
   * is one line of typing in a browser console.
   *
   * Month convention matches the rest of ShiftPay:
   *   input.month / data.month / internal maps  →  0-indexed (0 = January)
   *   stored u_month on summary / timesheet     →  1-indexed
   *
   * Scoped app → ES5 only (Rhino): no let/const, arrow functions or template
   * literals in this file.
   */

  var TABLE_SUM  = options.summary_table     || 'x_1995110_shift_0_shift_submission_summary';
  var TABLE_CAT  = options.catalog_table     || 'x_1995110_shift_0_shift_type';
  var TABLE_ENT  = options.entitlement_table || 'x_1995110_shift_0_shift_co_entitlement';
  var TABLE_LOCK = options.lock_table        || 'x_1995110_shift_0_monthly_timesheet';

  var MANAGER_FIELD = options.manager_field || 'manager';
  var ORG_ROLE      = options.org_role      || 'x_1995110_shift_0.admin';

  var USER_ID = gs.getUserID();

  // How many months the trend covers, ending at the selected month. The client
  // can change it within bounds; anything outside them is a hand-made payload
  // and gets the default rather than an unbounded scan.
  var TREND_MONTHS = bounded((input && input.months !== undefined && input.months !== null)
                               ? input.months : options.trend_months, 12, 1, 36);

  // How many people the comparison chart draws. A bar chart of 400 names is not
  // a report, and the query behind it is not one either.
  var TEAM_LIMIT = bounded(options.team_limit, 25, 1, 100);

  // How many "window closing soon" entitlements the CO tab lists.
  var SOON_LIMIT = 12;

  // Same semantics as the manager widget: when off, no monetary value is put on
  // `data` at all. Stripped, not hidden — a template-only guard is no guard.
  var SHOW_PAY = boolOption(options.show_pay_amounts, true);

  // Must match the calendar and the approval widget. When off, the CO tab is not
  // offered and the entitlement table is never read.
  var CO_ENABLED = boolOption(options.enable_co_entitlement, true);

  data.showPay   = SHOW_PAY;
  data.coEnabled = CO_ENABLED;

  // The client injects this only if window.Chart is missing — see the client
  // script. Wiring a proper sp_js_include / sp_dependency makes it a no-op.
  data.chartLibUrl = trim(options.chart_lib_url) ||
                     'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';

  // Declared here, not down with the other utilities: `var` hoists the
  // declaration but not the assignment, and buildWindow() runs long before the
  // bottom of this file is reached.
  var SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var TODAY = todayKey();


  // ── Who this user may report on ──────────────────────────────────────────
  // Built before anything is read: it is the authorisation set, and every query
  // below is filtered through it.
  var reporteeIds = loadReporteeIds();

  data.scopes = [{ key: 'me', label: 'My data', hint: 'Your own shifts' }];
  if (reporteeIds.length) {
    data.scopes.push({
      key:   'team',
      label: 'My team',
      hint:  reporteeIds.length + ' direct ' + (reporteeIds.length === 1 ? 'reportee' : 'reportees')
    });
  }
  if (gs.hasRole(ORG_ROLE)) {
    data.scopes.push({ key: 'org', label: 'Organisation', hint: 'Everyone with shift data' });
  }

  var SCOPE = resolveScope(input && input.scope);
  data.scope = SCOPE;

  // null means "no user filter" — the org scope, and the only scope that reaches
  // records belonging to nobody in particular.
  var SCOPE_IDS = SCOPE === 'me'   ? [USER_ID]
                : SCOPE === 'team' ? reporteeIds
                :                    null;

  // The team comparison is meaningless with a single person in scope.
  data.showTeam = SCOPE !== 'me';


  // ── Which months ─────────────────────────────────────────────────────────
  // Clamped, not merely parsed. The other widgets take the anchor month from
  // their own navigation buttons; this one also feeds it straight into a window
  // calculation and a set of month labels, so a hand-made month:99 would produce
  // "undefined 2026" and a window of keys that match nothing.
  var now = new GlideDateTime();
  data.year  = bounded((input && input.year  != null) ? input.year  : null,
                       parseInt(now.getYearLocalTime(), 10), 1970, 2999);
  data.month = bounded((input && input.month != null) ? input.month : null,
                       parseInt(now.getMonthLocalTime(), 10) - 1, 0, 11);
  data.monthLabel   = monthLabel(data.year, data.month);
  data.trendMonths  = TREND_MONTHS;
  data.spanOptions  = [3, 6, 12, 24];

  var WINDOW = buildWindow(data.year, data.month, TREND_MONTHS);
  data.periodLabel = WINDOW.periods.length > 1
    ? WINDOW.periods[0].label + ' – ' + WINDOW.periods[WINDOW.periods.length - 1].label
    : WINDOW.periods[0].label;


  // ── Catalogue ────────────────────────────────────────────────────────────
  // Read through ShiftPayCalendarRules so colours, names and semantics are the
  // same objects the calendar and the approval queue use. The catalogue is
  // user-independent, so one read serves every scope.
  var RULES       = new ShiftPayCalendarRules({ catalogTable: TABLE_CAT, coEnabled: CO_ENABLED });
  var catalogue   = RULES.catalogue();
  var catalogById = RULES.catalogById();
  data.configError = RULES.configError();

  /**
   * ON-CALL: shift types that may only be logged on a weekend or a declared
   * holiday. Derived from the semantic columns, exactly as the calendar derives
   * availability — a shift type is "on-call load" because of when it can be
   * worked, not because it is spelt OC. Renaming or adding a weekend-only shift
   * type moves this set with no code change.
   */
  var onCallIds = {};
  for (var ci = 0; ci < catalogue.length; ci++) {
    if (catalogue[ci].allow_weekend_holiday && !catalogue[ci].allow_weekday) {
      onCallIds[catalogue[ci].sys_id] = true;
    }
  }


  // ── Build the report ─────────────────────────────────────────────────────
  var report = readSummary();

  data.trend   = report.trend;                 // one entry per month in the window
  data.mix     = report.mix;                   // per shift type, over the window
  data.totals  = report.totals;

  // Both people-shaped reports are built from one name lookup over the union of
  // their two capped sets.
  if (data.showTeam) {
    var teamRank = rankUsers(report.perUser, SHOW_PAY ? 'amount' : 'shifts');
    var actRank  = rankUsers(report.perUser, 'shifts');
    var people   = readPeople(teamRank.rows.concat(actRank.rows), 'userId');

    data.team           = nameRows(teamRank.rows, people);
    data.activity       = buildActivity(nameRows(actRank.rows, people), report.perUserMonth);
    data.teamTruncated  = teamRank.truncated;
    data.teamLimit      = TEAM_LIMIT;
  } else {
    data.team     = [];
    data.activity = null;
  }

  data.co       = CO_ENABLED ? readCoHealth() : null;
  data.approval = readApproval();

  data.hasData = report.totals.shifts > 0;


  // ============================================================ //
  // Scope + authorisation                                        //
  // ============================================================ //

  /**
   * The requested scope if this user is entitled to it, otherwise 'me'.
   *
   * Checked against data.scopes, which was built from the reportee list and the
   * role — so there is exactly one place that decides what is permitted, and the
   * dropdown the client draws is that same list.
   */
  function resolveScope(requested) {
    var want = trim(requested) || 'me';
    for (var i = 0; i < data.scopes.length; i++) {
      if (data.scopes[i].key === want) return want;
    }
    if (want !== 'me') {
      gs.warn('[ShiftPay] ' + USER_ID + ' requested reporting scope "' + want +
              '" without entitlement; fell back to own data.');
    }
    return 'me';
  }

  /** Apply the scope's user filter to a query. No-op for the org scope. */
  function applyScope(gr, field) {
    if (!SCOPE_IDS) return;
    gr.addQuery(field, 'IN', SCOPE_IDS.join(','));
  }

  function loadReporteeIds() {
    var ids = [];
    var gr = new GlideRecord('sys_user');
    gr.addQuery(MANAGER_FIELD, USER_ID);
    gr.addQuery('active', true);
    gr.query();
    while (gr.next()) ids.push(gr.getUniqueValue());
    return ids;
  }


  // ============================================================ //
  // The window                                                   //
  // ============================================================ //

  /**
   * The N months ending at (year, month), oldest first, plus the lookups the
   * reads need.
   *
   * `index` is what makes the summary read a single query: a (year, month) pair
   * cannot be expressed as one range in GlideRecord, so the query bounds by year
   * and this map discards the months that fall outside the window.
   */
  function buildWindow(y, m, n) {
    var periods = [], index = {}, yearSet = {};
    var startY = y, startM = m - (n - 1);
    while (startM < 0) { startM += 12; startY--; }

    var cy = startY, cm = startM;
    for (var i = 0; i < n; i++) {
      periods.push({
        y:     cy,
        m:     cm,
        key:   cy + '|' + cm,
        label: SHORT_MONTHS[cm] + ' ' + String(cy).slice(2)
      });
      index[cy + '|' + cm] = i;
      yearSet[cy] = true;
      cm++;
      if (cm > 11) { cm = 0; cy++; }
    }

    var years = [];
    for (var k in yearSet) years.push(k);

    return {
      periods:   periods,
      index:     index,
      years:     years,
      startDate: periods[0].y + '-' + pad(periods[0].m + 1) + '-01',
      endDate:   y + '-' + pad(m + 1) + '-' + pad(daysInMonth(y, m))
    };
  }


  // ============================================================ //
  // Reads                                                        //
  // ============================================================ //

  /**
   * One pass over the monthly summary rows in the window, feeding every
   * summary-derived report at once.
   *
   * Deliberately a single query: trend (by month), mix (by shift type),
   * per-person totals and per-person-per-month are four groupings of the same
   * rows, and running four queries would let them disagree if a recompute
   * landed between them.
   */
  function readSummary() {
    var trend = [];
    for (var p = 0; p < WINDOW.periods.length; p++) {
      trend.push({
        key:    WINDOW.periods[p].key,
        label:  WINDOW.periods[p].label,
        year:   WINDOW.periods[p].y,
        month:  WINDOW.periods[p].m,
        shifts: 0,
        onCall: 0,
        amount: SHOW_PAY ? 0 : null,
        people: 0
      });
    }
    var trendPeople = [];   // one seen-set per month, so `people` is distinct
    for (var t = 0; t < trend.length; t++) trendPeople.push({});

    var mixMap   = {};      // shiftId -> bucket
    var perUser  = {};      // userId  -> {shifts, onCall, amount}
    // userId -> array of shift counts, one slot per month in the window. The
    // activity heatmap's whole data set, produced by the same pass rather than
    // by a second query — it is the cross-product of the two groupings already
    // being built here.
    var perUserMonth = {};
    var seenUser     = {};
    var totals   = { shifts: 0, onCall: 0, amount: SHOW_PAY ? 0 : null,
                     people: 0, currency: 'INR' };

    var gr = new GlideRecord(TABLE_SUM);
    gr.addQuery('u_period_type', 'month');
    gr.addQuery('u_year', 'IN', WINDOW.years.join(','));
    applyScope(gr, 'u_user');
    gr.query();

    while (gr.next()) {
      var y   = parseInt(gr.getValue('u_year'),  10);
      var m   = parseInt(gr.getValue('u_month'), 10) - 1;   // stored 1-indexed
      var idx = WINDOW.index[y + '|' + m];
      if (idx === undefined) continue;                      // year matched, month did not

      var uid    = gr.getValue('u_user');
      var sid    = gr.getValue('u_shift_type');
      var count  = parseInt(gr.getValue('u_count'), 10) || 0;
      var amount = parseFloat(gr.getValue('u_amount')) || 0;
      var onCall = onCallIds[sid] ? count : 0;
      if (!count) continue;

      totals.currency = gr.getValue('u_currency') || totals.currency;

      // ── trend ──
      trend[idx].shifts += count;
      trend[idx].onCall += onCall;
      if (SHOW_PAY) trend[idx].amount += amount;
      if (uid && !trendPeople[idx][uid]) {
        trendPeople[idx][uid] = true;
        trend[idx].people++;
      }

      // ── mix ──
      if (!mixMap[sid]) {
        var cat = catalogById[sid] || {};
        mixMap[sid] = {
          shiftId:      sid,
          // A shift type deactivated after being logged is no longer in the
          // catalogue, but its summary rows are still payroll truth — label it
          // rather than dropping it.
          name:         cat.name || '(removed shift type)',
          description:  cat.description || '',
          color_hex:    cat.color_hex || '',
          day_category: cat.day_category || '',
          count:        0,
          amount:       SHOW_PAY ? 0 : null
        };
      }
      mixMap[sid].count += count;
      if (SHOW_PAY) mixMap[sid].amount += amount;

      // ── per person, and per person per month ──
      if (uid) {
        if (!perUser[uid]) {
          perUser[uid] = { shifts: 0, onCall: 0, amount: SHOW_PAY ? 0 : null };
          perUserMonth[uid] = newZeroRow(trend.length);
        }
        perUser[uid].shifts += count;
        perUser[uid].onCall += onCall;
        if (SHOW_PAY) perUser[uid].amount += amount;
        perUserMonth[uid][idx] += count;
        if (!seenUser[uid]) { seenUser[uid] = true; totals.people++; }
      }

      // ── totals ──
      totals.shifts += count;
      totals.onCall += onCall;
      if (SHOW_PAY) totals.amount += amount;
    }

    // Catalogue order, so the donut's slices and the legend match the chips the
    // calendar draws.
    var mix = [];
    for (var s = 0; s < catalogue.length; s++) {
      if (mixMap[catalogue[s].sys_id]) {
        mix.push(mixMap[catalogue[s].sys_id]);
        delete mixMap[catalogue[s].sys_id];
      }
    }
    for (var leftover in mixMap) mix.push(mixMap[leftover]);   // deactivated types, last

    return {
      trend: trend, mix: mix, totals: totals,
      perUser: perUser, perUserMonth: perUserMonth
    };
  }

  function newZeroRow(n) {
    var a = [];
    for (var i = 0; i < n; i++) a.push(0);
    return a;
  }

  /**
   * Rank the people in scope by one measure and cap the list.
   *
   * Two reports want a ranked, capped set and they want different orderings:
   * the comparison chart leads on cost, the activity heatmap on volume. Ranking
   * is therefore a parameter, and the two capped sets are unioned for a single
   * name lookup rather than each running its own.
   */
  function rankUsers(perUser, measure) {
    var rows = [];
    for (var uid in perUser) {
      rows.push({
        userId: uid,
        shifts: perUser[uid].shifts,
        onCall: perUser[uid].onCall,
        // The comparison bars stack: weekday work below, on-call above,
        // summing to the person's total.
        weekday: perUser[uid].shifts - perUser[uid].onCall,
        amount: perUser[uid].amount
      });
    }
    rows.sort(function (a, b) { return (b[measure] || 0) - (a[measure] || 0); });
    var truncated = rows.length > TEAM_LIMIT;
    return { rows: truncated ? rows.slice(0, TEAM_LIMIT) : rows, truncated: truncated };
  }

  function nameRows(rows, people) {
    for (var i = 0; i < rows.length; i++) {
      var p = people[rows[i].userId] || { name: '(unknown user)', initials: '?', employeeId: '' };
      rows[i].name       = p.name;
      rows[i].initials   = p.initials;
      rows[i].employeeId = p.employeeId;
    }
    return rows;
  }

  /**
   * The activity heatmap: one row per person, one cell per month in the window.
   *
   * Answers "who has been carrying the shifts, and when" — a question neither
   * the trend (which flattens people) nor the comparison chart (which flattens
   * months) can answer, because each collapses the axis the other keeps.
   *
   * `max` is sent with the grid so the client can scale cell intensity without
   * a second pass over the data. It is the busiest single person-month in the
   * window, so the darkest cell is always a real observation rather than an
   * arbitrary ceiling.
   */
  function buildActivity(rows, perUserMonth) {
    var months = [];
    for (var p = 0; p < WINDOW.periods.length; p++) {
      months.push({ key: WINDOW.periods[p].key, label: WINDOW.periods[p].label });
    }

    var max = 0;
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var cells = perUserMonth[rows[i].userId] || newZeroRow(months.length);
      for (var m = 0; m < cells.length; m++) if (cells[m] > max) max = cells[m];
      out.push({
        userId:     rows[i].userId,
        name:       rows[i].name,
        initials:   rows[i].initials,
        employeeId: rows[i].employeeId,
        total:      rows[i].shifts,
        onCall:     rows[i].onCall,
        cells:      cells
      });
    }

    return { months: months, rows: out, max: max };
  }

  /**
   * CO entitlement health over the window, keyed on when the OC was worked.
   *
   * Four states, and they partition the set: consumed (a CO was taken against
   * it), open (unused, window still runs), expired (unused, window closed), and
   * — the one worth acting on — closing soon.
   *
   * Windows are compared as 'YYYY-MM-DD' strings, which is the same lexical
   * comparison ShiftPayEntitlements uses to decide the same question.
   */
  function readCoHealth() {
    var out = { earned: 0, consumed: 0, open: 0, expired: 0, soon: [] };

    var gr = new GlideRecord(TABLE_ENT);
    gr.addQuery('oc_date', '>=', WINDOW.startDate);
    gr.addQuery('oc_date', '<=', WINDOW.endDate);
    applyScope(gr, 'u_user');
    gr.orderBy('u_oc_window_end');
    gr.query();

    var openRows = [];
    while (gr.next()) {
      out.earned++;
      var coDate = gr.getValue('u_co_date');
      if (coDate) { out.consumed++; continue; }

      var windowEnd = gr.getValue('u_oc_window_end') || '';
      if (windowEnd && windowEnd < TODAY) { out.expired++; continue; }

      out.open++;
      if (openRows.length < SOON_LIMIT) {
        openRows.push({
          userId:    gr.getValue('u_user'),
          ocDate:    gr.getValue('oc_date'),
          windowEnd: windowEnd,
          // Calendar days, not weekdays. The window itself is 7 *weekdays* wide
          // (ShiftPayEntitlements owns that arithmetic); this is only "how long
          // have I got", so a plain day count is the honest, readable answer.
          daysLeft:  windowEnd ? daysBetween(TODAY, windowEnd) : null
        });
      }
    }

    // Ordered by u_oc_window_end already, so the first SOON_LIMIT open rows are
    // the most urgent ones.
    var people = readPeople(openRows, 'userId');
    for (var i = 0; i < openRows.length; i++) {
      var p = people[openRows[i].userId] || { name: '(unknown user)', initials: '?' };
      openRows[i].name     = p.name;
      openRows[i].initials = p.initials;
    }
    out.soon = openRows;
    return out;
  }

  /**
   * Submission and approval state for the months in the window, plus how long
   * each stage actually took.
   *
   * Two jobs. The totals are the context strip above every chart — a trend that
   * dips in the latest month usually means "not submitted yet" rather than
   * "cost fell", and without this the chart quietly lies about the current
   * month. The per-month lags are the Timeliness report: the process measure
   * that says whether the pay data is arriving on time and being actioned, as
   * opposed to what is in it.
   *
   * Both lags are measured in whole days and both can be negative, which is
   * reported rather than clamped: the submission window opens on the last
   * weekday of the month, so submitting a day early is legitimate and "-1"
   * is the honest number. Clamping at zero would quietly turn early submitters
   * into on-the-day submitters.
   */
  function readApproval() {
    var out = {
      submitted: 0, approved: 0, rejected: 0, latestPending: 0,
      months: [], avgSubmitLag: null, avgDecisionLag: null
    };
    var latestKey = data.year + '|' + data.month;

    for (var p = 0; p < WINDOW.periods.length; p++) {
      out.months.push({
        key:   WINDOW.periods[p].key,
        label: WINDOW.periods[p].label,
        submitted: 0, approved: 0, rejected: 0,
        submitLag: null, decisionLag: null,
        _sLagSum: 0, _sLagN: 0, _dLagSum: 0, _dLagN: 0
      });
    }

    var sLagSum = 0, sLagN = 0, dLagSum = 0, dLagN = 0;

    var gr = new GlideRecord(TABLE_LOCK);
    gr.addQuery('u_year', 'IN', WINDOW.years.join(','));
    applyScope(gr, 'u_user');
    gr.query();

    while (gr.next()) {
      var y   = parseInt(gr.getValue('u_year'),  10);
      var m   = parseInt(gr.getValue('u_month'), 10) - 1;
      var idx = WINDOW.index[y + '|' + m];
      if (idx === undefined) continue;
      var bucket = out.months[idx];

      // Rows written before the status column existed read empty; their mere
      // presence meant "submitted", same reading as the approval widget.
      var st = gr.getValue('status') || 'submitted';
      if (st === 'submitted')     { out.submitted++; bucket.submitted++; }
      else if (st === 'approved') { out.approved++;  bucket.approved++;  }
      else if (st === 'rejected') { out.rejected++;  bucket.rejected++;  }

      if (st === 'submitted' && (y + '|' + m) === latestKey) out.latestPending++;

      // ── how long after the month closed did this arrive ──
      var submittedOn = dateOf(gr.getValue('u_submitted_on'));
      if (submittedOn) {
        var monthEnd = y + '-' + pad(m + 1) + '-' + pad(daysInMonth(y, m));
        var sLag = daysBetween(monthEnd, submittedOn);
        bucket._sLagSum += sLag; bucket._sLagN++;
        sLagSum += sLag; sLagN++;

        // ── and how long did the manager then take ──
        var actionedOn = dateOf(gr.getValue('actioned_on'));
        if (actionedOn && (st === 'approved' || st === 'rejected')) {
          var dLag = daysBetween(submittedOn, actionedOn);
          bucket._dLagSum += dLag; bucket._dLagN++;
          dLagSum += dLag; dLagN++;
        }
      }
    }

    // null, not zero, where nothing was measured — a month with no submissions
    // has no lag, and drawing it as a zero-day turnaround would read as the best
    // month on the chart.
    for (var i = 0; i < out.months.length; i++) {
      var b = out.months[i];
      b.submitLag   = b._sLagN ? round1(b._sLagSum / b._sLagN) : null;
      b.decisionLag = b._dLagN ? round1(b._dLagSum / b._dLagN) : null;
      delete b._sLagSum; delete b._sLagN; delete b._dLagSum; delete b._dLagN;
    }
    out.avgSubmitLag   = sLagN ? round1(sLagSum / sLagN) : null;
    out.avgDecisionLag = dLagN ? round1(dLagSum / dLagN) : null;
    return out;
  }

  /**
   * The date part of a stored datetime, or ''.
   *
   * Day granularity is deliberate. These lags are reported to a tenth of a day
   * across a month of submissions; carrying the clock time would imply a
   * precision that a "submitted on the 3rd" business process does not have.
   */
  function dateOf(value) {
    var s = trim(value);
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.substring(0, 10) : '';
  }

  function round1(n) { return Math.round(n * 10) / 10; }

  /**
   * Display names for a set of rows, in one query.
   *
   * Read from sys_user rather than from the reportee list: the org scope
   * reaches people who report to nobody here, and someone who has since left a
   * team should still have a name on the chart.
   */
  function readPeople(rows, field) {
    var idSet = {}, ids = [];
    for (var i = 0; i < rows.length; i++) {
      var id = rows[i][field];
      if (id && !idSet[id]) { idSet[id] = true; ids.push(id); }
    }
    var map = {};
    if (!ids.length) return map;

    var gr = new GlideRecord('sys_user');
    gr.addQuery('sys_id', 'IN', ids.join(','));
    gr.query();
    while (gr.next()) {
      var nm = gr.getValue('name') || gr.getValue('user_name') || '';
      map[gr.getUniqueValue()] = {
        name:       nm,
        initials:   initialsOf(nm),
        employeeId: gr.getValue('employee_number') || ''
      };
    }
    return map;
  }


  // ============================================================ //
  // Utilities                                                    //
  // ============================================================ //

  function monthLabel(y, m) {
    var names = ['January', 'February', 'March', 'April', 'May', 'June',
                 'July', 'August', 'September', 'October', 'November', 'December'];
    return names[m] + ' ' + y;
  }

  /** Today as 'YYYY-MM-DD' in the user's timezone, matching how dates are stored. */
  function todayKey() {
    var g = new GlideDateTime();
    return g.getYearLocalTime() + '-' +
           pad(parseInt(g.getMonthLocalTime(), 10)) + '-' +
           pad(parseInt(g.getDayOfMonthLocalTime(), 10));
  }

  /** Whole days from `from` to `to`, both 'YYYY-MM-DD'. Negative if `to` is past. */
  function daysBetween(from, to) {
    var a = from.split('-'), b = to.split('-');
    var da = Date.UTC(parseInt(a[0], 10), parseInt(a[1], 10) - 1, parseInt(a[2], 10));
    var db = Date.UTC(parseInt(b[0], 10), parseInt(b[1], 10) - 1, parseInt(b[2], 10));
    return Math.round((db - da) / 86400000);
  }

  function initialsOf(name) {
    if (!name) return '?';
    var parts = name.replace(/\s+/g, ' ').split(' ');
    var first = parts[0] ? parts[0].charAt(0) : '';
    var last  = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
    return (first + last).toUpperCase() || '?';
  }

  /** A widget boolean option, which arrives as a real boolean or as a string. */
  function boolOption(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    return value === true || value === 'true';
  }

  /** An integer option clamped to a sane range, falling back if unparseable. */
  function bounded(value, fallback, min, max) {
    var n = parseInt(value, 10);
    if (isNaN(n)) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  function trim(s) {
    if (s === null || s === undefined) return '';
    return ('' + s).replace(/^\s+|\s+$/g, '');
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

})();
