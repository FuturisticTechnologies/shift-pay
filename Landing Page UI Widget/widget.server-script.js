(function () {
  var user = gs.getUser();

  data.firstName = user.getFirstName() || user.getDisplayName() || 'there';
  data.displayName = user.getDisplayName() || data.firstName;

  data.introText = options.intro_text || "Choose where you'd like to continue.";

  data.calendarTitle = options.calendar_title || 'My Shift Calendar';
  data.calendarDescription = options.calendar_description || 'Log and submit your monthly shifts.';
  data.calendarLinkLabel = options.calendar_link_label || 'Open calendar';
  data.calendarUrl = pageUrl(options.calendar_page_id, 'fill_shift');

  data.managerTitle = options.manager_title || 'Manager Approvals';
  data.managerDescription = options.manager_description || "Review and action your team's submitted timesheets.";
  data.managerLinkLabel = options.manager_link_label || 'Open approvals';
  data.managerUrl = pageUrl(options.manager_page_id, 'manager_approval');

  // Like the other two, always visible. The reporting widget resolves its own
  // scope server-side — an employee who opens it sees their own data and is
  // never offered the team or organisation scopes — so hiding the card here
  // would gate nothing and only make the page depend on a role check it has no
  // other reason to run.
  data.reportsTitle = options.reports_title || 'Reports';
  data.reportsDescription = options.reports_description || 'Track cost, shift mix and compensatory-off health over time.';
  data.reportsLinkLabel = options.reports_link_label || 'Open reports';
  data.reportsUrl = pageUrl(options.reports_page_id, 'shift_reports');

  // ── Compensatory-off balance ─────────────────────────────────────────────
  // Display only; nothing on this page writes. The count is read through
  // ShiftPayCalendarRules rather than by querying the entitlement table here,
  // so the tile can never disagree with what the calendar will actually let
  // this user log. Same reason the widgets share the rule layer at all.
  var CO_ENABLED = options.enable_co_entitlement !== false &&
                   options.enable_co_entitlement !== 'false';

  data.showCoBalance  = CO_ENABLED;
  data.coBalanceTitle = options.co_balance_title || 'Compensatory off';
  data.coBalance      = 0;
  data.coNextExpiry   = '';

  if (CO_ENABLED) {
    var rules = new ShiftPayCalendarRules({
      userId:           gs.getUserID(),
      catalogTable:     options.catalog_table || 'x_1995110_shift_0_shift_type',
      entitlementTable: options.entitlement_table || 'x_1995110_shift_0_shift_co_entitlement',
      coEnabled:        true
    });

    // Unused is not the same as remaining: loadUnconsumed also returns rows
    // whose window has closed. Those are not counted, matching what Reports
    // calls open rather than expired. A window ending today is still open.
    var unused = rules.entitlements().loadUnconsumed();
    var today  = todayKey();
    var open   = [];
    for (var u = 0; u < unused.length; u++) {
      if (unused[u].window_end >= today) open.push(unused[u]);
    }
    data.coBalance = open.length;

    // Earliest window end, so the tile can say what is about to lapse rather
    // than only how many days are owed. Dates are 'YYYY-MM-DD' and compared
    // lexically, which is the convention everywhere else in this app.
    for (var i = 0; i < open.length; i++) {
      if (!data.coNextExpiry || open[i].window_end < data.coNextExpiry) {
        data.coNextExpiry = open[i].window_end;
      }
    }
  }

  /** Today in the user's time zone, as 'YYYY-MM-DD'. */
  function todayKey() {
    var g = new GlideDateTime();
    return g.getYearLocalTime() + '-' +
           pad(parseInt(g.getMonthLocalTime(), 10)) + '-' +
           pad(parseInt(g.getDayOfMonthLocalTime(), 10));
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function pageUrl(value, fallback) {
    var pageId = String(value || fallback);
    if (!/^[A-Za-z0-9_-]+$/.test(pageId)) pageId = fallback;
    return '?id=' + encodeURIComponent(pageId);
  }
})();
