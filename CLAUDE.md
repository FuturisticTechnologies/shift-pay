# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A **ServiceNow scoped application** (scope `x_1995110_shift_0`, portal `/shiftpay`) for logging daily shifts, tracking compensatory-off (CO) entitlements, and computing pay. The repo holds the **source-exported component files of Service Portal widgets** — there is no build, package manager, test runner, or lint config. Editing here is editing widget source that gets pasted/synced back into a ServiceNow instance. There is nothing to compile or run locally; "running" means deploying the widget into a ServiceNow Service Portal page. `BRD-ShiftPay.md` is the business requirements doc and `README.md` documents the data model, roles, and business rules in depth — read them before changing behavior.

## Layout

- `Landing Page UI Widget/` — simple ShiftPay home screen with always-visible links to the employee calendar and manager approvals. It uses the signed-in user's first name for the greeting and configurable Service Portal page IDs for both destinations.
- `Employee Calendar UI Widget/` — the complete, working widget ("My Shift Submissions" calendar). Each file is one part of a Service Portal widget:
  - `widget.template.html` — AngularJS 1.x template, bound to controller `c` and `c.data`
  - `widget.clientscript.js` — `api.controller` function (the `c` controller)
  - `widget.server-script.js` — server-side IIFE (SSJS / Rhino), reads `input`/`options`, writes `data`
  - `widget.styles.scss` — styles; all custom classes namespaced `shift-`
  - `option-schema.json` — instance options (titles + the five configurable table names)
- `Manager Approval UI Widget/` — in progress. Team approval queue: pending timesheets with approve/reject, past decisions, per-day correction with a mandatory reason, and per-shift-type cost. Schema and shared logic are deployed; the widget files themselves are still being written.
- `Script Includes/` — server-side classes shared by more than one widget. Not widget source, so it deploys to `sys_script_include` rather than `sp_widget`.
  - `ShiftPayAggregator.js` — weekly/monthly aggregation with the rate snapshot, **parameterised by user**. Both the calendar (own user) and the manager widget (a reportee) call it. This logic used to live inline in the calendar server script hard-wired to `gs.getUserID()`, which is precisely what made it unusable from the manager side. Never fork it — a second copy of payroll maths that drifts is a pay bug.

## Architecture essentials (read before editing the calendar widget)

**Three-layer widget contract.** The server script populates the `data` object; the client copies it off `c.data` at bootstrap (`c.entries`, `c.allowedShifts`, etc.) and the template renders `c`. All writes go through `c.server.get({ action: ... })`, which re-runs the *whole* server script — `handleAction(input)` dispatches on `input.action` (`saveDay`, `clearDay`, `bulkSave`, `submitMonth`, `loadMonth`). After a write the server returns fresh `data`; the client patches its local maps and calls `c.refresh()`/`c.recalc()` rather than reloading the page.

**Month indexing is the #1 footgun.** Client/JS/`data.month`/`input.month` are **0-indexed** (0 = January). The stored `u_month` column in the lock and summary tables is **1-indexed** — the server converts with `m + 1` on every read/write to those tables. Keep this invariant when touching date code.

**Five tables, all names configurable via `options`** (defaults shown):
- `u_shift_type_catalog` — active shift types loaded live every `loadMonth`; drives validation, colors (`color_hex`), rates, and **all shift semantics** (see below)
- `u_shift_submission` — one row per user per day (the transactional table)
- `u_shift_submission_lock` — per-month submission lock (presence of a row = month locked)
- `u_shift_submission_summary` — weekly + monthly aggregates with **rate snapshot** taken at compute time
- `u_shift_co_entitlement` — maps a compound-OC shift to the CO right it grants

**Shift semantics are data-driven, keyed by `sys_id` — never by the catalogue `name`.** The display `name`/`description` are cosmetic; renaming a shift type changes no behaviour. Meaning comes from catalogue columns: `oc_role` (`none`/`grants_co`/`consumes_co` → server `compoundOcIds`, `coSysId`), `allow_weekday` + `allow_weekend_holiday` (→ `baseAllowedSysIds`), `day_category` (`regular`/`off`/`holiday` → client grouping/legend), and `color_hex` (chip colour; the pale tint is derived in `buildShiftTypes` via `softTint`, not stored). When adding a shift type or changing the catalogue, set these columns — there are no name strings to keep in sync. `validateCatalogue` sets `data.configError` (shown as a banner) if any active row lacks `day_category`, or if CO is enabled but no `consumes_co` row exists. To backfill existing rows after adding the columns, run `One Time Scripts/backfill-shift-type-semantics.js`.

**CO entitlement flow** (server `handleAction` + entitlement helpers) — gated by the `enable_co_entitlement` option (default `true`; when `false` every entitlement branch is skipped and CO/compound-OC act as ordinary shifts): logging a `grants_co` shift inserts an entitlement row with a window of 7 *weekdays* (`nthWeekdayAfter`). The `consumes_co` shift is only selectable on a weekday covered by an unconsumed entitlement window (`computeAllowedShifts` → `hasUnconsumedEntitlementFor`). Saving it consumes the earliest eligible entitlement; clearing/changing an entry releases or deletes the entitlement, and the server **blocks** removing an OC entry that a CO still depends on. `consumes_co`/`grants_co` shifts are deliberately rejected in `bulkSave`.

**Allowed-shifts are computed server-side, enforced client-side.** `data.allowedShifts` is `{ 'YYYY-MM-DD': [sys_id,...] }`; the client's `c.isAllowed` filters dropdowns. Weekend/holiday detection on the server uses a `cmn_schedule` whose sys_id is in system property `x_shiftpay.holiday_schedule` (read via `cmn_schedule_span`).

**Aggregates are recomputed, not incremented.** After any day change, `new ShiftPayAggregator({...}).recompute(dates)` deletes and rewrites the affected month row and each affected week row (delete-then-insert per shift type), snapshotting the current rate. The widget's `recomputeAggregates` is a thin delegation to it. Known wart, preserved deliberately so the extraction stayed behaviour-neutral: the rate map reads **active catalogue rows only**, so a shift type deactivated after being logged re-aggregates at ₹0.

**Approval state lives on the monthly-timesheet row**, not a separate table: `status` (submitted/approved/rejected), `approver`, `actioned_on`, `manager_comment`. A month is locked when a row exists **and** `status != 'rejected'` — rejection reopens it for editing, and `submitMonth` reuses the existing row on resubmission rather than inserting a second one. Manager per-day corrections are audited in `x_1995110_shift_0_shift_day_change`.

**Deploying to the instance.** Writes go through `cnit put sp_widget -SysId <id>` (fields `template`, `script`, `client_script`, `css`) and `cnit post/put sys_script_include`. Two traps, both hit for real: `Get-Content -Raw` returns a string carrying ETS note properties that `ConvertTo-Json` serialises into the payload, and PowerShell 5.1's `ConvertTo-Json` does not escape non-ASCII while cnit reads body files with no `-Encoding`. Read with `[IO.File]::ReadAllText`, escape every char above 127 to `\uXXXX`, write ASCII — then **read the field back and compare it to the local file**. A push can return HTTP 200 and store garbage.

## Conventions

- Server script is a single IIFE in ES5 (ServiceNow Rhino) — no `let`/`const`/arrow functions/template literals there. Client script targets AngularJS 1.x.
- Dates are passed across the wire as `'YYYY-MM-DD'` strings and compared lexically (string comparison is intentional and relied upon, e.g. window checks).
- CSS classes are BEM-light, all prefixed `shift-`; Bootstrap 3 (`.btn`, `.panel`, etc.) and Font Awesome are assumed present from Service Portal.
- When adding a widget option that names a table, mirror the default in `option-schema.json` *and* the `options.x || 'default'` fallback at the top of the server script.
- **New columns on this scoped app's custom tables are created without the `u_` prefix** (e.g. `color_hex`, `oc_role`, not `u_color_hex`). Pre-existing `u_`-prefixed fields (e.g. `u_shift_type`, `u_date` on the submission table) keep their names; this convention applies only to fields we add going forward.
- Git workflow: commit locally when requested or useful, but do not push to any remote unless the user explicitly asks for a push.
- **Never delete remote/GitHub branches** (no `git push origin --delete`, no branch deletion via `gh`). The user keeps merged branches for future reference. Deleting the local copy of a merged branch is fine; the remote branch must stay.
- **ServiceNow PDI access for this project:** call the shared `cnit-instance-tools/cnit.ps1` with `-ProfileName shiftpay-admin`. Before every write, run `status -ProfileName shiftpay-admin` and confirm the authenticated user is `admin`; never perform ShiftPay writes through the default `pdi` profile. Writes still require explicit user approval and the CLI's `-Write` switch.
- **Do not use the `reyantech` account or the `shiftpay-reyantech` profile.** That account is being retired: it must not appear as a shift owner, manager, approver, or in `sys_created_by`/`sys_updated_by` on anything new. Note `sys_created_by` is immutable — ServiceNow silently ignores attempts to set it — so a record created under the wrong account can only be corrected by deleting and recreating it. Get the profile right *before* the first insert.
