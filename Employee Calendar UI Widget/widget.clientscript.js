api.controller = function ($scope, $element, $timeout) {
  /** @type {Object} the widget controller alias — matches `c` in template */
  var c = this;

  // ───── Shift type catalogue ───────────────────────────────────────────────
  // All shift semantics are data-driven: colour comes from the catalogue's
  // color_hex field and the UI group from its day_category field. The pale
  // "soft" tint is derived from the main colour (no separate stored value).
  var NEUTRAL_COLOR = '#64748B';

  // Labels keyed by the stable category codes (not by display name).
  var GROUP_LABELS = {
    'regular': 'Regular shifts',
    'off':     'Off / Not eligible',
    'holiday': 'Holiday work (weekend or declared holiday)'
  };
  // Fixed display order of the category groups.
  var GROUP_ORDER = ['regular', 'off', 'holiday'];

  // Lighten a #rrggbb hex toward white by `amount` (0–1) for cell backgrounds.
  function softTint(hex, amount) {
    var m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
    if (!m) return '#E5E7EB';
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = Math.round(r + (255 - r) * amount);
    g = Math.round(g + (255 - g) * amount);
    b = Math.round(b + (255 - b) * amount);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function buildShiftTypes(catalogue) {
    if (!catalogue || !catalogue.length) return;
    c.shiftTypes    = {};
    c.shiftTypeList = [];
    catalogue.forEach(function (row) {
      var color = row.color_hex || NEUTRAL_COLOR;
      var entry = {
        key:       row.sys_id,
        name:      row.name,
        label:     row.description || row.name,
        short:     row.name,
        rate:      Number(row.rate) || 0,
        currency:  row.currency || 'INR',
        color:     color,
        colorSoft: softTint(color, 0.88),
        group:     row.day_category || 'other'
      };
      c.shiftTypes[row.sys_id] = entry;
      c.shiftTypeList.push(entry);
    });
    buildLegendGroups();
  }

  function buildLegendGroups() {
    var groups = [];
    GROUP_ORDER.forEach(function (cat) {
      var items = c.shiftTypeList.filter(function (t) { return t.group === cat; });
      if (items.length) groups.push({ title: GROUP_LABELS[cat], items: items });
    });
    c.legendGroups = groups;
  }

  function buildGroupedDropdownList(dateKey) {
    var groups = [];
    GROUP_ORDER.forEach(function (cat) {
      var items = c.shiftTypeList.filter(function (t) {
        return t.group === cat && c.isAllowed(t.key, dateKey);
      });
      if (items.length) groups.push({ title: GROUP_LABELS[cat], items: items });
    });
    c.groupedDropdownList = groups;
  }

  c.shiftTypes          = {};
  c.shiftTypeList       = [];
  c.legendGroups        = [];
  buildShiftTypes(c.data.shiftCatalogue);

  // ───── Bootstrap from server ──────────────────────────────────────────────
  // c.data is populated by the server script:
  //   data.year             (number)
  //   data.month            (number, 0-indexed)
  //   data.todayKey         'YYYY-MM-DD'
  //   data.entries          { 'YYYY-MM-DD': sys_id }
  //   data.comments         { 'YYYY-MM-DD': string }
  //   data.locked           boolean — true when the month cannot be edited
  //   data.submittedOn      display date for lock note
  //   data.status           '' | 'submitted' | 'approved' | 'rejected'
  //   data.managerComment   manager's reason — always set when status is rejected
  //   data.approver         display name of the manager who actioned it
  //   data.actionedOn       display date of that decision
  //   data.shiftCatalogue   [{sys_id, name, description, rate, currency, color_hex,
  //                            oc_role, allow_weekday, allow_weekend_holiday, day_category}]
  //   data.allowedShifts    { 'YYYY-MM-DD': [sys_id, ...] }
  //   data.configError      string — non-empty when the catalogue is misconfigured
  //   data.lastMonthYear, data.lastMonthMonth, data.lastMonthEntries, data.lastMonthSubmitted
  c.entries       = c.data.entries  || {};
  c.comments      = c.data.comments || {};
  c.locked        = !!c.data.locked;
  c.submittedOn   = c.data.submittedOn || '';
  c.year          = c.data.year;
  c.month         = c.data.month;
  c.allowedShifts = c.data.allowedShifts || {};
  applyApprovalState(c.data);

  // ───── UI state ───────────────────────────────────────────────────────────
  c.bulkMode            = false;
  c.selected            = {};      // map<dateKey, true>
  c.openCellKey         = null;
  c.openDate            = null;
  c.draftShift          = null;
  c.draftComment        = '';
  c.popoverStyle        = {};
  c.saving              = false;
  c.saveError           = '';
  c.bulkError           = '';
  c.legendOpen          = false;
  c.dropdownOpen        = false;
  c.groupedDropdownList = [];

  // ───── Public API for the template ────────────────────────────────────────

  /** Returns true when sysId is selectable on the given dateKey. */
  c.isAllowed = function (sysId, dateKey) {
    var allowed = c.allowedShifts[dateKey];
    if (!allowed) return true;   // no server restriction data → show all
    return allowed.indexOf(sysId) !== -1;
  };

  c.toggleLegend = function () { c.legendOpen = !c.legendOpen; };

  c.selectDropdownShift = function (sysId) {
    c.draftShift   = sysId;
    c.dropdownOpen = false;
  };

  c.toggleBulk = function () {
    c.bulkMode = !c.bulkMode;
    c.selected = {};
    c.openCellKey = null;
    c.recalc();
  };

  c.exitBulk = function () {
    c.bulkMode = false;
    c.selected = {};
    c.recalc();
  };

  c.changeMonth = function (delta) {
    var y = c.year, m = c.month + delta;
    if (m < 0)  { m = 11; y--; }
    if (m > 11) { m = 0;  y++; }
    c.openCellKey = null;
    c.selected = {};
    c.bulkMode = false;
    c.saving = true;
    c.server.get({ action: 'loadMonth', year: y, month: m }).then(function (r) {
      c.saving       = false;
      c.data         = r.data;
      c.year         = r.data.year;
      c.month        = r.data.month;
      c.entries      = r.data.entries  || {};
      c.comments     = r.data.comments || {};
      c.locked       = !!r.data.locked;
      c.submittedOn  = r.data.submittedOn || '';
      applyApprovalState(r.data);
      buildShiftTypes(r.data.shiftCatalogue);
      c.allowedShifts = r.data.allowedShifts || {};
      c.refresh();
    });
  };

  c.onCellClick = function (cell, $event) {
    if (!cell.inMonth || c.locked) return;
    if (c.bulkMode) {
      // weekends excluded from bulk selection
      if (cell.weekend) return;
      c.selected[cell.key] = !c.selected[cell.key];
      if (!c.selected[cell.key]) delete c.selected[cell.key];
      c.recalc();
      return;
    }
    // single-day → open popover anchored to the clicked cell
    c.openCellKey  = cell.key;
    c.openDate     = cell.date;
    c.draftShift   = c.entries[cell.key] || null;
    c.draftComment = c.comments[cell.key] || '';
    c.saveError    = '';
    c.dropdownOpen = false;
    buildGroupedDropdownList(cell.key);
    // wait for popover to be inserted, then measure
    $timeout(function () { positionPopover($event.currentTarget); });
  };

  c.closePopover = function () {
    c.openCellKey  = null;
    c.draftShift   = null;
    c.draftComment = '';
    c.saveError    = '';
    c.dropdownOpen = false;
  };

  c.saveCell = function () {
    if (!c.draftShift || !c.openCellKey) return;
    c.saving = true;
    c.server.get({
      action:  'saveDay',
      date:    c.openCellKey,
      shift:   c.draftShift,
      comment: c.draftComment || ''
    }).then(function (r) {
      if (r.data.error) {
        c.saving   = false;
        c.saveError = r.data.error;
        return;
      }
      c.allowedShifts           = r.data.allowedShifts || c.allowedShifts;
      c.entries[c.openCellKey]  = c.draftShift;
      c.comments[c.openCellKey] = c.draftComment || '';
      c.saveError = '';
      c.closePopover();
      c.refresh();
      c.saving = false;
    });
  };

  c.clearCell = function () {
    if (!c.openCellKey) return;
    c.saving = true;
    c.server.get({ action: 'clearDay', date: c.openCellKey }).then(function (r) {
      if (r.data.error) {
        c.saving    = false;
        c.saveError = r.data.error;
        return;
      }
      c.allowedShifts = r.data.allowedShifts || c.allowedShifts;
      delete c.entries[c.openCellKey];
      delete c.comments[c.openCellKey];
      c.saveError = '';
      c.closePopover();
      c.refresh();
      c.saving = false;
    });
  };

  c.selectAllWeekdays = function () {
    c.workingDayKeys.forEach(function (k) {
      var cell = c.cellByKey[k];
      if (cell) c.selected[k] = true;
    });
    c.recalc();
  };

  c.bulkApply = function (shiftKey) {
    var dates = [];
    for (var k in c.selected) if (c.selected[k]) dates.push(k);
    if (!dates.length) return;
    c.saving = true;
    c.server.get({ action: 'bulkSave', dates: dates, shift: shiftKey }).then(function (r) {
      if (r.data.error) {
        c.saving    = false;
        c.bulkError = r.data.error;
        return;
      }
      c.allowedShifts = r.data.allowedShifts || c.allowedShifts;
      dates.forEach(function (k) { c.entries[k] = shiftKey; });
      c.selected  = {};
      c.bulkMode  = false;
      c.bulkError = '';
      c.refresh();
      c.saving = false;
    });
  };

  c.submitMonth = function () {
    if (!c.canSubmit) return;
    c.saving = true;
    c.server.get({ action: 'submitMonth', year: c.year, month: c.month }).then(function (r) {
      // Trust the server's own view of the lock rather than assuming success —
      // a rejected submission (e.g. a weekday went missing between render and
      // click) must not leave the calendar locked on screen.
      c.locked      = !!r.data.locked;
      c.submittedOn = r.data.submittedOn || '';
      applyApprovalState(r.data);
      c.recalc();
      c.saving      = false;
    });
  };

  c.onKeydown = function ($event) {
    if ($event.key === 'Escape') {
      if (c.dropdownOpen)      { c.dropdownOpen = false; }
      else if (c.legendOpen)   { c.legendOpen = false; }
      else if (c.bulkMode)     { c.exitBulk(); }
      else if (c.openCellKey)  { c.closePopover(); }
    }
  };

  // ───── Build / refresh derived view state ─────────────────────────────────

  c.refresh = function () {
    buildCells();
    buildLastMonth();
    c.monthLabel     = monthLabel(c.year, c.month);
    c.lastMonthLabel = monthLabel(c.data.lastMonthYear, c.data.lastMonthMonth);
    c.recalc();
  };

  c.recalc = function () {
    // 1. logged + total working days for the footer
    c.workingDayCount = c.workingDayKeys.length;
    c.loggedCount = c.workingDayKeys.reduce(function (n, k) {
      return n + (c.entries[k] ? 1 : 0);
    }, 0);
    c.allLogged = c.loggedCount === c.workingDayCount && c.workingDayCount > 0;

    // 2. selection count
    c.selectionCount = 0;
    for (var k in c.selected) if (c.selected[k]) c.selectionCount++;

    // 3. summary counts — current month (in-month weekdays only)
    c.currentMonthCounts = {};
    c.shiftTypeList.forEach(function (t) { c.currentMonthCounts[t.key] = 0; });
    c.workingDayKeys.forEach(function (key) {
      var cv = c.entries[key];
      if (cv && c.currentMonthCounts[cv] !== undefined) c.currentMonthCounts[cv]++;
    });

    // 4. summary counts for last month
    c.lastMonthCounts = {};
    c.shiftTypeList.forEach(function (t) { c.lastMonthCounts[t.key] = 0; });
    for (var lk in c.data.lastMonthEntries) {
      var v = c.data.lastMonthEntries[lk];
      if (v && c.lastMonthCounts[v] !== undefined) c.lastMonthCounts[v]++;
    }

    // 5. bulk allowed list — intersection of allowed shifts across all selected days
    var selectedDates = [];
    for (var sk in c.selected) if (c.selected[sk]) selectedDates.push(sk);
    if (selectedDates.length === 0) {
      c.bulkAllowedList = c.shiftTypeList;
    } else {
      c.bulkAllowedList = c.shiftTypeList.filter(function (t) {
        return selectedDates.every(function (d) { return c.isAllowed(t.key, d); });
      });
    }

    // 6. submission window — viewed month locks from its last weekday
    //    through the 2nd weekday of the following month (inclusive).
    var openKey  = lastWorkingDayKey(c.year, c.month);
    var nextY = c.year, nextM = c.month + 1;
    if (nextM > 11) { nextM = 0; nextY++; }
    var closeKey = nthWorkingDayKey(nextY, nextM, 2);
    var today    = c.data.todayKey;
    var inWindow = today >= openKey && today <= closeKey;
    c.canSubmit  = c.allLogged && inWindow && !c.locked;
    c.submitHint = '';
    if (c.allLogged && !c.locked && !inWindow) {
      c.submitHint = today < openKey
        ? 'Submit opens ' + shortDate(openKey)
        : 'Submission window closed ' + shortDate(closeKey);
    }
    // A rejected month is editable again, so the button reads "Resubmit".
    c.submitLabel = c.locked
      ? 'Submitted'
      : (c.wasRejected ? 'Resubmit month' : 'Submit month');

    // 7. re-stamp current shift + comment on cells (entries/comments may have changed)
    c.cells.forEach(function (cell) {
      if (cell.inMonth) {
        cell.shift      = c.entries[cell.key]  || null;
        cell.comment    = c.comments[cell.key] || null;
        cell.hasComment = !!cell.comment;
      }
    });
  };

  // ───── Internals ──────────────────────────────────────────────────────────

  /**
   * Copy the month's approval state onto the controller.
   *
   * Called on bootstrap and after every action that can change it, so the
   * banner and the submit-button label never lag behind the server. Only one
   * of wasApproved / wasRejected is ever true; both are false for a month that
   * has not been actioned.
   */
  function applyApprovalState(d) {
    c.status         = d.status || '';
    c.managerComment = d.managerComment || '';
    c.approver       = d.approver || '';
    c.actionedOn     = d.actionedOn || '';
    c.wasApproved    = c.status === 'approved';
    c.wasRejected    = c.status === 'rejected';
  }

  function buildCells() {
    var first = new Date(c.year, c.month, 1);
    var firstDow = (first.getDay() + 6) % 7;             // Mon = 0
    var daysInMonth = new Date(c.year, c.month + 1, 0).getDate();
    var cells = [];
    var idx = 0;
    var i, d;

    // leading days from previous month
    for (i = 0; i < firstDow; i++) {
      d = new Date(c.year, c.month, 1 - (firstDow - i));
      cells.push(makeCell(d, false, idx++));
    }
    // days in month
    for (i = 1; i <= daysInMonth; i++) {
      d = new Date(c.year, c.month, i);
      cells.push(makeCell(d, true, idx++));
    }
    // trailing days from next month so rows are full
    while (cells.length % 7 !== 0) {
      var last = cells[cells.length - 1].date;
      d = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
      cells.push(makeCell(d, false, idx++));
    }
    c.cells = cells;

    // lookup helpers
    c.cellByKey = {};
    c.workingDayKeys = [];
    cells.forEach(function (cell) {
      c.cellByKey[cell.key] = cell;
      if (cell.inMonth && !cell.weekend) c.workingDayKeys.push(cell.key);
    });
  }

  function makeCell(date, inMonth, idx) {
    var key = dateKey(date);
    var dow = date.getDay();
    var weekend = dow === 0 || dow === 6;
    return {
      idx:        idx,
      date:       date,
      key:        key,
      day:        date.getDate(),
      inMonth:    inMonth,
      weekend:    weekend,
      isToday:    key === c.data.todayKey,
      future:     inMonth && key > c.data.todayKey,
      shift:      c.entries[key]  || null,
      comment:    c.comments[key] || null,
      hasComment: !!c.comments[key]
    };
  }

  function buildLastMonth() {
    var y = c.data.lastMonthYear, m = c.data.lastMonthMonth;
    var first = new Date(y, m, 1);
    var firstDow = (first.getDay() + 6) % 7;
    var dim = new Date(y, m + 1, 0).getDate();
    var arr = [];
    for (var i = 0; i < firstDow; i++) arr.push({ inMonth: false });
    for (var d = 1; d <= dim; d++) {
      var date = new Date(y, m, d);
      var k = dateKey(date);
      arr.push({ inMonth: true, day: d, shift: c.data.lastMonthEntries[k] || null });
    }
    while (arr.length % 7 !== 0) arr.push({ inMonth: false });
    c.lastMonthCells     = arr;
    c.lastMonthSubmitted = c.data.lastMonthSubmitted || '';
  }

  function dateKey(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function monthLabel(y, m) {
    var months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
    return months[m] + ' ' + y;
  }

  function lastWorkingDayKey(y, m) {
    var dim = new Date(y, m + 1, 0).getDate();
    for (var d = dim; d >= 1; d--) {
      var dow = new Date(y, m, d).getDay();
      if (dow !== 0 && dow !== 6) return dateKey(new Date(y, m, d));
    }
  }
  function nthWorkingDayKey(y, m, n) {
    var dim = new Date(y, m + 1, 0).getDate(), count = 0;
    for (var d = 1; d <= dim; d++) {
      var dow = new Date(y, m, d).getDay();
      if (dow !== 0 && dow !== 6 && ++count === n) return dateKey(new Date(y, m, d));
    }
  }
  function shortDate(key) {
    var p = key.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return d.getDate() + ' ' + months[d.getMonth()];
  }

  function positionPopover(cellEl) {
    if (!cellEl) return;
    // On mobile the popover is a fixed bottom sheet; CSS handles placement
    if (window.innerWidth <= 760) { c.popoverStyle = {}; return; }
    var grid = cellEl.parentNode;
    if (!grid) return;
    var gr = grid.getBoundingClientRect();
    var cr = cellEl.getBoundingClientRect();
    var POPOVER_W = 280, POPOVER_H_ESTIMATE = 300, GAP = 6;

    var left = cr.left - gr.left;
    var top  = cr.bottom - gr.top + GAP;

    // flip horizontally if would overflow the right edge of the grid
    if (left + POPOVER_W > gr.width) {
      left = cr.right - gr.left - POPOVER_W;
    }
    // flip vertically if would overflow the bottom of the grid
    if (top + POPOVER_H_ESTIMATE > gr.height + 20) {
      top = cr.top - gr.top - POPOVER_H_ESTIMATE - GAP;
      if (top < 0) top = 0;
    }
    c.popoverStyle = { left: left + 'px', top: top + 'px' };
  }

  // ───── Boot ───────────────────────────────────────────────────────────────
  c.refresh();

  // Focus the widget root so Esc keybinding works without an extra click
  $timeout(function () { $element[0].focus(); });
};
