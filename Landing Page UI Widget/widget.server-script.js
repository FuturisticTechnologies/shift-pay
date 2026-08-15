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

  function pageUrl(value, fallback) {
    var pageId = String(value || fallback);
    if (!/^[A-Za-z0-9_-]+$/.test(pageId)) pageId = fallback;
    return '?id=' + encodeURIComponent(pageId);
  }
})();
