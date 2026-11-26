var ShiftPayExportSplit = Class.create();

/**
 * ShiftPayExportSplit
 * ===================
 * The optional split of a payroll export run into one file per manager or per
 * cost centre (SP-131, BRD BR-X9 / DD-8).
 *
 * BR-X9: one export run produces ONE consolidated CSV covering every in-scope
 * employee. A split is an optional extra, switched on by configuration. This
 * class therefore never replaces the consolidated file; it produces it every
 * time and, when a split is configured, the split files alongside it. The
 * consolidated file stays the run's record and the reconciliation anchor.
 *
 * What it guarantees, and refuses to return without:
 *   1. The split files' totals equal the consolidated total, per currency,
 *      to the minor unit. Money is summed as integers (paise, pence), never as
 *      floats, so 0.1 + 0.2 cannot make a correct split look wrong.
 *   2. Every row lands in exactly one split file - same row count both ways.
 *   3. An employee is never divided between files. Their rows travel together,
 *      so the "Total monthly pay" each file shows for them is still their
 *      whole month.
 *   4. Nobody is dropped for missing data. An employee with no manager or no
 *      cost centre goes to an "Unassigned" file rather than out of the run.
 * If any of these fail, split() throws. A payroll file set that does not add
 * up must stop the run, not reach payroll.
 *
 * It does not query timesheets or price anything. It takes the rows the
 * export already built (one per employee x shift type, BRD section 9.4) and
 * partitions them. Pricing stays with the summary-table snapshot, rendering
 * the CSV (headers, delimiter, encoding) stays with the export writer (SP-130),
 * and attaching files stays with the run (SP-124 / SP-126). The one table it
 * reads is sys_user, and only for a cost-centre split whose rows do not
 * already carry the cost centre.
 *
 * Configuration - system property x_1995110_shift_0.export_split_by:
 *   'none'        (default) consolidated file only
 *   'manager'     plus one file per approving manager
 *   'cost_centre' plus one file per employee cost centre (sys_user.cost_center)
 * 'cost_center' is accepted as a spelling of 'cost_centre'. Anything else logs
 * a warning and falls back to 'none' - the consolidated file is always safe.
 *
 * Scoped-app constraints: ES5 only (Rhino) - no let/const, arrow functions or
 * template literals.
 *
 * Usage:
 *   var result = new ShiftPayExportSplit({
 *     baseName: 'shiftpay_payroll_2026-10'   // file names derive from this
 *   }).split(rows);
 *
 *   result.consolidated   -> { name, label, rows, rowCount, employees, totals }
 *   result.files          -> [ same shape, one per manager / cost centre ]
 *                            empty when no split is configured
 *   result.reconciliation -> { ok, totals, splitTotals, rowCount, ... }
 *   result.warnings       -> [ string ] data quirks the split had to resolve
 *
 * Row fields read: userId (or employeeId), employeeName, managerId,
 * managerName, currency, subtotal - and costCentreId / costCentreName when
 * splitting by cost centre (looked up from sys_user when absent). Every other
 * field is carried through untouched for the writer.
 */
ShiftPayExportSplit.SPLIT_PROPERTY = 'x_1995110_shift_0.export_split_by';
ShiftPayExportSplit.MODES = { none: true, manager: true, cost_centre: true };
ShiftPayExportSplit.UNASSIGNED_KEY = '__unassigned__';

ShiftPayExportSplit.prototype = {

  initialize: function (config) {
    config = config || {};
    this.splitBy   = this._normaliseMode(
      config.splitBy !== undefined && config.splitBy !== null
        ? config.splitBy
        : gs.getProperty(ShiftPayExportSplit.SPLIT_PROPERTY, 'none')
    );
    this.baseName  = config.baseName  || 'shiftpay_payroll';
    this.extension = config.extension || '.csv';
    // Minor units per major unit. 2 covers INR, GBP, USD, EUR; a customer
    // paying in a 3-decimal currency sets 3.
    this.decimals  = config.decimals === undefined ? 2 : config.decimals;
    this.userTable = config.userTable || 'sys_user';
    this._factor   = Math.pow(10, this.decimals);
  },

  /**
   * Partition the export rows. Always returns the consolidated file; adds the
   * split files when a split is configured. Throws if they do not reconcile.
   *
   * @param {Object[]} rows  one per employee x shift type, as the export built them
   */
  split: function (rows) {
    rows = rows || [];
    var warnings = [];
    var working = this.splitBy === 'cost_centre' ? this._withCostCentres(rows) : rows;

    var consolidated = this._file(
      this.baseName + this.extension, 'all', 'All employees', working
    );

    var files = [];
    if (this.splitBy !== 'none') {
      files = this._partition(working, warnings);
    }

    var reconciliation = this.reconcile(consolidated, files);
    if (!reconciliation.ok) {
      throw new Error('ShiftPayExportSplit: split files do not reconcile with the ' +
        'consolidated file - ' + reconciliation.problems.join('; '));
    }

    for (var w = 0; w < warnings.length; w++) gs.warn('ShiftPayExportSplit: ' + warnings[w]);

    return {
      splitBy:        this.splitBy,
      consolidated:   consolidated,
      files:          files,
      reconciliation: reconciliation,
      warnings:       warnings
    };
  },

  /**
   * Check a set of split files against the consolidated file. Public so the
   * export run can re-check after writing, and so the check itself is tested.
   * With no split files there is nothing to reconcile and the result is ok.
   */
  reconcile: function (consolidated, files) {
    var result = {
      ok:            true,
      problems:      [],
      totals:        consolidated.totals,
      splitTotals:   {},
      rowCount:      consolidated.rowCount,
      splitRowCount: 0,
      employees:     consolidated.employees,
      splitEmployees: 0,
      fileCount:     files.length
    };
    if (!files.length) {
      result.splitTotals    = consolidated.totals;
      result.splitRowCount  = consolidated.rowCount;
      result.splitEmployees = consolidated.employees;
      return result;
    }

    var minorSums = {};
    var seen = {};
    for (var f = 0; f < files.length; f++) {
      var file = files[f];
      result.splitRowCount += file.rows.length;
      for (var r = 0; r < file.rows.length; r++) {
        var row = file.rows[r];
        var cur = this._currency(row);
        minorSums[cur] = (minorSums[cur] || 0) + this._minor(row);
        var emp = this._employeeKey(row);
        if (seen[emp] === undefined) {
          seen[emp] = file.name;
          result.splitEmployees++;
        } else if (seen[emp] !== file.name) {
          result.problems.push('employee ' + emp + ' appears in both ' +
            seen[emp] + ' and ' + file.name);
        }
      }
    }
    result.splitTotals = this._formatTotals(minorSums);

    var consolidatedMinor = this._sumMinor(consolidated.rows);
    var currencies = this._union(consolidatedMinor, minorSums);
    for (var c = 0; c < currencies.length; c++) {
      var k = currencies[c];
      if ((consolidatedMinor[k] || 0) !== (minorSums[k] || 0)) {
        result.problems.push(k + ' total ' + this._format(minorSums[k] || 0) +
          ' across split files, ' + this._format(consolidatedMinor[k] || 0) +
          ' in the consolidated file');
      }
    }
    if (result.splitRowCount !== result.rowCount) {
      result.problems.push(result.splitRowCount + ' rows across split files, ' +
        result.rowCount + ' in the consolidated file');
    }
    if (result.splitEmployees !== result.employees) {
      result.problems.push(result.splitEmployees + ' employees across split files, ' +
        result.employees + ' in the consolidated file');
    }
    result.ok = result.problems.length === 0;
    return result;
  },

  // ------------------------------------------------------------ partition --

  _partition: function (rows, warnings) {
    // Decide each employee's group once, from all their rows, so an employee
    // can never be divided between two files.
    var groupOf = {};
    var candidates = {};
    var order = [];
    var i, emp;
    for (i = 0; i < rows.length; i++) {
      emp = this._employeeKey(rows[i]);
      var g = this._groupOf(rows[i]);
      if (!candidates[emp]) { candidates[emp] = {}; order.push(emp); }
      candidates[emp][g.key] = g;
    }
    for (i = 0; i < order.length; i++) {
      emp = order[i];
      var keys = Object.keys(candidates[emp]).sort();
      if (keys.length > 1) {
        // One timesheet has one approver, so this is a data quirk - but a
        // quirk must not split someone's pay. Lowest key wins, deterministically.
        warnings.push('employee ' + emp + ' has rows under ' + keys.length + ' ' +
          this._groupNoun() + 's (' + keys.join(', ') + '); all their rows go to ' + keys[0]);
      }
      groupOf[emp] = candidates[emp][keys[0]];
    }

    var groups = {};
    var groupKeys = [];
    for (i = 0; i < rows.length; i++) {
      var grp = groupOf[this._employeeKey(rows[i])];
      if (!groups[grp.key]) { groups[grp.key] = { group: grp, rows: [] }; groupKeys.push(grp.key); }
      groups[grp.key].rows.push(rows[i]);
    }

    // Stable order: by label, the Unassigned file last.
    var self = this;
    groupKeys.sort(function (a, b) {
      var ua = a === ShiftPayExportSplit.UNASSIGNED_KEY, ub = b === ShiftPayExportSplit.UNASSIGNED_KEY;
      if (ua !== ub) return ua ? 1 : -1;
      var la = groups[a].group.label.toLowerCase(), lb = groups[b].group.label.toLowerCase();
      if (la !== lb) return la < lb ? -1 : 1;
      return a < b ? -1 : (a > b ? 1 : 0);
    });

    var usedNames = {};
    var files = [];
    for (i = 0; i < groupKeys.length; i++) {
      var entry = groups[groupKeys[i]];
      var name = self._fileName(entry.group, usedNames);
      files.push(self._file(name, entry.group.key, entry.group.label, entry.rows));
    }
    return files;
  },

  _groupOf: function (row) {
    var id, label;
    if (this.splitBy === 'manager') {
      id = this._clean(row.managerId) || this._clean(row.managerName);
      label = this._clean(row.managerName) || id;
    } else {
      id = this._clean(row.costCentreId) || this._clean(row.costCentreName);
      label = this._clean(row.costCentreName) || id;
    }
    if (!id) {
      return { key: ShiftPayExportSplit.UNASSIGNED_KEY,
               label: 'Unassigned ' + this._groupNoun(), unassigned: true };
    }
    return { key: id, label: label, unassigned: false };
  },

  _groupNoun: function () {
    return this.splitBy === 'manager' ? 'manager' : 'cost centre';
  },

  /**
   * baseName__<slug>.csv. Two groups can share a label (two managers called
   * Priya Shah), so a clash takes a suffix from the group key rather than
   * silently writing both into one file name.
   */
  _fileName: function (group, used) {
    var slug = group.unassigned
      ? 'unassigned'
      : this._slug(group.label);
    var name = this.baseName + '__' + slug + this.extension;
    if (used[name]) {
      var suffix = this._slug(group.key).slice(-8) || 'x';
      name = this.baseName + '__' + slug + '-' + suffix + this.extension;
      var n = 2;
      while (used[name]) {
        name = this.baseName + '__' + slug + '-' + suffix + '-' + n + this.extension;
        n++;
      }
    }
    used[name] = true;
    return name;
  },

  _slug: function (text) {
    var s = String(text || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (s.length > 40) s = s.substring(0, 40).replace(/-+$/, '');
    return s || 'unnamed';
  },

  _file: function (name, key, label, rows) {
    var employees = {};
    var count = 0;
    for (var i = 0; i < rows.length; i++) {
      var emp = this._employeeKey(rows[i]);
      if (!employees[emp]) { employees[emp] = true; count++; }
    }
    return {
      name:      name,
      key:       key,
      label:     label,
      rows:      rows,
      rowCount:  rows.length,
      employees: count,
      totals:    this._formatTotals(this._sumMinor(rows))
    };
  },

  // ---------------------------------------------------------- cost centre --

  /**
   * Copies of the rows with costCentreId / costCentreName filled from
   * sys_user.cost_center, in one batched query. Rows that already carry a
   * costCentreId are left as they are; the caller's objects are not mutated.
   */
  _withCostCentres: function (rows) {
    var ids = [], idSet = {}, i, uid;
    for (i = 0; i < rows.length; i++) {
      if (rows[i].costCentreId !== undefined) continue;
      uid = this._clean(rows[i].userId);
      if (uid && !idSet[uid]) { idSet[uid] = true; ids.push(uid); }
    }

    var lookup = {};
    if (ids.length) {
      var gr = new GlideRecord(this.userTable);
      gr.addQuery('sys_id', 'IN', ids.join(','));
      gr.query();
      while (gr.next()) {
        lookup[gr.getUniqueValue()] = {
          id:   gr.getValue('cost_center') || '',
          name: gr.getDisplayValue('cost_center') || ''
        };
      }
    }

    var out = [];
    for (i = 0; i < rows.length; i++) {
      var copy = {};
      for (var f in rows[i]) {
        if (Object.prototype.hasOwnProperty.call(rows[i], f)) copy[f] = rows[i][f];
      }
      if (copy.costCentreId === undefined) {
        var cc = lookup[this._clean(copy.userId)] || { id: '', name: '' };
        copy.costCentreId = cc.id;
        copy.costCentreName = cc.name;
      }
      out.push(copy);
    }
    return out;
  },

  // ---------------------------------------------------------------- money --

  _minor: function (row) {
    var value = parseFloat(row.subtotal);
    if (isNaN(value)) {
      throw new Error('ShiftPayExportSplit: row for employee ' + this._employeeKey(row) +
        ' (' + (row.shiftType || 'unknown shift type') + ') has no numeric subtotal');
    }
    return Math.round(value * this._factor);
  },

  _sumMinor: function (rows) {
    var sums = {};
    for (var i = 0; i < rows.length; i++) {
      var cur = this._currency(rows[i]);
      sums[cur] = (sums[cur] || 0) + this._minor(rows[i]);
    }
    return sums;
  },

  _formatTotals: function (minorSums) {
    var out = {};
    var keys = Object.keys(minorSums).sort();
    for (var i = 0; i < keys.length; i++) out[keys[i]] = this._format(minorSums[keys[i]]);
    return out;
  },

  /** Integer minor units -> '1234.50'. Exact: no float division involved. */
  _format: function (minor) {
    var negative = minor < 0;
    var abs = String(Math.abs(minor));
    if (this.decimals === 0) return (negative ? '-' : '') + abs;
    while (abs.length <= this.decimals) abs = '0' + abs;
    var cut = abs.length - this.decimals;
    return (negative ? '-' : '') + abs.substring(0, cut) + '.' + abs.substring(cut);
  },

  _currency: function (row) {
    return this._clean(row.currency) || '(no currency)';
  },

  // ------------------------------------------------------------- helpers --

  _employeeKey: function (row) {
    return this._clean(row.userId) || this._clean(row.employeeId) ||
      this._clean(row.employeeName) || '(unknown employee)';
  },

  _normaliseMode: function (value) {
    var mode = String(value || 'none').toLowerCase().replace(/^\s+|\s+$/g, '');
    if (mode === 'cost_center' || mode === 'costcentre' || mode === 'costcenter') mode = 'cost_centre';
    if (!ShiftPayExportSplit.MODES[mode]) {
      gs.warn('ShiftPayExportSplit: unknown split "' + value + '" in ' +
        ShiftPayExportSplit.SPLIT_PROPERTY + '; producing the consolidated file only');
      return 'none';
    }
    return mode;
  },

  _clean: function (value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/^\s+|\s+$/g, '');
  },

  _union: function (a, b) {
    var seen = {}, out = [], k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k) && !seen[k]) { seen[k] = true; out.push(k); }
    for (k in b) if (Object.prototype.hasOwnProperty.call(b, k) && !seen[k]) { seen[k] = true; out.push(k); }
    return out.sort();
  },

  type: 'ShiftPayExportSplit'
};
