api.controller = function ($scope) {
  /**
   * Team Timesheet Approvals — Client Script
   * ========================================
   * Mirrors the calendar widget's contract: the server populates `data`, the
   * controller copies what it needs onto `c` at bootstrap, and every write goes
   * back through c.server.get({action: ...}) which re-runs the whole server
   * script and returns fresh `data`. After a write we re-seed from the response
   * rather than patching optimistically — an approve can legitimately be
   * refused server-side (stale screen, someone else got there first), and the
   * row must then show what the server says, not what we hoped.
   */
  var c = this;

  // ───── Bootstrap ──────────────────────────────────────────────────────────
  // data.rows            [{userId, name, initials, employeeId, status,
  //                        statusLabel, submittedOn, approver, actionedOn,
  //                        managerComment, mix[], totalShifts, weekdaysLogged,
  //                        canAction, totalAmount?, currency?}]
  // data.counts          {submitted, approved, rejected, notSubmitted, all}
  // data.totals          {pendingAmount, approvedAmount, currency} | null
  // data.showPay         boolean — false means amounts were never sent
  // data.weekdaysInMonth number
  // data.monthLabel      'August 2026'
  // data.canManage       boolean
  // data.actionError     string
  c.filter        = 'submitted';
  c.search        = '';
  c.saving        = false;
  c.rejecting     = null;   // the row being rejected, or null
  c.rejectComment = '';
  c.rejectError   = '';

  c.tabs = [
    { key: 'submitted',    label: 'Awaiting me',   count: 'submitted' },
    { key: 'approved',     label: 'Approved',      count: 'approved' },
    { key: 'rejected',     label: 'Rejected',      count: 'rejected' },
    { key: 'notSubmitted', label: 'Not submitted', count: 'notSubmitted' },
    { key: 'all',          label: 'All',           count: 'all' }
  ];

  var CURRENCY = { INR: '₹', USD: '$', GBP: '£', EUR: '€' };

  // NOTE: the initial c.recalc() runs at the BOTTOM of this controller, not
  // here. These are function expressions on `c`, not declarations, so they do
  // not hoist — calling recalc before its assignment throws and the widget
  // never renders.


  // ───── Public API ─────────────────────────────────────────────────────────

  c.setFilter = function (key) {
    c.filter = key;
    c.recalc();
  };

  /**
   * Rebuild the visible row list.
   *
   * Deliberately a materialised array rather than an ng-repeat filter
   * expression: a filter runs on every digest, and this list is re-derived only
   * when the tab, the search box or the server data actually change.
   */
  c.recalc = function () {
    var rows = (c.data && c.data.rows) || [];
    var needle = (c.search || '').toLowerCase().replace(/^\s+|\s+$/g, '');

    c.visible = rows.filter(function (r) {
      if (c.filter === 'notSubmitted') { if (r.status) return false; }
      else if (c.filter !== 'all')     { if (r.status !== c.filter) return false; }

      if (!needle) return true;
      return (r.name || '').toLowerCase().indexOf(needle) !== -1 ||
             (r.employeeId || '').toLowerCase().indexOf(needle) !== -1;
    });
  };

  c.prevMonth = function () {
    var y = c.data.year, m = c.data.month - 1;
    if (m < 0) { m = 11; y--; }
    loadMonth(y, m);
  };

  c.nextMonth = function () {
    var y = c.data.year, m = c.data.month + 1;
    if (m > 11) { m = 0; y++; }
    loadMonth(y, m);
  };

  c.approve = function (row) {
    if (!row || !row.canAction || c.saving) return;
    send({ action: 'approve', userId: row.userId, year: c.data.year, month: c.data.month });
  };

  c.openReject = function (row) {
    if (!row || !row.canAction) return;
    c.rejecting     = row;
    c.rejectComment = '';
    c.rejectError   = '';
  };

  c.cancelReject = function () {
    c.rejecting     = null;
    c.rejectComment = '';
    c.rejectError   = '';
  };

  c.confirmReject = function () {
    if (!c.rejecting || c.saving) return;
    var comment = (c.rejectComment || '').replace(/^\s+|\s+$/g, '');
    if (!comment) {
      // Belt and braces — the button is disabled and the server refuses too.
      c.rejectError = 'A reason is required to reject a timesheet.';
      return;
    }
    var row = c.rejecting;
    send({ action: 'reject', userId: row.userId, year: c.data.year, month: c.data.month, comment: comment },
         function () { c.cancelReject(); });
  };

  // ───── View helpers ───────────────────────────────────────────────────────

  /** Chip fill straight from the catalogue, with a neutral fallback. */
  c.chipStyle = function (hex) {
    return { background: hex || '#64748B' };
  };

  /**
   * Status is monochrome by design — see the template header. Hue is reserved
   * for shift types, so these differ by fill and weight only.
   */
  c.pillClass = function (status) {
    if (status === 'submitted') return 'shift-mgr__pill--pending';
    if (status === 'approved')  return 'shift-mgr__pill--approved';
    if (status === 'rejected')  return 'shift-mgr__pill--rejected';
    return 'shift-mgr__pill--idle';
  };

  c.pillGlyph = function (status) {
    if (status === 'submitted') return '●';  // filled circle — needs action
    if (status === 'approved')  return '✓';  // check
    if (status === 'rejected')  return '✕';  // cross
    return '○';                              // hollow circle — nothing yet
  };

  c.money = function (amount, currency) {
    if (amount === null || amount === undefined) return '';
    var sym = CURRENCY[currency || 'INR'] || '';
    var n = Math.round(Number(amount) || 0);
    return sym + groupDigits(n);
  };


  // ───── Internals ──────────────────────────────────────────────────────────

  function loadMonth(y, m) {
    c.saving = true;
    c.cancelReject();
    c.server.get({ action: 'loadQueue', year: y, month: m }).then(function (r) {
      c.data   = r.data;
      c.saving = false;
      c.recalc();
    });
  }

  function send(payload, onDone) {
    c.saving = true;
    c.server.get(payload).then(function (r) {
      c.data   = r.data;
      c.saving = false;
      c.recalc();
      if (onDone) onDone();
    }, function () {
      c.saving = false;
    });
  }

  /**
   * Indian digit grouping (1,84,500) — the last three digits, then pairs.
   * toLocaleString('en-IN') is not dependable across the browsers Service Portal
   * has to support, so this is done explicitly.
   */
  function groupDigits(n) {
    var neg = n < 0;
    var s = Math.abs(n).toString();
    if (s.length <= 3) return (neg ? '-' : '') + s;
    var last3 = s.slice(-3);
    var rest  = s.slice(0, -3);
    rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    return (neg ? '-' : '') + rest + ',' + last3;
  }


  // ───── Boot ───────────────────────────────────────────────────────────────
  // Last, so every function expression above is assigned before it is called.
  c.recalc();
};
