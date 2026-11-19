var ShiftPayExportNotifier = Class.create();

/**
 * ShiftPayExportNotifier
 * ======================
 * Tells people how a payroll export run ended (BRD NF-5, NF-6, FR-X7, FR-X8).
 *
 *   NF-5  export completed        -> payroll/HR + administrator
 *   NF-6  failure or exceptions   -> administrator only
 *
 * This class sends no email and holds no wording or recipients. It writes the
 * facts onto the export run record and raises an event. Standard ServiceNow
 * notifications on that table do the rest, so a customer can re-template,
 * re-route or disable them without code (BRD section 13). They are created by
 * One Time Scripts/install-export-notifications.js.
 *
 * It decides the outcome itself, so a run with no file to point at can never be
 * announced as a success:
 *
 *   outcome                     completed event   exception event
 *   completed                         yes
 *   completed_with_exclusions         yes               yes
 *   no_approved_timesheets                              yes
 *   no_target_record                                    yes
 *   failed                                              yes
 *
 * Payroll is only on the completed event, so failure details and the excluded
 * list reach the administrator alone.
 *
 * Run record fields written (a template reads them as ${field}):
 *   period_label       'October 2026'
 *   target_record      number of the RITM / HR Case holding the CSV
 *   exception_summary  one line: what needs attention
 *   exception_detail   the error text, when there is one
 *   excluded_count     timesheets left out; empty if it could not be determined
 *   excluded_list      one line per timesheet left out
 *
 * Month convention: `month` arguments are 0-indexed (0 = January); the stored
 * u_month column is 1-indexed.
 *
 * Scoped-app constraints: ES5 only (Rhino) - no let/const, arrow functions or
 * template literals.
 *
 * Usage, from the export run. `run` is the saved run log record. Call this once,
 * on every path, including from the catch block:
 *
 *   var notifier = new ShiftPayExportNotifier();
 *   try {
 *     // ... build the CSV and attach it ...
 *     notifier.report(run, { year: y, month: m, approvedCount: n,
 *                            targetRecord: ritm.getValue('number') });
 *   } catch (e) {
 *     notifier.report(run, { year: y, month: m, error: e.message || String(e) });
 *   }
 */
ShiftPayExportNotifier.EVENT_COMPLETED = 'x_1995110_shift_0.export.completed';
ShiftPayExportNotifier.EVENT_EXCEPTION = 'x_1995110_shift_0.export.exception';

ShiftPayExportNotifier.RUN_FIELDS = [
  'period_label', 'target_record', 'exception_summary',
  'exception_detail', 'excluded_count', 'excluded_list'
];

ShiftPayExportNotifier.prototype = {

  initialize: function (config) {
    config = config || {};
    this.timesheetTable = config.timesheetTable || 'x_1995110_shift_0_monthly_timesheet';
    this.dayTable       = config.dayTable       || 'x_1995110_shift_0_u_shift_submission';
  },

  /**
   * Record the outcome on the run record and raise the matching event(s).
   *
   * @param {GlideRecord} run     the saved export run log record
   * @param {Object}      result
   *   year, month     the period exported (month 0-indexed)
   *   error           failure text; set it whenever the run threw
   *   approvedCount   number of approved timesheets found
   *   targetRecord    number of the record the CSV was attached to
   *   excluded        optional [{ employee, reason }] as the run saw them;
   *                   looked up from the tables when absent
   * @returns {{ outcome: string, events: string[], excludedCount: ?number }}
   */
  report: function (run, result) {
    result = result || {};
    var periodLabel = this._periodLabel(result.year, result.month);

    // A broken lookup must not swallow the alert, nor read as "nothing excluded".
    var excluded = null;
    var lookupError = '';
    try {
      excluded = result.excluded || this.findExcluded(result.year, result.month);
    } catch (e) {
      lookupError = String(e.message || e);
      gs.error('ShiftPayExportNotifier: could not list excluded timesheets for ' +
        periodLabel + ': ' + lookupError);
    }

    var outcome = this._outcome(result, excluded);
    var completed = outcome === 'completed' || outcome === 'completed_with_exclusions';

    var detail = [];
    if (result.error) detail.push(String(result.error));
    if (lookupError) detail.push('The excluded list could not be built: ' + lookupError);

    this._writeRun(run, {
      period_label:      periodLabel,
      target_record:     result.targetRecord || '',
      exception_summary: this._summary(outcome, excluded),
      exception_detail:  detail.join('\n'),
      excluded_count:    excluded ? excluded.length : '',
      excluded_list:     this._formatExcluded(excluded)
    });

    var events = [];
    if (completed) events.push(ShiftPayExportNotifier.EVENT_COMPLETED);
    if (outcome !== 'completed') events.push(ShiftPayExportNotifier.EVENT_EXCEPTION);

    for (var i = 0; i < events.length; i++) {
      gs.eventQueue(events[i], run, periodLabel, outcome);
    }

    return { outcome: outcome, events: events, excludedCount: excluded ? excluded.length : null };
  },

  /**
   * The month's timesheets that are not approved (FR-X8): submitted, rejected,
   * and employees who logged days but never submitted.
   *
   * @returns {Array} [{ employee, reason }] ordered by employee name
   */
  findExcluded: function (year, month) {
    var excluded = [];
    var hasTimesheet = {};

    var ts = new GlideRecord(this.timesheetTable);
    ts.addQuery('u_year', year);
    ts.addQuery('u_month', month + 1); // stored 1-indexed
    ts.query();
    while (ts.next()) {
      var userId = ts.getValue('u_user');
      hasTimesheet[userId] = true;
      // An empty status predates the column and means submitted.
      var status = ts.getValue('status') || 'submitted';
      // 'exported' is BRD section 11: an approved month already in a CSV.
      if (status === 'approved' || status === 'exported') continue;
      excluded.push({
        employee: ts.getDisplayValue('u_user') || userId,
        reason: status === 'rejected' ? 'Rejected, not resubmitted'
                                      : 'Submitted, awaiting approval'
      });
    }

    var prefix = year + '-' + this._pad(month + 1) + '-';
    var day = new GlideRecord(this.dayTable);
    day.addQuery('u_date', '>=', prefix + '01');
    day.addQuery('u_date', '<=', prefix + this._pad(new Date(year, month + 1, 0).getDate()));
    day.query();
    while (day.next()) {
      var dayUser = day.getValue('u_user');
      if (!dayUser || hasTimesheet[dayUser]) continue;
      hasTimesheet[dayUser] = true; // list each employee once
      excluded.push({
        employee: day.getDisplayValue('u_user') || dayUser,
        reason: 'Days logged, not submitted'
      });
    }

    excluded.sort(function (a, b) {
      return String(a.employee).localeCompare(String(b.employee));
    });
    return excluded;
  },

  // ------------------------------------------------------------ internals --

  _outcome: function (result, excluded) {
    if (result.error) return 'failed';
    var count = parseInt(result.approvedCount, 10);
    // A run that cannot say what it exported has not shown that it succeeded.
    if (isNaN(count)) return 'failed';
    // Checked before the target: with nothing to export, none is expected.
    if (count === 0) return 'no_approved_timesheets';
    if (!result.targetRecord) return 'no_target_record';
    // excluded === null means unknown, which the administrator must hear about.
    if (!excluded || excluded.length) return 'completed_with_exclusions';
    return 'completed';
  },

  _summary: function (outcome, excluded) {
    var left = excluded
      ? excluded.length + ' timesheet(s) excluded'
      : 'excluded timesheets unknown';
    if (outcome === 'failed') return 'Export failed; ' + left;
    if (outcome === 'no_approved_timesheets') return 'No approved timesheets to export; ' + left;
    if (outcome === 'no_target_record') return 'No record to attach the CSV to; ' + left;
    if (outcome === 'completed_with_exclusions') return 'Export completed; ' + left;
    return '';
  },

  _formatExcluded: function (excluded) {
    if (!excluded) return 'Could not be determined. Check the timesheets for this month.';
    if (!excluded.length) return 'None';
    var lines = [];
    for (var i = 0; i < excluded.length; i++) {
      lines.push(excluded[i].employee + ' - ' + excluded[i].reason);
    }
    return lines.join('\n');
  },

  /**
   * setValue on a column that does not exist is silently ignored and would send
   * an email full of blanks, so a missing column is logged by name.
   */
  _writeRun: function (run, values) {
    var missing = [];
    for (var i = 0; i < ShiftPayExportNotifier.RUN_FIELDS.length; i++) {
      var field = ShiftPayExportNotifier.RUN_FIELDS[i];
      if (run.isValidField(field)) run.setValue(field, values[field]);
      else missing.push(field);
    }
    if (missing.length) {
      gs.error('ShiftPayExportNotifier: export run table is missing field(s) ' +
        missing.join(', ') + '; notifications will be incomplete');
    }
    // Saved before the events are queued: notifications read the stored record.
    run.update();
  },

  _periodLabel: function (year, month) {
    var names = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
      'August', 'September', 'October', 'November', 'December'];
    return names[month] ? names[month] + ' ' + year : 'unknown period';
  },

  _pad: function (n) { return n < 10 ? '0' + n : '' + n; },

  type: 'ShiftPayExportNotifier'
};
