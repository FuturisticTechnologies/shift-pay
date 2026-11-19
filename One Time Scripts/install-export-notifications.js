/**
 * Create the payroll export events and notifications (BRD NF-5, NF-6, FR-X7).
 * ===========================================================================
 * Creates two event registrations and two standard email notifications on the
 * export run table. ShiftPayExportNotifier raises the events.
 *
 * Run as a **Fix Script** (sys_script_fix) in the ShiftPay scope.
 *
 * Needs first:
 *   - the export run table, with the fields in REQUIRED_FIELDS below. The
 *     script refuses to create anything without them.
 *   - groups 'ShiftPay Payroll' and 'ShiftPay Administrators', with members
 *     who have email addresses. Create them through the UI; this script only
 *     reads them. A notification with no recipients sends nothing and says
 *     nothing, so a missing group is warned about. Add it and re-run.
 *
 * Idempotent, and safe on a customised instance: an existing notification keeps
 * its subject, body, active flag and recipients. The one thing a re-run fills
 * in is the recipient groups of a notification that has no recipients at all.
 */
(function installExportNotifications() {
  var RUN_TABLE = 'x_1995110_shift_0_export_run';

  var REQUIRED_FIELDS = [
    'period_label',       // String 40
    'target_record',      // String 100
    'exception_summary',  // String 200
    'exception_detail',   // String 4000
    'excluded_count',     // Integer
    'excluded_list'       // String 65000
  ];

  var PAYROLL = 'ShiftPay Payroll';
  var ADMINS  = 'ShiftPay Administrators';

  var NOTIFICATIONS = [
    {
      name:        'ShiftPay: payroll export completed',
      event:       'x_1995110_shift_0.export.completed',
      description: 'NF-5: a payroll CSV was generated and attached to a record',
      groups:      [PAYROLL, ADMINS],
      subject:     'Payroll CSV for ${period_label} generated and attached to ${target_record}',
      body:        '<p>The payroll CSV for ${period_label} has been generated and ' +
                   'attached to <strong>${target_record}</strong>.</p>'
    },
    {
      name:        'ShiftPay: payroll export needs attention',
      event:       'x_1995110_shift_0.export.exception',
      description: 'NF-6, FR-X7: an export failed, found nothing approved, or excluded timesheets',
      groups:      [ADMINS],
      subject:     'ShiftPay export for ${period_label}: ${exception_summary}',
      body:        '<p><strong>${exception_summary}</strong></p>' +
                   '<p>Period: ${period_label}<br/>CSV attached to: ${target_record}</p>' +
                   '<p style="white-space:pre-wrap">${exception_detail}</p>' +
                   '<p><strong>Timesheets excluded because they are not approved</strong></p>' +
                   '<p style="white-space:pre-wrap">${excluded_list}</p>' +
                   '<p>${URI_REF}</p>'
    }
  ];

  var log = function (msg) {
    gs.info('[install-export-notifications] ' + msg);
    // gs.print is blocked inside a scoped app.
    if (typeof gs.print === 'function') {
      try { gs.print('[install-export-notifications] ' + msg); } catch (e) {}
    }
  };

  var probe = new GlideRecord(RUN_TABLE);
  if (!probe.isValid()) {
    log('STOP: table ' + RUN_TABLE + ' does not exist. Nothing created.');
    return;
  }
  var missing = [];
  for (var f = 0; f < REQUIRED_FIELDS.length; f++) {
    if (!probe.isValidField(REQUIRED_FIELDS[f])) missing.push(REQUIRED_FIELDS[f]);
  }
  if (missing.length) {
    log('STOP: ' + RUN_TABLE + ' is missing ' + missing.join(', ') + '. Nothing created.');
    return;
  }

  function groupIds(names) {
    var ids = [];
    for (var i = 0; i < names.length; i++) {
      var group = new GlideRecord('sys_user_group');
      if (group.get('name', names[i])) ids.push(group.getUniqueValue());
      else log('WARNING: group "' + names[i] + '" does not exist');
    }
    return ids.join(',');
  }

  function ensureEvent(spec) {
    var reg = new GlideRecord('sysevent_register');
    if (reg.get('event_name', spec.event)) {
      log('event exists: ' + spec.event);
      return;
    }
    reg.initialize();
    reg.setValue('event_name',  spec.event);
    reg.setValue('table',       RUN_TABLE);
    reg.setValue('description', spec.description);
    reg.setValue('fired_by',    'ShiftPayExportNotifier');
    log((reg.insert() ? 'created event: ' : 'FAILED to create event: ') + spec.event);
  }

  function ensureNotification(spec) {
    var recipients = groupIds(spec.groups);
    var n = new GlideRecord('sysevent_email_action');

    if (n.get('name', spec.name)) {
      var routed = n.getValue('recipient_groups') || n.getValue('recipient_users') ||
                   n.getValue('recipient_fields');
      if (!routed && recipients) {
        n.setValue('recipient_groups', recipients);
        n.update();
        log('added recipient groups: ' + spec.name);
      } else {
        log('notification exists, left as is: ' + spec.name);
        if (!routed) log('WARNING: it has no recipients and will not send');
      }
      return;
    }

    n.initialize();
    n.setValue('name',             spec.name);
    n.setValue('description',      spec.description);
    n.setValue('collection',       RUN_TABLE);
    n.setValue('generation_type',  'event');
    n.setValue('event_name',       spec.event);
    n.setValue('recipient_groups', recipients);
    // Without this, an administrator who runs the export by hand would be
    // dropped from their own alert.
    n.setValue('send_self',        true);
    n.setValue('content_type',     'text/html');
    n.setValue('subject',          spec.subject);
    n.setValue('message_html',     spec.body);
    n.setValue('active',           true);
    log((n.insert() ? 'created notification: ' : 'FAILED to create notification: ') + spec.name);
    if (!recipients) log('WARNING: ' + spec.name + ' has no recipients and will not send');
  }

  for (var i = 0; i < NOTIFICATIONS.length; i++) {
    ensureEvent(NOTIFICATIONS[i]);
    ensureNotification(NOTIFICATIONS[i]);
  }
})();
