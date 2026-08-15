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
  c.detailCells   = [];     // month grid for the open detail panel
  c.historyVisible = [];    // decision log rows, after the search filter
  c.correcting    = null;   // the day being corrected, or null
  c.selected      = {};     // userId → true, for the bulk actions
  c.bulkRejecting = false;  // the bulk reject dialog is open
  c.bulkComment   = '';
  c.bulkError     = '';
  c.weekdayNames  = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // The first five filter the selected month. History is the odd one out: it
  // spans every month, so it has no count from data.counts and it ignores the
  // month picker entirely.
  c.tabs = [
    { key: 'submitted',    label: 'Awaiting me',   count: 'submitted' },
    { key: 'approved',     label: 'Approved',      count: 'approved' },
    { key: 'rejected',     label: 'Rejected',      count: 'rejected' },
    { key: 'notSubmitted', label: 'Not submitted', count: 'notSubmitted' },
    { key: 'all',          label: 'All',           count: 'all' },
    { key: 'history',      label: 'History',       count: null }
  ];

  var CURRENCY = { INR: '₹', USD: '$', GBP: '£', EUR: '€' };

  // NOTE: the initial c.recalc() runs at the BOTTOM of this controller, not
  // here. These are function expressions on `c`, not declarations, so they do
  // not hoist — calling recalc before its assignment throws and the widget
  // never renders.


  // ───── Public API ─────────────────────────────────────────────────────────

  c.setFilter = function (key) {
    c.filter = key;
    // Selection is per view. Carrying it across tabs would let a manager
    // bulk-action rows they can no longer see, which is how accidents happen.
    c.clearSelection();
    c.recalc();
    // History is a whole-history query, so it is fetched the first time the tab
    // is opened rather than on every load of the screen.
    if (key === 'history' && !c.data.history && !c.saving) loadHistory();
  };

  /** Re-fetch the decision log — it is stale as soon as anything is actioned. */
  c.refreshHistory = function () {
    if (!c.saving) loadHistory();
  };

  // ───── Bulk selection ─────────────────────────────────────────────────────
  // Only actionable (submitted) rows are ever selectable — the server enforces
  // the same rule per row, so a stale screen is refused rather than forced.

  c.clearSelection = function () {
    c.selected      = {};
    c.bulkRejecting = false;
    c.bulkComment   = '';
    c.bulkError     = '';
  };

  c.toggleRow = function (row) {
    if (!row || !row.canAction) return;
    if (c.selected[row.userId]) delete c.selected[row.userId];
    else c.selected[row.userId] = true;
  };

  c.selectedIds = function () {
    var ids = [], visible = c.visible || [];
    // Derived from what is on screen, so a row filtered out of view can never
    // be swept into a bulk action by a stale entry in the map.
    for (var i = 0; i < visible.length; i++) {
      if (visible[i].canAction && c.selected[visible[i].userId]) ids.push(visible[i].userId);
    }
    return ids;
  };

  c.selectedCount = function () { return c.selectedIds().length; };

  c.actionableCount = function () {
    var n = 0, visible = c.visible || [];
    for (var i = 0; i < visible.length; i++) if (visible[i].canAction) n++;
    return n;
  };

  c.allSelected = function () {
    var total = c.actionableCount();
    return total > 0 && c.selectedCount() === total;
  };

  c.toggleAll = function () {
    var select = !c.allSelected();
    var visible = c.visible || [];
    c.selected = {};
    if (select) {
      for (var i = 0; i < visible.length; i++) {
        if (visible[i].canAction) c.selected[visible[i].userId] = true;
      }
    }
  };

  c.bulkApprove = function () {
    var ids = c.selectedIds();
    if (!ids.length || c.saving) return;
    send({ action: 'bulkApprove', userIds: ids, year: c.data.year, month: c.data.month },
         function () { c.clearSelection(); });
  };

  c.openBulkReject = function () {
    if (!c.selectedCount()) return;
    c.bulkRejecting = true;
    c.bulkComment   = '';
    c.bulkError     = '';
  };

  c.cancelBulkReject = function () {
    c.bulkRejecting = false;
    c.bulkComment   = '';
    c.bulkError     = '';
  };

  c.confirmBulkReject = function () {
    if (!c.bulkRejecting || c.saving) return;
    var comment = (c.bulkComment || '').replace(/^\s+|\s+$/g, '');
    if (!comment) {
      c.bulkError = 'A reason is required to reject a timesheet.';
      return;
    }
    var ids = c.selectedIds();
    if (!ids.length) {
      c.bulkError = 'Nothing selected.';
      return;
    }
    // One comment applied to every rejected timesheet — FR-M7.
    send({ action: 'bulkReject', userIds: ids, comment: comment,
           year: c.data.year, month: c.data.month },
         function () { c.clearSelection(); });
  };

  /**
   * Rebuild the visible row list.
   *
   * Deliberately a materialised array rather than an ng-repeat filter
   * expression: a filter runs on every digest, and this list is re-derived only
   * when the tab, the search box or the server data actually change.
   */
  c.recalc = function () {
    var needle = (c.search || '').toLowerCase().replace(/^\s+|\s+$/g, '');

    function matches(r) {
      if (!needle) return true;
      return (r.name || '').toLowerCase().indexOf(needle) !== -1 ||
             (r.employeeId || '').toLowerCase().indexOf(needle) !== -1;
    }

    // History spans every month and has no per-month status filter, so it is
    // derived separately and the queue list is emptied — nothing selectable,
    // nothing actionable, no bulk bar.
    if (c.filter === 'history') {
      c.visible = [];
      c.historyVisible = ((c.data && c.data.history) || []).filter(matches);
      return;
    }

    c.historyVisible = [];
    var rows = (c.data && c.data.rows) || [];
    c.visible = rows.filter(function (r) {
      if (c.filter === 'notSubmitted') { if (r.status) return false; }
      else if (c.filter !== 'all')     { if (r.status !== c.filter) return false; }
      return matches(r);
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

  /** Drill into one reportee's month. The detail is fetched, never derived. */
  c.openDetail = function (row) {
    if (!row || c.saving) return;
    c.saving = true;
    c.server.get({ action: 'loadDetail', userId: row.userId, year: c.data.year, month: c.data.month })
      .then(function (r) {
        c.data   = r.data;
        c.saving = false;
        c.recalc();
        c.detailCells = c.data.detail ? buildDetailCells(c.data.detail) : [];
      }, function () { c.saving = false; });
  };

  c.closeDetail = function () {
    c.data.detail = null;
    c.detailCells = [];
    c.cancelCorrect();
  };

  // ───── Per-day correction ─────────────────────────────────────────────────

  /**
   * Open the correction dialog for one day.
   *
   * The options offered are `detail.allowedShifts[date]` — what THIS employee
   * could legally have logged on THIS date, computed server-side from their own
   * entitlement windows. The day's current shift is added even when it is no
   * longer in that list (a CO whose entitlement is now consumed is the usual
   * case) so the dialog can show what is there without offering to re-pick it.
   */
  c.openCorrect = function (cell) {
    if (!cell || !cell.inMonth || !c.data.detail || !c.data.detail.canEditDays) return;
    if (c.saving) return;

    var currentId = cell.shift ? cell.shift.shiftId : '';
    var allowed   = (c.data.detail.allowedShifts || {})[cell.key] || [];
    var byId      = catalogueById();

    var opts = [];
    for (var i = 0; i < allowed.length; i++) {
      if (byId[allowed[i]]) opts.push(byId[allowed[i]]);
    }
    if (currentId && byId[currentId]) {
      var present = false;
      for (var j = 0; j < opts.length; j++) {
        if (opts[j].sys_id === currentId) { present = true; break; }
      }
      if (!present) opts.unshift(byId[currentId]);
    }

    c.correcting = {
      key:       cell.key,
      day:       cell.day,
      weekend:   cell.weekend,
      currentId: currentId,
      current:   cell.shift,
      options:   opts,
      choice:    currentId,
      reason:    '',
      error:     ''
    };
  };

  c.cancelCorrect = function () {
    c.correcting = null;
  };

  /** Nothing to send while the pick still matches what is already there. */
  c.correctChanged = function () {
    return !!c.correcting && c.correcting.choice !== c.correcting.currentId;
  };

  c.confirmCorrect = function () {
    if (!c.correcting || c.saving) return;
    var reason = (c.correcting.reason || '').replace(/^\s+|\s+$/g, '');
    if (!reason) {
      // Belt and braces — the button is disabled and the server refuses too.
      c.correcting.error = 'A reason is required to correct a day.';
      return;
    }
    if (!c.correctChanged()) {
      c.correcting.error = 'Pick a different shift, or clear the day.';
      return;
    }
    send({
      action: 'correctDay',
      userId: c.data.detail.userId,
      year:   c.data.year,
      month:  c.data.month,
      date:   c.correcting.key,
      shift:  c.correcting.choice,
      reason: reason
    }, function () {
      // The server returns a re-read detail either way. Keep the panel open —
      // a correction is usually one of several — and rebuild the grid from it.
      c.detailCells = c.data.detail ? buildDetailCells(c.data.detail) : [];
      if (c.data.actionError) {
        if (c.correcting) c.correcting.error = c.data.actionError;
      } else {
        c.cancelCorrect();
      }
    });
  };

  c.approve = function (row) {
    if (!row || !row.canAction || c.saving) return;
    // Approving from inside the detail view returns to the queue: the row is
    // no longer actionable, so leaving the panel open invites a second click.
    send({ action: 'approve', userId: row.userId, year: c.data.year, month: c.data.month },
         function () { c.closeDetail(); });
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
         function () { c.cancelReject(); c.closeDetail(); });
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

  /** sys_id → catalogue row, rebuilt from whatever data the server last sent. */
  function catalogueById() {
    var map = {}, cat = (c.data && c.data.shiftCatalogue) || [];
    for (var i = 0; i < cat.length; i++) map[cat[i].sys_id] = cat[i];
    return map;
  }

  /**
   * Fetch the decision log.
   *
   * Kept out of `send` because the response carries data.history and we do NOT
   * want the generic post-write reseed to blow it away — every other action
   * returns history: null.
   */
  function loadHistory() {
    c.saving = true;
    c.server.get({ action: 'loadHistory', year: c.data.year, month: c.data.month })
      .then(function (r) {
        c.data   = r.data;
        c.saving = false;
        c.recalc();
      }, function () { c.saving = false; });
  }

  function loadMonth(y, m) {
    c.saving = true;
    c.cancelReject();
    c.cancelCorrect();
    c.clearSelection();
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
   * Lay the month out Monday-first, padded to whole weeks.
   *
   * Mirrors the employee calendar's grid so a manager reading this recognises
   * what the employee filled in — same week start, same leading/trailing blanks.
   */
  function buildDetailCells(detail) {
    var y = detail.year, m = detail.month;
    var firstDow = (new Date(y, m, 1).getDay() + 6) % 7;   // Mon = 0
    var dim      = new Date(y, m + 1, 0).getDate();
    var cells = [];

    for (var lead = 0; lead < firstDow; lead++) {
      cells.push({ inMonth: false, key: 'lead-' + lead });
    }
    for (var d = 1; d <= dim; d++) {
      var key = y + '-' + pad2(m + 1) + '-' + pad2(d);
      var dow = new Date(y, m, d).getDay();
      var entry = detail.days[key] || null;
      cells.push({
        inMonth: true,
        key:     key,
        day:     d,
        weekend: dow === 0 || dow === 6,
        shift:   entry,
        comment: entry ? entry.comment : ''
      });
    }
    while (cells.length % 7 !== 0) {
      cells.push({ inMonth: false, key: 'trail-' + cells.length });
    }
    return cells;
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

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
