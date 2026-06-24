# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **ServiceNow scoped application** (scope `x_1995110_shift_0`, portal `/shiftpay`) for logging daily shifts, tracking compensatory-off (CO) entitlements, and computing pay. The repo holds the **source-exported component files of Service Portal widgets** — there is no build, package manager, test runner, or lint config. Editing here is editing widget source that gets pasted/synced back into a ServiceNow instance. There is nothing to compile or run locally; "running" means deploying the widget into a ServiceNow Service Portal page. `BRD-ShiftPay.md` is the business requirements doc and `README.md` documents the data model, roles, and business rules in depth — read them before changing behavior.

## Layout

- `Employee Calendar UI Widget/` — the complete, working widget ("My Shift Submissions" calendar). Each file is one part of a Service Portal widget:
  - `widget.template.html` — AngularJS 1.x template, bound to controller `c` and `c.data`
  - `widget.clientscript.js` — `api.controller` function (the `c` controller)
  - `widget.server-script.js` — server-side IIFE (SSJS / Rhino), reads `input`/`options`, writes `data`
  - `widget.styles.scss` — styles; all custom classes namespaced `shift-`
  - `option-schema.json` — instance options (titles + the five configurable table names)
- `Manager Approval UI Widget/` — **stub only**; all files are empty. This widget is not yet built.

## Architecture essentials (read before editing the calendar widget)

**Three-layer widget contract.** The server script populates the `data` object; the client copies it off `c.data` at bootstrap (`c.entries`, `c.allowedShifts`, etc.) and the template renders `c`. All writes go through `c.server.get({ action: ... })`, which re-runs the *whole* server script — `handleAction(input)` dispatches on `input.action` (`saveDay`, `clearDay`, `bulkSave`, `submitMonth`, `loadMonth`). After a write the server returns fresh `data`; the client patches its local maps and calls `c.refresh()`/`c.recalc()` rather than reloading the page.

**Month indexing is the #1 footgun.** Client/JS/`data.month`/`input.month` are **0-indexed** (0 = January). The stored `u_month` column in the lock and summary tables is **1-indexed** — the server converts with `m + 1` on every read/write to those tables. Keep this invariant when touching date code.

**Five tables, all names configurable via `options`** (defaults shown):
- `u_shift_type_catalog` — active shift types loaded live every `loadMonth`; drives validation, colors (`u_color_hex`), and rates
- `u_shift_submission` — one row per user per day (the transactional table)
- `u_shift_submission_lock` — per-month submission lock (presence of a row = month locked)
- `u_shift_submission_summary` — weekly + monthly aggregates with **rate snapshot** taken at compute time
- `u_shift_co_entitlement` — maps a compound-OC shift to the CO right it grants

**Shift identity is by `sys_id`, but business logic keys off the catalogue `name`** (e.g. `'B'`, `'CO'`, `'OC + CO'`). Both client (`SHIFT_GROUPS`, `FALLBACK_COLORS`) and server (`compoundOcIds`, `coSysId`, `baseAllowedSysIds`) hard-code these exact name strings — note the spaces in `'OC + CO'`, `'OC + B + CO'`, `'OC + C + CO'`. Renaming a catalogue entry breaks both layers.

**CO entitlement flow** (server `handleAction` + entitlement helpers): logging a compound-OC shift inserts an entitlement row with a window of 7 *weekdays* (`nthWeekdayAfter`). Standalone `CO` is only selectable on a weekday covered by an unconsumed entitlement window (`computeAllowedShifts` → `hasUnconsumedEntitlementFor`). Saving a CO consumes the earliest eligible entitlement; clearing/changing an entry releases or deletes the entitlement, and the server **blocks** removing an OC entry that a CO still depends on. CO and compound-OC are deliberately rejected in `bulkSave`.

**Allowed-shifts are computed server-side, enforced client-side.** `data.allowedShifts` is `{ 'YYYY-MM-DD': [sys_id,...] }`; the client's `c.isAllowed` filters dropdowns. Weekend/holiday detection on the server uses a `cmn_schedule` whose sys_id is in system property `x_shiftpay.holiday_schedule` (read via `cmn_schedule_span`).

**Aggregates are recomputed, not incremented.** After any day change, `recomputeAggregates(dates)` deletes and rewrites the affected month row and each affected week row (`writeSummary` does delete-then-insert per shift type), snapshotting the current rate.

## Conventions

- Server script is a single IIFE in ES5 (ServiceNow Rhino) — no `let`/`const`/arrow functions/template literals there. Client script targets AngularJS 1.x.
- Dates are passed across the wire as `'YYYY-MM-DD'` strings and compared lexically (string comparison is intentional and relied upon, e.g. window checks).
- CSS classes are BEM-light, all prefixed `shift-`; Bootstrap 3 (`.btn`, `.panel`, etc.) and Font Awesome are assumed present from Service Portal.
- When adding a widget option that names a table, mirror the default in `option-schema.json` *and* the `options.x || 'default'` fallback at the top of the server script.
