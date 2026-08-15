api.controller = function ($scope, $element, $timeout) {
  /**
   * ShiftPay Reporting — Client Script
   * ==================================
   * Same three-layer contract as the other widgets: the server populates `data`,
   * the controller reads it off `c.data`, the template renders `c`. The only
   * difference is that nothing here writes — every c.server.get() is a re-read
   * with a different scope, month or span.
   *
   * CHART LIFECYCLE. Chart.js owns a <canvas>; AngularJS owns the DOM around it.
   * The two are reconciled by rebuilding, not by patching: a tab switch destroys
   * the chart it is leaving and constructs the one it is entering, on a $timeout
   * so the canvas ng-if has actually rendered first. Charts left alive behind a
   * removed canvas leak their resize listeners and eventually redraw into
   * nothing, which is the bug this avoids.
   *
   * NO DIRECTIVES. A Service Portal widget client script is a controller factory
   * — there is no module to register a directive on — so the canvases are found
   * by class inside $element rather than by id. That is also what makes two
   * instances of this widget on one page safe: ids would collide, $element does
   * not.
   *
   * LOADING CHART.JS. The proper route is an sp_js_include on an sp_dependency
   * attached to this widget; otherwise the widget injects the configured URL
   * itself, so the page works without that plumbing. Either way the resolved
   * constructor is kept on window.__shiftPayChart and never read back off
   * window.Chart — see chartLib() for why the platform's own bundled Chart.js
   * makes that distinction load-bearing. Both paths converge on the same guard:
   * no library, no charts, and a plain-English banner instead of four empty
   * boxes with the numbers still readable underneath.
   *
   * COLOUR. Inherited rule from the calendar and approval widgets — hue means
   * shift type and nothing else. The mix donut uses catalogue color_hex; the
   * trend and team charts are ink and slate; red appears only on expired CO,
   * which is a genuine failure state.
   */
  var c = this;

  // ───── Bootstrap ──────────────────────────────────────────────────────────
  // data.scope        'me' | 'team' | 'org'   — resolved SERVER-side
  // data.scopes       [{key, label, hint}]    — what this user may ask for
  // data.trend        [{key, label, year, month, shifts, onCall, amount, people}]
  // data.mix          [{shiftId, name, description, color_hex, day_category, count, amount}]
  // data.team         [{userId, name, initials, employeeId, shifts, onCall, weekday, amount}]
  // data.co           {earned, consumed, open, expired, soon[]} | null
  // data.approval     {submitted, approved, rejected, latestPending}
  // data.totals       {shifts, onCall, amount, people, currency}
  // data.showPay      boolean — false means amounts were never sent
  // data.showTeam     boolean — false in the 'me' scope
  // data.hasData      boolean
  c.tab      = 'trend';
  c.loading  = false;
  c.libError = '';

  c.tabs = [
    { key: 'trend', label: 'Cost & volume', icon: 'fa-line-chart' },
    { key: 'mix',   label: 'Shift mix',     icon: 'fa-pie-chart'  },
    { key: 'team',  label: 'Team',          icon: 'fa-users'      },
    { key: 'co',    label: 'CO health',     icon: 'fa-exchange'   }
  ];

  var CURRENCY = { INR: '₹', USD: '$', GBP: '£', EUR: '€' };

  // Ink and its tints. Deliberately hueless — see the colour note above.
  var INK        = '#0F172A';
  var INK_SOFT   = '#94A3B8';
  var INK_FAINT  = '#CBD5E1';
  var GRID       = '#F1F5F9';
  var AXIS_TEXT  = '#64748B';
  var RED        = '#B91C1C';

  var charts = {};   // tab key -> live Chart instance

  // NOTE: the initial draw runs at the BOTTOM of this controller. These are
  // function expressions on `c`, not declarations, so they do not hoist.


  // ───── Public API ─────────────────────────────────────────────────────────

  /**
   * Which tabs this scope offers, recomputed only when `data` changes.
   *
   * Stored on `c` rather than exposed as a function the template calls: ng-repeat
   * over a function that builds a fresh array every digest never stabilises and
   * Angular throws an infinite-digest error.
   */
  function computeTabs() {
    var out = [];
    for (var i = 0; i < c.tabs.length; i++) {
      var k = c.tabs[i].key;
      if (k === 'team' && !c.data.showTeam) continue;   // 'me' scope: nobody to compare with
      if (k === 'co'   && !c.data.coEnabled) continue;  // CO turned off app-wide
      out.push(c.tabs[i]);
    }
    return out;
  }

  c.setTab = function (key) {
    if (c.tab === key) return;
    c.tab = key;
    draw();
  };

  c.setScope = function (key) {
    if (key === c.data.scope) return;
    reload({ scope: key });
  };

  c.setSpan = function (months) {
    if (months === c.data.trendMonths) return;
    reload({ months: months });
  };

  c.prevMonth = function () { stepMonth(-1); };
  c.nextMonth = function () { stepMonth(1); };

  /** Is the anchor month in the future? Nothing has been logged there yet. */
  c.isFuture = function () {
    var now = new Date();
    return c.data.year > now.getFullYear() ||
           (c.data.year === now.getFullYear() && c.data.month > now.getMonth());
  };

  c.money = function (amount, currency) {
    if (amount === null || amount === undefined) return '';
    var sym = CURRENCY[currency || (c.data.totals && c.data.totals.currency) || 'INR'] || '';
    return sym + groupDigits(Math.round(Number(amount) || 0));
  };

  /** Share of the window's shifts, as a rounded percentage. */
  c.share = function (count) {
    var total = (c.data.totals && c.data.totals.shifts) || 0;
    if (!total) return 0;
    return Math.round((count / total) * 100);
  };

  /**
   * A person's on-call share, as a rounded percentage.
   *
   * Computed here rather than as an Angular filter inside a ternary in the
   * template — that parses, but only just, and it is the kind of expression that
   * breaks silently on an Angular upgrade.
   */
  c.onCallShare = function (row) {
    if (!row || !row.shifts) return 0;
    return Math.round((row.onCall / row.shifts) * 100);
  };

  c.coPercent = function (part) {
    var earned = (c.data.co && c.data.co.earned) || 0;
    if (!earned) return 0;
    return Math.round((part / earned) * 100);
  };

  /**
   * How a "closing soon" entitlement should read. Zero days left is today, not
   * "expired" — the window is inclusive of its end date.
   */
  c.daysLeftLabel = function (n) {
    if (n === null || n === undefined) return 'no deadline set';
    if (n < 0)  return 'overdue';
    if (n === 0) return 'last day';
    return n === 1 ? '1 day left' : n + ' days left';
  };

  c.retryLib = function () {
    c.libError = '';
    draw();
  };


  // ───── Server round trips ─────────────────────────────────────────────────

  function stepMonth(delta) {
    var m = c.data.month + delta;
    var y = c.data.year;
    if (m < 0)  { m = 11; y--; }
    if (m > 11) { m = 0;  y++; }
    reload({ year: y, month: m });
  }

  /**
   * Re-read with a changed parameter. The server re-resolves everything from the
   * payload, so each call sends the full state rather than a delta — a stale
   * field left off would silently reset to the default.
   */
  function reload(changes) {
    if (c.loading) return;
    c.loading = true;

    var payload = {
      scope:  c.data.scope,
      year:   c.data.year,
      month:  c.data.month,
      months: c.data.trendMonths
    };
    for (var k in changes) payload[k] = changes[k];

    c.server.get(payload).then(function (r) {
      c.data = r.data;
      c.loading = false;
      // The scope may come back as something other than what was asked for —
      // the server decides entitlement, not this script. If the tab we are on
      // no longer exists in the new scope, fall back to the first one that does.
      c.visibleTabs = computeTabs();
      if (!tabExists(c.tab)) c.tab = c.visibleTabs[0].key;
      draw();
    }, function () {
      c.loading = false;
    });
  }

  function tabExists(key) {
    for (var i = 0; i < c.visibleTabs.length; i++) {
      if (c.visibleTabs[i].key === key) return true;
    }
    return false;
  }


  // ───── Chart.js loading ───────────────────────────────────────────────────

  /**
   * The Chart constructor this widget draws with, or null.
   *
   * Deliberately NOT window.Chart. ServiceNow ships its own Chart.js at
   * /scripts/thirdparty/angular-chart/chart.js — a v1/v2 build paired with
   * angular-chart.js — and any widget on the page that pulls the platform's
   * `chart.js` sp_dependency defines window.Chart as that old version. Its
   * options API is incompatible with v4 (v2 wants scales.xAxes as an array),
   * and the failure is silent: charts simply come out wrong. So this widget
   * keeps its own reference and never trusts the global.
   */
  function chartLib() { return window.__shiftPayChart || null; }

  /** Chart.js 3 and 4 share the options API this widget is written against. */
  function isModern(lib) {
    return !!(lib && lib.version && parseInt(lib.version, 10) >= 3);
  }

  /** Ensure a modern Chart constructor is resolved, then call back. */
  function withChartLib(cb) {
    if (chartLib()) { cb(); return; }

    // Someone already put a modern Chart.js on the page — a properly wired
    // sp_js_include, most likely. Adopt it rather than loading a second copy.
    if (isModern(window.Chart)) {
      window.__shiftPayChart = window.Chart;
      cb();
      return;
    }

    var url = c.data.chartLibUrl;
    if (!url) {
      c.libError = 'No charting library is configured for this widget.';
      return;
    }

    // Native Promise, not $q: the deferred has to survive across widget
    // instances on `window`, and no shim is warranted — Chart.js v4 is ES2015+
    // itself, so any browser without Promise cannot run the library anyway.
    if (!window.__shiftPayChartLoad) {
      window.__shiftPayChartLoad = new Promise(function (resolve, reject) {
        // Whatever owned the global before us — the platform's v1/v2, usually.
        var prior = window.Chart;

        var s = document.createElement('script');
        s.src   = url;
        s.async = true;
        s.onload  = function () {
          // A 200 that is not the library — a captive portal, a CDN error page —
          // loads happily and defines nothing. Check for the constructor and its
          // version, not for the load event.
          if (!isModern(window.Chart)) { reject(); return; }
          window.__shiftPayChart = window.Chart;

          // Hand the global back. angular-chart.js binds to window.Chart at
          // module load and would break against v4's API, so leaving v4 sitting
          // on the global would fix our charts by breaking someone else's.
          if (prior) {
            window.Chart = prior;
          } else {
            try { delete window.Chart; } catch (e) { window.Chart = undefined; }
          }
          resolve();
        };
        s.onerror = function () { reject(); };
        document.head.appendChild(s);
      });
    }

    window.__shiftPayChartLoad.then(function () {
      // Resolved outside Angular's digest — $applyAsync is what gets the drawn
      // charts and the cleared banner onto the screen.
      $scope.$applyAsync(function () { c.libError = ''; cb(); });
    }, function () {
      // Let a later retry try again rather than caching the failure forever.
      window.__shiftPayChartLoad = null;
      $scope.$applyAsync(function () {
        c.libError = 'The charting library could not be loaded from ' + url +
                     '. The figures below are still accurate — only the charts are missing.';
      });
    });
  }


  // ───── Drawing ────────────────────────────────────────────────────────────

  /**
   * Draw the active tab's chart.
   *
   * $timeout with no delay lets Angular finish rendering the tab's ng-if before
   * we go looking for its canvas. Without it the canvas for a tab just switched
   * to does not exist yet and the chart silently never appears.
   */
  function draw() {
    destroyAll();
    if (!c.data.hasData) return;
    $timeout(function () {
      withChartLib(function () {
        if (c.tab === 'trend') buildTrend();
        else if (c.tab === 'mix')  buildMix();
        else if (c.tab === 'team') buildTeam();
        else if (c.tab === 'co')   buildCo();
      });
    });
  }

  function canvasFor(key) {
    return $element[0].querySelector('.shift-rep__canvas--' + key);
  }

  function mount(key, config) {
    var el  = canvasFor(key);
    var Lib = chartLib();
    if (!el || !Lib) return;
    destroy(key);
    charts[key] = new Lib(el.getContext('2d'), config);
  }

  function destroy(key) {
    if (charts[key]) { charts[key].destroy(); delete charts[key]; }
  }

  function destroyAll() {
    for (var k in charts) destroy(k);
  }

  // A canvas removed from the DOM with a live Chart on it keeps its window
  // resize listener forever. Service Portal reuses the page, so this matters.
  $scope.$on('$destroy', destroyAll);


  // ───── Chart configurations ───────────────────────────────────────────────

  /**
   * Cost and volume over the window.
   *
   * Cost is bars on the left axis, shift count is a line on the right — the two
   * are different units and sharing one axis would make a rate change look like
   * a volume change. When pay is hidden the bars become the shift count and the
   * second axis disappears entirely, rather than leaving an empty money axis.
   */
  function buildTrend() {
    var labels = [], amounts = [], shifts = [], onCall = [];
    for (var i = 0; i < c.data.trend.length; i++) {
      var t = c.data.trend[i];
      labels.push(t.label);
      amounts.push(t.amount);
      shifts.push(t.shifts);
      onCall.push(t.onCall);
    }

    var datasets = [];
    var scales = {
      x: { grid: { display: false }, ticks: { color: AXIS_TEXT, font: { size: 11 } } }
    };

    if (c.data.showPay) {
      datasets.push({
        type: 'bar', label: 'Cost', data: amounts,
        backgroundColor: INK, borderRadius: 3, maxBarThickness: 34,
        yAxisID: 'y', order: 2
      });
      datasets.push({
        type: 'line', label: 'Shifts', data: shifts,
        borderColor: INK_SOFT, backgroundColor: INK_SOFT, borderWidth: 2,
        pointRadius: 3, pointBackgroundColor: '#FFFFFF', tension: 0.3,
        yAxisID: 'y1', order: 1
      });
      scales.y = axis('left',  true);
      scales.y1 = axis('right', false);
      scales.y1.grid = { display: false };
    } else {
      datasets.push({
        type: 'bar', label: 'Shifts', data: shifts,
        backgroundColor: INK, borderRadius: 3, maxBarThickness: 34, order: 2
      });
      datasets.push({
        type: 'line', label: 'On-call', data: onCall,
        borderColor: INK_SOFT, backgroundColor: INK_SOFT, borderWidth: 2,
        pointRadius: 3, pointBackgroundColor: '#FFFFFF', tension: 0.3, order: 1
      });
      scales.y = axis('left', false);
    }

    mount('trend', {
      data: { labels: labels, datasets: datasets },
      options: baseOptions({
        scales: scales,
        plugins: {
          legend: legend(),
          tooltip: tooltip(function (ctx) {
            var isMoney = c.data.showPay && ctx.dataset.label === 'Cost';
            return ctx.dataset.label + ': ' +
                   (isMoney ? c.money(ctx.parsed.y) : ctx.parsed.y);
          })
        }
      })
    });
  }

  /**
   * The shift-type mix over the window, as a doughnut.
   *
   * The only chart that uses hue, and it uses the catalogue's own color_hex — so
   * a slice here is the same colour as that shift's chip on the calendar. A
   * catalogue row with no colour set falls back to a neutral rather than to a
   * palette colour that would imply a meaning it does not have.
   */
  function buildMix() {
    var labels = [], values = [], colors = [];
    for (var i = 0; i < c.data.mix.length; i++) {
      var m = c.data.mix[i];
      labels.push(m.name);
      values.push(m.count);
      colors.push(m.color_hex || INK_FAINT);
    }

    mount('mix', {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderColor: '#FFFFFF',
          borderWidth: 2,
          hoverOffset: 6
        }]
      },
      options: baseOptions({
        cutout: '62%',
        // A doughnut has no shared index across datasets, so the strip-wide
        // 'index' interaction the bar charts use highlights the wrong arc here.
        interaction: { mode: 'nearest', intersect: true },
        plugins: {
          legend: legend('right'),
          tooltip: tooltip(function (ctx) {
            var row = c.data.mix[ctx.dataIndex] || {};
            var line = ctx.label + ': ' + ctx.parsed + ' shifts (' + c.share(ctx.parsed) + '%)';
            if (c.data.showPay && row.amount !== null) line += ' · ' + c.money(row.amount);
            return line;
          })
        }
      })
    });
  }

  /**
   * Per-person comparison: weekday work and on-call work stacked to the total.
   *
   * Stacked rather than grouped because on-call is a *part* of someone's month,
   * not a parallel measure — the bar's full length is their total, and the pale
   * segment is how much of it fell on a weekend or holiday. Horizontal, because
   * these are names and names do not fit under a vertical axis.
   */
  function buildTeam() {
    var labels = [], weekday = [], onCall = [];
    for (var i = 0; i < c.data.team.length; i++) {
      labels.push(c.data.team[i].name);
      weekday.push(c.data.team[i].weekday);
      onCall.push(c.data.team[i].onCall);
    }

    mount('team', {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { label: 'Weekday', data: weekday, backgroundColor: INK,
            borderRadius: 2, maxBarThickness: 22 },
          { label: 'On-call', data: onCall, backgroundColor: INK_SOFT,
            borderRadius: 2, maxBarThickness: 22 }
        ]
      },
      options: baseOptions({
        indexAxis: 'y',
        scales: {
          x: { stacked: true, beginAtZero: true,
               grid: { color: GRID }, border: { display: false },
               ticks: { color: AXIS_TEXT, font: { size: 11 }, precision: 0 } },
          y: { stacked: true, grid: { display: false }, border: { display: false },
               ticks: { color: AXIS_TEXT, font: { size: 11 } } }
        },
        plugins: {
          legend: legend(),
          tooltip: tooltip(function (ctx) {
            var row = c.data.team[ctx.dataIndex] || {};
            var line = ctx.dataset.label + ': ' + ctx.parsed.x;
            if (ctx.datasetIndex === 1 && c.data.showPay && row.amount !== null) {
              line += ' · month total ' + c.money(row.amount);
            }
            return line;
          })
        }
      })
    });
  }

  /**
   * CO entitlement health.
   *
   * Red is used here and nowhere else in this widget: an expired unused
   * entitlement is a day someone earned and lost, which is exactly the failure
   * state red is reserved for across this app.
   */
  function buildCo() {
    var co = c.data.co || { consumed: 0, open: 0, expired: 0 };

    mount('co', {
      type: 'doughnut',
      data: {
        labels: ['Used', 'Open', 'Expired unused'],
        datasets: [{
          data: [co.consumed, co.open, co.expired],
          backgroundColor: [INK, INK_SOFT, RED],
          borderColor: '#FFFFFF',
          borderWidth: 2,
          hoverOffset: 6
        }]
      },
      options: baseOptions({
        cutout: '62%',
        interaction: { mode: 'nearest', intersect: true },
        plugins: {
          legend: legend('right'),
          tooltip: tooltip(function (ctx) {
            return ctx.label + ': ' + ctx.parsed + ' (' + c.coPercent(ctx.parsed) + '% of earned)';
          })
        }
      })
    });
  }


  // ───── Chart.js option helpers ────────────────────────────────────────────
  // Shared so all four charts read as one system rather than four defaults.

  function baseOptions(extra) {
    var o = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 220 },
      interaction: { intersect: false, mode: 'index' }
    };
    for (var k in extra) o[k] = extra[k];
    return o;
  }

  function axis(position, money) {
    return {
      position: position,
      beginAtZero: true,
      grid: { color: GRID },
      // Chart.js v4 moved the axis line out of grid.drawBorder into its own
      // `border` block. Setting the old key here would be silently ignored.
      border: { display: false },
      ticks: {
        color: AXIS_TEXT,
        font: { size: 11 },
        precision: money ? undefined : 0,
        callback: function (v) { return money ? c.money(v) : v; }
      }
    };
  }

  function legend(position) {
    return {
      position: position || 'bottom',
      labels: {
        color: AXIS_TEXT,
        boxWidth: 10,
        boxHeight: 10,
        usePointStyle: true,
        pointStyle: 'circle',
        font: { size: 11 }
      }
    };
  }

  function tooltip(labelFn) {
    return {
      backgroundColor: INK,
      padding: 10,
      cornerRadius: 6,
      displayColors: false,
      titleFont: { size: 12 },
      bodyFont: { size: 12 },
      callbacks: { label: labelFn }
    };
  }


  // ───── Internals ──────────────────────────────────────────────────────────

  /**
   * Indian digit grouping (1,84,500) — the last three digits, then pairs.
   * Same implementation as the approval widget: toLocaleString('en-IN') is not
   * dependable across the browsers Service Portal has to support.
   */
  function groupDigits(n) {
    var neg = n < 0;
    var s = Math.abs(n).toString();
    if (s.length <= 3) return (neg ? '-' : '') + s;
    var last3 = s.slice(-3);
    var rest  = s.slice(0, -3);
    var out = '';
    while (rest.length > 2) {
      out = ',' + rest.slice(-2) + out;
      rest = rest.slice(0, -2);
    }
    return (neg ? '-' : '') + rest + out + ',' + last3;
  }


  // ───── Initial draw ───────────────────────────────────────────────────────
  c.visibleTabs = computeTabs();
  if (c.visibleTabs.length && !tabExists(c.tab)) c.tab = c.visibleTabs[0].key;
  draw();
};
