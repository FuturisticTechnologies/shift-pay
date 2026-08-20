# ShiftPay — Test Cases

**Scope.** The two employee-facing and manager-facing Service Portal widgets:
the **Employee Calendar** (`fill-shift-calendar-ui`, page `fill_shift`) and
**Manager Approval** (`shiftpay-manager-approval-ui`, page `manager_approval`),
together with the three Script Includes they both depend on.

This file is the **single source of truth for what a case is** — its priority,
what it exercises, what it expects. The Playwright run supplies what actually
happened, and the evidence generator merges the two. Nothing is retyped between
them, so a document cannot claim an expected result this file does not contain.

| | |
|---|---|
| Application | Shift Pay Management, scope `x_1995110_shift_0`, v1.0.0 |
| Instance | `dev227442.service-now.com` |
| Portal | `/shiftpay` |
| Baseline captured | 2026-08-20, direct from instance metadata (re-pointed from `dev307042` that day) |
| Cases | 40 — **9 automated**, 31 pending |

---

## How to read a case

| Field | Meaning |
|---|---|
| **Priority** | P1 blocks a release, P2 matters, P3 is polish |
| **Type** | Positive / Negative / Boundary / Regression |
| **Component** | The exact artefact under test, so a failure names a thing to fix |
| **Evidence** | `UI+record`, `record-only`, or `UI-only` |
| **Status** | `AUTOMATED` or `PENDING` |
| **Verify** | The assertion against the record, independent of what the screen claimed |

**Evidence policy.** Every case that asserts a state change carries **two**
proofs: what the screen showed, and what the record holds. A repainted calendar
cell proves the browser did something, not that the row moved. The `Verify` line
decides pass or fail; the screenshot is what goes in the document.

That policy is not academic here. **TC-SP-004 is a case where the two disagree** —
the screen shows a day cleared that the server refused to clear. A single-sided
check would have called it a pass.

---

## Baseline: what the instance contains

Captured 2026-08-17. Confirm rather than trusting these before a formal pass.

### Tables

All are scoped and fully qualified. **Take table names from here, never from the
widget source** — see TC-SP-031.

| Purpose | Table |
|---|---|
| Daily shifts | `x_1995110_shift_0_u_shift_submission` |
| Monthly timesheet / lock | `x_1995110_shift_0_monthly_timesheet` |
| Shift type catalogue | `x_1995110_shift_0_shift_type` |
| Weekly + monthly aggregates | `x_1995110_shift_0_shift_submission_summary` |
| CO entitlements | `x_1995110_shift_0_shift_co_entitlement` |
| Manager day-correction audit | `x_1995110_shift_0_shift_day_change` |

### Portal pages

`shiftpay_home` (portal homepage), `fill_shift`, `manager_approval`,
`shift_reports`.

> `shift_reports` renders `shiftpay-reporting-ui`. Its source now lives in
> `Reports UI Widget/`, pulled from the instance on 18 Aug 2026. No cases are
> written for it yet — the pack predates the export, and adding them is a
> separate piece of work rather than an oversight.

### Shift type catalogue — 9 active rows

Semantics are keyed by `sys_id` and carried in columns. The `name` is cosmetic.

| Name | `oc_role` | `allow_weekday` | `allow_weekend_holiday` | `day_category` | Rate |
|---|---|---|---|---|---|
| UK | none | ✔ | ✘ | regular | 350 |
| US | none | ✔ | ✘ | regular | 500 |
| L | none | ✔ | **✔** | off | 0 |
| Not Eligible | none | ✔ | **✔** | off | 0 |
| CO | consumes_co | ✔ | ✘ | **holiday** | 0 |
| OC | none | ✘ | ✔ | holiday | 500 |
| OC + CO | grants_co | ✘ | ✔ | holiday | 500 |
| OC + UK + CO | grants_co | ✘ | ✔ | holiday | 850 |
| OC + US + CO | grants_co | ✘ | ✔ | holiday | 1000 |

The two bolded `allow_weekend_holiday` values and the bolded `day_category` are
findings, not description — see TC-SP-005.

### Users

| User | Role here | Data |
|---|---|---|
| `admin` | Employee **and** manager | **no day rows of their own** — the seeder refuses to seed the manager as their own reportee; no timesheet either; manages the six below |
| `melinda.carleton` | Reportee | 69 day rows; three timesheets |
| `abel.tuter` | Reportee | 73 day rows; three timesheets |
| `amelia.caputo` | Reportee | 71 day rows; three timesheets |
| `angelo.ferentz` | Reportee | 73 day rows; three timesheets |
| `billie.cowley` | Reportee | 73 day rows; three timesheets |
| `jewel.agresta` | Reportee | 69 day rows; three timesheets |

All six reportees carry **2026-05 approved** and **2026-06 approved**. July 2026
is **submitted** for five of them and **approved** for Melinda; the blockquote
below says why that one difference matters.

**Zero entitlement rows exist on `dev227442`,** and that is the correct starting
state rather than a gap: nothing seeds entitlements, the demo creates one live on
screen, and the reveal depends on there being none beforehand.

None of these counts are preconditions — they are one instance's history, and the
previous instance's differed (`dev307042` held a single entitlement, created by
hand through the widget, plus an April timesheet and a calendar for `admin`). The
automated cases read the baseline at run time and assert against it (see rule 4
below), scoped to `u_user=<me>`, so they pass on either instance. Do not replace
that relative assertion with a fixed number.

> **2026-07 is the demo month, and its mix is load-bearing.** Five reportees
> submitted against one approved is what keeps `counts.all` (6) different from
> `counts.submitted` (5). If every reportee were submitted the two would agree,
> the TC-SP-009 tile would look correct, and that case would pass for the wrong
> reason. Do not "tidy" July into a uniform state.

### Configuration

`x_shiftpay.holiday_schedule` **does not exist** — no `x_shiftpay.*` property
does. See TC-SP-030.

---

## Test data rules

1. **Automated cases write only to `admin`'s own calendar**, never to a
   reportee's. Melinda's months back the manager cases and are read, never
   written.
2. **Every automated write reverses itself** through the widget's own
   `clearDay`. None of the nine approves, rejects or corrects anything, so a full
   run cannot disturb approval state.
3. **`cnit` has no delete verb.** A case that aborts mid-transaction leaves
   residue that must be cleaned through the platform UI. Write late, tear down in
   one reversal.
4. **The entitlement table is the fragile one.** Whatever it holds before a run,
   it must hold exactly that after. Confirm the count is unchanged following any
   run of TC-SP-003 or TC-SP-004. The assertion is deliberately *relative* — the
   spec reads the count first and expects `baseline + 1` mid-case and `baseline`
   after teardown — so do not replace it with a fixed number. A hard-coded count
   would encode one instance's history as a rule and fail everywhere else.
5. Automated cases pick a **future, unsubmitted month** for their writes so no
   lock is in play and no aggregate anyone is looking at moves.

---

# Employee Calendar

## Allowed shifts

### TC-SP-001 — Weekday and weekend offer different shift sets, driven by catalogue columns

| | |
|---|---|
| **Priority** | P1 |
| **Type** | Positive |
| **Component** | `ShiftPayCalendarRules.baseAllowedSysIds` → `data.allowedShifts` → `c.isAllowed` |
| **Evidence** | UI+record |
| **Status** | AUTOMATED |

The whole shift-availability rule is data-driven: nothing branches on the
catalogue `name`. This case proves the chain end to end — the columns decide, the
server computes, the client filters, the user sees the result.

**Precondition**
- A month with at least one unlogged plain weekday and one Saturday.

**Steps**
- Open `/shiftpay?id=fill_shift`.
- Open a plain weekday cell and read every shift offered in the dropdown.
- Close it, open a Saturday cell, and read the dropdown again.

**Expected**
- The weekday list equals the catalogue rows with `allow_weekday = true`, minus the `consumes_co` row.
- The weekend list equals the catalogue rows with `allow_weekend_holiday = true`.
- `CO` is absent from the weekday list. A CO is earned, not merely permitted — it appears only inside an unconsumed entitlement window, which TC-SP-003 proves.

**Verify**
- `cnit get x_1995110_shift_0_shift_type -Query "active=true" -Fields name,allow_weekday,allow_weekend_holiday,oc_role`
- Compare both rendered lists against that catalogue read, by name.

**Note**
- This case tests the *implementation contract*: columns to screen. TC-SP-005 tests the *documented requirement*: README to screen. They disagree, deliberately, and that disagreement is the finding.

### TC-SP-005 — The weekend dropdown offers two shifts the business rules forbid

| | |
|---|---|
| **Priority** | P2 |
| **Type** | Negative |
| **Component** | `x_1995110_shift_0_shift_type` rows `L` and `Not Eligible` |
| **Evidence** | UI+record |
| **Status** | AUTOMATED — expected to FAIL |

README §Business Rules — *Shift Availability* states the weekend/holiday set is
exactly `OC`, `OC+CO`, `OC+UK+CO`, `OC+US+CO`, and puts `L` and `Not Eligible`
in the weekday set. The catalogue disagrees.

**Steps**
- Open the calendar and open a Saturday cell.
- Open the shift dropdown and read every option.

**Expected**
- Exactly four options: `OC`, `OC + CO`, `OC + UK + CO`, `OC + US + CO`.

**Verify**
- `cnit get x_1995110_shift_0_shift_type -Query "allow_weekend_holiday=true" -Fields name,day_category`
- Six rows come back, not four.

**Why it matters**
- Booking Leave on a Saturday is meaningless, and "Not Eligible" on a non-working day says nothing. Today it costs nothing only because both rates are ₹0 — the same mistake on a paid row would be a pay bug rather than a cosmetic one.

**Fix**
- A data change, not a code change: untick `allow_weekend_holiday` on the `L` and `Not Eligible` catalogue rows. Availability is data-driven, so no widget is touched.

**Adjacent finding**
- `CO` carries `day_category = holiday` while `allow_weekend_holiday = false`, so the legend and the dropdown file it under *"Holiday work (weekend or declared holiday)"* — a class of day on which it can never be logged. Cosmetic, but it sends a user looking in the wrong place. Recorded here rather than as its own case.

### TC-SP-010 — A misconfigured catalogue raises the config-error banner

| | |
|---|---|
| **Priority** | P2 |
| **Type** | Negative |
| **Component** | `ShiftPayCalendarRules.configError` → `.shift-widget__configerror` |
| **Evidence** | UI+record |
| **Status** | PENDING |

**Steps**
- Clear `day_category` on one active catalogue row; reload the calendar.
- Restore it, deactivate every `consumes_co` row, reload again.

**Expected**
- The first raises *"… is missing a day category."*; the second raises *"CO entitlement is enabled but no shift type has the consumes_co role."*
- Both render in the banner; neither prevents the rest of the calendar from working.

**Note**
- Pending because it mutates the shared catalogue, which every other case reads.

### TC-SP-011 — Renaming a shift type changes no behaviour

| | |
|---|---|
| **Priority** | P3 |
| **Type** | Regression |
| **Component** | Catalogue semantics keyed by `sys_id` |
| **Evidence** | UI+record |
| **Status** | PENDING |

**Expected**
- After renaming a catalogue row, the same days offer the same shift, the same colour renders, and entitlement behaviour is unchanged. Only the chip text differs.

### TC-SP-012 — `enable_co_entitlement = false` makes CO an ordinary shift

| | |
|---|---|
| **Priority** | P2 |
| **Type** | Positive |
| **Component** | `CO_ENABLED` branch in both server scripts |
| **Evidence** | UI+record |
| **Status** | PENDING |

**Expected**
- With the option off, `CO` is selectable on any weekday with no entitlement, `grants_co` shifts insert no entitlement rows, and `blocksBulk` stops refusing.

## Logging a day

### TC-SP-002 — Logging a day writes one row and re-aggregates with a rate snapshot

| | |
|---|---|
| **Priority** | P1 |
| **Type** | Positive |
| **Component** | `saveDay` / `clearDay` → `upsertDay` → `ShiftPayAggregator.recompute` |
| **Evidence** | UI+record |
| **Status** | AUTOMATED |

The core transaction. Proves the screen *and* the aggregate together: a chip
appearing proves the form posted, not that payroll's numbers moved.

**Precondition**
- An unlogged plain weekday in a future, unsubmitted month on the signed-in user's own calendar.

**Steps**
- Open the day, select `UK`, type a comment, save.
- Read the submission row and the week's summary rows.
- Clear the same day and read both again.

**Expected**
- Exactly one `u_shift_submission` row for that user and date, `u_shift_type` = the `UK` sys_id and `u_comment` matching what was typed.
- A `week` summary row exists for the Monday of that week with `u_period_type = week`, `u_rate_snapshot = 350` and `u_amount = u_count × 350`.
- After clearing: the submission row is gone and the summary has reverted to its pre-run state.

**Verify**
- `cnit get x_1995110_shift_0_u_shift_submission -Query "u_user=<me>^u_date=<date>"`
- `cnit get x_1995110_shift_0_shift_submission_summary -Query "u_user=<me>^u_period_type=week^u_period_start=<monday>"`

**Note**
- The rate is asserted as the snapshot on the summary row, not as today's catalogue rate. A catalogue rate change after aggregation must not move an already-computed amount, and reading the live rate would hide it if it did.

### TC-SP-004 — A refused write is painted on screen as though it succeeded

| | |
|---|---|
| **Priority** | P1 |
| **Type** | Negative |
| **Component** | `c.saveCell` / `c.clearCell` / `c.bulkApply` vs the server's refusal paths |
| **Evidence** | UI+record |
| **Status** | AUTOMATED — expected to FAIL |

The server refuses correctly. The screen then shows the opposite of what
happened, and keeps showing it until the page is reloaded.

**Precondition**
- A `grants_co` shift on a Saturday and a `CO` consuming it on a weekday inside the window — the state TC-SP-003 builds. This case builds its own and tears it down.

**Steps**
- Log `OC + CO` on a Saturday, then `CO` on a weekday inside the 7-weekday window.
- Open the Saturday again and press **Clear**.
- Screenshot the calendar immediately.
- Read the submission row and the entitlement row.
- Reload the page and screenshot the same cell again.

**Expected**
- The clear is refused, and the user is told so — *"Cannot clear — CO on … depends on this entry."* should appear in `.shift-popover__error`.
- The Saturday cell keeps its chip.

**Actual**
- The record is correct: the submission row survives untouched and the entitlement is unchanged. The server did its job.
- The screen is wrong: the popover closes, no error renders anywhere, and the cell goes **empty** — the client deleted the entry from its local map on the success path.
- After a reload the chip is back, so two captures of the same day show opposite states.

**Root cause**
- `c.saveCell`, `c.clearCell` and `c.bulkApply` all branch on `r.data.error`. The server script never sets `data.error` — all six refusal paths use `gs.addErrorMessage()` instead. `r.data.error` is therefore always `undefined`, the client falls through to its success branch, and it optimistically mutates `c.entries`, closes the popover and repaints.

**Scope of the defect**
- Not just this refusal. Every server-side refusal in the calendar is invisible: month locked, CO dependency, CO unavailable, bulk-blocked shift type, and the incomplete-month submit refusal.

**Fix**
- Mirror the Manager Approval widget, which gets this right: its `fail()` sets `data.actionError` *and* calls `gs.addErrorMessage`, and its template renders `.shift-mgr__error`. Have the calendar's refusal paths set `data.error` and keep the growl.

**Note**
- Self-reversing: the server changed nothing, so teardown is simply clearing the CO and then the OC+CO.

### TC-SP-013 — A comment round-trips and shows as a dot

| | |
|---|---|
| **Priority** | P3 |
| **Type** | Positive |
| **Component** | `u_comment`, `.shift-cell__dot` |
| **Evidence** | UI+record |
| **Status** | PENDING |

### TC-SP-014 — Changing a day's shift updates rather than duplicating

| | |
|---|---|
| **Priority** | P2 |
| **Type** | Positive |
| **Component** | `upsertDay` |
| **Evidence** | UI+record |
| **Status** | PENDING |

**Expected**
- Saving a second shift on a day already logged leaves exactly one row, with the new `u_shift_type` and the same `sys_id`.

### TC-SP-015 — Bulk edit applies to every selected weekday in one action

| | |
|---|---|
| **Priority** | P2 |
| **Type** | Positive |
| **Component** | `bulkSave`, `c.selectAllWeekdays` |
| **Evidence** | UI+record |
| **Status** | PENDING |

**Expected**
- Weekends cannot be selected in bulk mode; *Select all weekdays* selects exactly the working days; applying writes one row per selected date and recomputes each affected week.

### TC-SP-016 — Bulk edit refuses CO and compound-OC shifts

| | |
|---|---|
| **Priority** | P2 |
| **Type** | Negative |
| **Component** | `ShiftPayEntitlements.blocksBulk` |
| **Evidence** | UI+record |
| **Status** | PENDING |

**Expected**
- The bulk bar never offers a `consumes_co` or `grants_co` shift, and a hand-made `bulkSave` carrying one is refused with *"This shift type cannot be applied in bulk…"*.

**Note**
- Blocked on the same mechanism as TC-SP-020 — see the note there.

## CO entitlement

### TC-SP-003 — The CO entitlement lifecycle, end to end

| | |
|---|---|
| **Priority** | P1 |
| **Type** | Positive |
| **Component** | `ShiftPayEntitlements` three-phase day change; `_nthWeekdayAfter` |
| **Evidence** | UI+record |
| **Status** | AUTOMATED |

The flagship. Logging a `grants_co` shift creates a right to a day off; this case
follows that right from creation through consumption to release, and proves the
guard that stops the two getting out of step.

**Precondition**
- A future, unsubmitted month containing a Saturday with at least seven weekdays after it in the same month.

**Steps**
- Log `OC + CO` on a Saturday.
- Read the entitlement table.
- Open a weekday inside the window and read the dropdown.
- Select `CO` and save; read the entitlement row again.
- Open the Saturday and press **Clear**.
- Teardown: clear the CO, then clear the Saturday.

**Expected**
- One entitlement row is inserted, `oc_date` = the Saturday and `u_oc_window_end` = the **7th weekday after** it, computed independently rather than read back.
- `CO` appears in that weekday's dropdown, where TC-SP-001 proved it does not appear without an entitlement.
- Saving `CO` sets `u_co_date` and `u_co_entry` on that same row — consumed, not duplicated.
- Clearing the Saturday is **refused** while the CO depends on it; the submission row survives.
- After teardown the entitlement row is deleted and the table is back to its baseline row count.

**Verify**
- `cnit get x_1995110_shift_0_shift_co_entitlement -Query "u_user=<me>" -Fields oc_date,u_oc_window_end,u_co_date,u_co_entry`

**Boundary**
- The window is *strictly after* the OC date and inclusive of the end date — a CO can never be taken on the OC day itself. Dates are compared as strings, which is deliberate and relied upon.

**Note**
- The refusal in step 5 is correct server behaviour and is asserted here at record level. The fact that the *screen* does not say so is TC-SP-004's finding, not this one's — which is why this case passes and that one fails on the same interaction.

### TC-SP-017 — The oldest eligible entitlement is consumed first

| | |
|---|---|
| **Priority** | P2 |
| **Type** | Boundary |
| **Component** | `_findEarliestUnconsumedFor` |
| **Evidence** | record-only |
| **Status** | PENDING |

### TC-SP-018 — CO is refused outside every window

| | |
|---|---|
| **Priority** | P2 |
| **Type** | Negative |
| **Component** | `reserveForNew` |
| **Evidence** | UI+record |
| **Status** | PENDING |

**Expected**
- On a weekday no window covers, `CO` is absent from the dropdown, and a direct write is refused with *"CO not available for … — log an OC+CO shift on a prior holiday first."*

### TC-SP-019 — Changing a consumed CO to another shift releases the entitlement

| | |
|---|---|
| **Priority** | P2 |
| **Type** | Positive |
| **Component** | `releasePrevious` → `_release` |
| **Evidence** | record-only |
| **Status** | PENDING |

**Expected**
- `u_co_date` and `u_co_entry` are cleared, the entitlement row survives, and the window becomes available again.

## Submission and locking

### TC-SP-020 — Submit is refused while any weekday is unlogged

| | |
|---|---|
| **Priority** | P1 |
| **Type** | Negative |
| **Component** | `submitMonth` weekday-coverage check |
| **Evidence** | UI+record |
| **Status** | PENDING |

**Expected**
- The footer reads *"x of y working days logged"* consistent with the day rows and the Submit button is disabled.
- A `submitMonth` payload sent directly, bypassing the button, is still refused with *"Cannot submit: n weekday(s) still unlogged."* and creates no timesheet row.

**Mechanism**
- Posting a payload the UI would never send requires reaching the widget's controller: `angular.element(document.querySelector('.shift-widget')).scope().c.server.get({...})` inside `page.evaluate`. This uses the real `sp_instance` options, which matters because the widget's own defaults name tables that do not exist (TC-SP-031).
- If Service Portal runs with `$compileProvider.debugInfoEnabled(false)`, `.scope()` returns `undefined`. The fallback is `POST /api/now/sp/widget/<widget id>` with `X-UserToken`, passing the `sp_instance` sys_id so the options resolve.
- Unproven on this instance. That is the only reason this case and TC-SP-016, TC-SP-018 and TC-SP-025 are pending — the assertion itself is trivial.

### TC-SP-021 — Submitting locks the month, and `u_month` is stored 1-indexed

| | |
|---|---|
| **Priority** | P1 |
| **Type** | Positive |
| **Component** | `submitMonth`, the 0/1-indexed month invariant |
| **Evidence** | UI+record |
| **Status** | PENDING |

**Expected**
- One `monthly_timesheet` row with `status = submitted` and **`u_month` = calendar month + 1**.
- The calendar goes read-only with the lock chip; every cell is disabled.

**Why it matters**
- Client, `data.month` and `input.month` are 0-indexed; the stored `u_month` is 1-indexed. This is the codebase's most-hit footgun and the only case that asserts the conversion directly.

### TC-SP-022 — Rejection reopens the month; resubmission reuses the same row

| | |
|---|---|
| **Priority** | P1 |
| **Type** | Positive |
| **Component** | `readTimesheet.locked`, `submitMonth` resubmission branch |
| **Evidence** | UI+record |
| **Status** | PENDING |

**Expected**
- A rejected month is editable again and shows the *"Sent back by …"* banner carrying the manager's words verbatim.
- Resubmitting updates the existing row and clears `approver`, `actioned_on` and `manager_comment` — one employee-month never has two rows.

### TC-SP-023 — An approved month is final and read-only

| | |
|---|---|
| **Priority** | P2 |
| **Type** | Positive |
| **Component** | Approval banner, `locked` |
| **Evidence** | UI-only |
| **Status** | PENDING |

### TC-SP-024 — The submission window opens and closes on the documented weekdays

| | |
|---|---|
| **Priority** | P2 |
| **Type** | Boundary |
| **Component** | Submission window — last weekday of month to 2nd weekday of the next |
| **Evidence** | UI-only |
| **Status** | PENDING |

### TC-SP-025 — A write to a locked month is refused server-side

| | |
|---|---|
| **Priority** | P1 |
| **Type** | Negative |
| **Component** | `handleAction` lock gate |
| **Evidence** | record-only |
| **Status** | PENDING |

**Expected**
- `saveDay` against a locked month changes nothing and raises *"This month is already submitted and locked."* — client-side disabling is convenience; this is the control.

## Aggregation

### TC-SP-026 — Aggregates are recomputed, never incremented

| | |
|---|---|
| **Priority** | P1 |
| **Type** | Positive |
| **Component** | `ShiftPayAggregator.recompute` |
| **Evidence** | record-only |
| **Status** | PENDING |

**Expected**
- After repeated edits to the same week, exactly one summary row exists per shift type per period — no accumulation, no orphans from a shift type that was removed and re-added.

### TC-SP-027 — A deactivated shift type re-aggregates at ₹0

| | |
|---|---|
| **Priority** | P2 |
| **Type** | Negative |
| **Component** | `ShiftPayAggregator` rate map |
| **Evidence** | UI+record |
| **Status** | PENDING |

**Expected**
- Deactivating a catalogue row that has already been logged, then triggering a recompute, must not change an amount that was already snapshotted. It does — the affected amounts drop to ₹0 and the manager queue renders `(removed shift type)` chips beside a ₹0 total.

**Note**
- CLAUDE.md records this as a known wart, preserved deliberately so the Script Include extraction stayed behaviour-neutral. It is written up as a case because it is visible to a manager approving pay, not because it is news.
- Pending because it mutates the shared catalogue and needs a recompute to undo.

---

# Manager Approval

### TC-SP-006 — The queue is exactly the manager's direct reportees

| | |
|---|---|
| **Priority** | P1 |
| **Type** | Positive |
| **Component** | `loadReportees`, `loadQueueInto`, `assertReportee` |
| **Evidence** | UI+record |
| **Status** | AUTOMATED |

The reportee list is both the queue's row set and the authorisation set every
write is checked against, so proving it is right is proving the widget's access
control is right.

**Steps**
- Open `/shiftpay?id=manager_approval`.
- Scrape the rendered rows and the stat strip.

**Expected**
- The rendered names equal `sys_user` where `manager = <me>` and `active = true` — no more, no fewer, and nobody who is not a reportee.
- A reportee with no timesheet appears as *Not submitted* rather than being dropped from the queue.
- Each row's status matches that reportee's `monthly_timesheet` row for the displayed month, and the **tab badges** reconcile against the same records.

**Verify**
- `cnit get sys_user -Query "manager=<me>^active=true" -Fields user_name,name`
- `cnit get x_1995110_shift_0_monthly_timesheet -Query "u_year=<y>^u_month=<m+1>" -Fields u_user,status`

**Note**
- This case asserts the tab badges, not the stat strip. The strip's *Awaiting action* tile is TC-SP-009's subject and is known to be wrong; asserting it here would make two cases fail for one defect.

### TC-SP-009 — The "Awaiting action" count contradicts the queue beneath it

| | |
|---|---|
| **Priority** | P2 |
| **Type** | Negative |
| **Component** | `.shift-mgr__stat--lead` binding in `widget.template.html` |
| **Evidence** | UI+record |
| **Status** | AUTOMATED — expected to FAIL |
| **⚠** | INTRODUCED DEFECT — deliberately present, see below |

**Steps**
- Open the manager queue on a month where the reportees' statuses differ.
- Read the *Awaiting action* stat tile, the *Awaiting me* tab badge, and the rows.

**Expected**
- *Awaiting action* equals the number of reportees whose timesheet status is `submitted` for the displayed month — the same number the *Awaiting me* tab badge shows.

**Actual**
- The tile shows the count of **all** reportees. On a month with three reportees and one submitted timesheet it reads **3** while the tab badge immediately above reads **1** and the table below shows one actionable row. One screenshot carries the whole finding: two parts of the same screen disagreeing, with the record settling which is right.

**⚠ Provenance**
- This defect was **introduced deliberately**, and is committed to the repository and deployed to the instance, so that the pack demonstrates a failing manager-side case. The manager widget is otherwise correct: `selectedIds()` scopes to the visible rows, `toggleAll` and `allSelected` follow it, `actionOne` re-checks authorisation and state per row, and `fail()` sets `data.actionError` *and* raises the message — which is exactly what the calendar gets wrong in TC-SP-004.
- It is **cosmetic by construction**. `data.counts` is display-only: nothing in `handleAction`, `actionOne`, `actionMany` or `correctDay` reads it, so the worst case is a wrong number on a tile. A more dramatic candidate — scoping `selectedIds()` to `c.data.rows` so bulk actions sweep in rows hidden by the filter — was rejected precisely because leaving it in place would let a manager approve someone they cannot see.
- The template line carries a comment naming this case. **Do not "fix" it without updating this case**, or the pack goes green for no visible reason.

**Fix**
- Bind the tile to `c.data.counts.submitted`. One word.

### TC-SP-007 — The review drill-in agrees with the records it summarises

| | |
|---|---|
| **Priority** | P1 |
| **Type** | Positive |
| **Component** | `readDetail`, `readSummaries`, the weekly split |
| **Evidence** | UI+record |
| **Status** | AUTOMATED |

A manager approves a number. This case proves it is the same number payroll
holds — the snapshot, not today's catalogue rate.

**Steps**
- Open the queue and press **Review** on a reportee with a submitted month.
- Read the day grid, the ledger and the weekly rows.

**Expected**
- Every populated day cell matches a `u_shift_submission` row for that user and month, day for day and shift for shift.
- Each ledger line satisfies `u_count × u_rate_snapshot = u_amount`, read from the summary table rather than recomputed from the live catalogue.
- The weekly rows sum to the monthly total, so the split and the headline cannot disagree.

**Verify**
- `cnit get x_1995110_shift_0_u_shift_submission -Query "u_user=<them>^u_date>=<first>^u_date<=<last>"`
- `cnit get x_1995110_shift_0_shift_submission_summary -Query "u_user=<them>^u_year=<y>^u_month=<m+1>"`

**Why it matters**
- `u_rate_snapshot` and `u_amount` are frozen when the month is aggregated, so a catalogue rate change afterwards cannot silently move what the manager is approving. Asserting against the live rate would hide it if that ever broke.

### TC-SP-008 — Tabs and search filter the queue correctly

| | |
|---|---|
| **Priority** | P2 |
| **Type** | Positive |
| **Component** | `c.recalc`, `c.setFilter`, the search box |
| **Evidence** | UI+record |
| **Status** | AUTOMATED |

**Steps**
- Cycle *Awaiting me → Approved → Rejected → Not submitted → All*, reading the rows on each.
- Type a reportee's name into the search box.

**Expected**
- Each tab shows exactly the reportees whose timesheet status matches it; *Not submitted* shows those with no row at all; *All* shows every reportee.
- Search narrows the visible rows to those whose name or employee id contains the needle.
- Tab badges are month-level and do not move when the search box filters the view.

**Note**
- `c.recalc()` runs off `ng-change`, one digest after the keystroke, so the row set must be allowed to settle before it is read.

### TC-SP-028 — Approving a timesheet is recorded with approver and timestamp

| | |
|---|---|
| **Priority** | P1 |
| **Type** | Positive |
| **Component** | `actionOne` |
| **Evidence** | UI+record |
| **Status** | PENDING |

**Expected**
- `status = approved`, `approver` = the manager, `actioned_on` set; the row leaves *Awaiting me* and the employee's month reads *Approved — locked*.

### TC-SP-029 — Rejection demands a reason

| | |
|---|---|
| **Priority** | P1 |
| **Type** | Negative |
| **Component** | `handleAction` reject branch |
| **Evidence** | UI+record |
| **Status** | PENDING |

**Expected**
- The dialog refuses an empty reason, and so does the server when sent one directly: *"A reason is required to reject a timesheet."*
- On success the reason is stored verbatim in `manager_comment` and shown to the employee.

### TC-SP-032 — Bulk approve applies every per-row guard

| | |
|---|---|
| **Priority** | P1 |
| **Type** | Negative |
| **Component** | `actionMany` looping `actionOne` |
| **Evidence** | UI+record |
| **Status** | PENDING |

**Expected**
- A row that moved since the screen was drawn is skipped, not forced, and the distinct refusals are collected into one summary rather than one growl per row.

### TC-SP-033 — Bulk selection cannot sweep in a row hidden by the filter

| | |
|---|---|
| **Priority** | P1 |
| **Type** | Negative |
| **Component** | `c.selectedIds` deriving from `c.visible` |
| **Evidence** | UI-only |
| **Status** | PENDING |

**Expected**
- Selecting several rows and then narrowing the view leaves only the still-visible selections in the bulk count and in the payload sent to the server.

### TC-SP-034 — A day correction is gated, audited and re-aggregated

| | |
|---|---|
| **Priority** | P1 |
| **Type** | Positive |
| **Component** | `correctDay` |
| **Evidence** | UI+record |
| **Status** | PENDING |

**Expected**
- Only a `submitted` month is correctable; a reason is mandatory; the date must be inside the displayed month; the new shift must pass `isAllowedOn` **for that reportee**.
- One `shift_day_change` row is written with previous and new shift, reason, and who changed it; the employee's `u_comment` is left alone; the reportee's aggregates are recomputed.

### TC-SP-035 — `show_pay_amounts = false` strips money from `data`

| | |
|---|---|
| **Priority** | P1 |
| **Type** | Negative |
| **Component** | `SHOW_PAY` projection |
| **Evidence** | UI+record |
| **Status** | PENDING |

**Expected**
- With the option off, no amount, rate or currency appears anywhere in the server response — not merely hidden by the template. Inspecting `c.data` in the browser finds nothing.

**Why it matters**
- Hiding money in a template is not access control. This is the case that proves the widget knows the difference.

### TC-SP-036 — The History tab is scoped by approver, not by team

| | |
|---|---|
| **Priority** | P2 |
| **Type** | Positive |
| **Component** | `readHistory` |
| **Evidence** | UI+record |
| **Status** | PENDING |

**Expected**
- Only decisions where `approver = me`, across every month, read-only, with the month picker and stat strip hidden.

**Known limitation**
- It shows only decisions that **still stand**. `submitMonth` clears `approver`, `actioned_on` and `manager_comment` on resubmission, so a rejection the employee has since fixed disappears from the log. That is the accepted cost of keeping approval state on the timesheet row.

### TC-SP-037 — A non-reportee timesheet cannot be actioned

| | |
|---|---|
| **Priority** | P1 |
| **Type** | Negative |
| **Component** | `assertReportee`, `nonReporteeRefusal` |
| **Evidence** | record-only |
| **Status** | PENDING |

**Expected**
- A hand-made payload naming somebody else's sys_id is refused with *"You can only action timesheets for your own direct reportees."*, the attempt is logged, and the refusal does not reveal whether that user exists.

**Why it matters**
- `c.server.get({...})` is callable from the browser with any payload. This is the widget's real access control, and a POC's missing ACLs make it the only one.

### TC-SP-038 — An account with no reportees sees the empty state

| | |
|---|---|
| **Priority** | P2 |
| **Type** | Positive |
| **Component** | `data.canManage` |
| **Evidence** | UI-only |
| **Status** | PENDING |

**Note**
- Needs a second login. The automated pack runs as one account that both owns a calendar and manages three people, so it can never reach this state.

---

# Configuration and data model

### TC-SP-030 — Holiday awareness is advertised but never configured

| | |
|---|---|
| **Priority** | P1 |
| **Type** | Negative |
| **Component** | `ShiftPayCalendarRules.holidays`, system property `x_shiftpay.holiday_schedule` |
| **Evidence** | record-only |
| **Status** | PENDING — expected to FAIL |

**Expected**
- `x_shiftpay.holiday_schedule` names a `cmn_schedule`; that schedule yields at least one `cmn_schedule_span`; a weekday falling on a declared holiday offers the weekend/holiday shift set.

**Actual**
- The property does not exist. **No `x_shiftpay.*` property exists at all.** `holidays()` returns an empty set, `isHoliday()` is false for every date in the year, and the entire weekend/holiday branch runs on day-of-week alone.
- Nothing warns: `configError()` validates the catalogue but never checks that the holiday schedule resolves, so the banner stays silent while a headline feature is inert.

**Why it matters**
- README lists "🏖️ Holiday Awareness — automatically adjusts available shift types on holidays/weekends" as a feature. It has never executed. Every holiday claim in the BRD is currently unexercised, including the entire premise of the CO entitlement — a compensatory off is earned by working *a holiday*, and the app cannot tell what one is.

**Fix**
- Create `x_shiftpay.holiday_schedule` pointing at a `cmn_schedule`. Three usable ones already exist on the instance: `U.S. Holidays`, `Non-US Holidays`, `8-5 weekdays excluding holidays`. Then add a holiday-schedule check to `configError()` so the next unconfigured deployment says so.

**Note**
- Pending rather than automated only because it produces no screenshot — the brief for the automated set was UI-visible failures. The finding is verified and stands on its own.

### TC-SP-031 — The calendar widget's default table names name no table

| | |
|---|---|
| **Priority** | P2 |
| **Type** | Negative |
| **Component** | `option-schema.json` and the `options.x \|\| 'default'` fallbacks in the calendar server script |
| **Evidence** | record-only |
| **Status** | PENDING — expected to FAIL |

**Expected**
- Every table named by a widget option default exists in `sys_db_object`.

**Actual**
- **0 of 5 exist.** `u_shift_submission`, `u_shift_submission_lock`, `u_shift_type_catalog`, `u_shift_submission_summary` and `u_shift_co_entitlement` are not tables. The widget runs only because the `sp_instance` `widget_parameters` override all five with the real `x_1995110_shift_0_*` names.

**Why it matters**
- Latent, not live. Delete one instance option — or place the widget on a new page without configuring it — and the calendar fails with a table-not-found rather than a legible error.

**Fix**
- Ship the fully-qualified names as the defaults, as the Manager Approval server script already does. Its header comment even documents the discrepancy; the calendar's does not.

### TC-SP-039 — Every semantic catalogue column is populated

| | |
|---|---|
| **Priority** | P2 |
| **Type** | Positive |
| **Component** | `oc_role`, `allow_weekday`, `allow_weekend_holiday`, `day_category`, `color_hex` |
| **Evidence** | record-only |
| **Status** | PENDING |

### TC-SP-040 — Exactly one shift type carries `consumes_co`

| | |
|---|---|
| **Priority** | P2 |
| **Type** | Boundary |
| **Component** | `_deriveSemantics` |
| **Evidence** | record-only |
| **Status** | PENDING |

**Why it matters**
- `_deriveSemantics` keeps the **last** `consumes_co` row it sees, ordered by name. A second one would silently change which shift the CO rules apply to, with no error anywhere.

---

## Pending, and why

31 of the 40 cases are written but not executed. None is blocked on tooling:

| Reason | Cases |
|---|---|
| **Needs the direct-payload mechanism** (see the note on TC-SP-020) | TC-SP-016, 018, 020, 025, 029, 035, 037 |
| **Mutates the shared catalogue**, which every other case reads | TC-SP-010, 011, 012, 027, 039, 040 |
| **Writes approval state** that the demo data depends on | TC-SP-022, 023, 028, 032, 034, 036 |
| **Needs a second login** | TC-SP-038 |
| **Straightforward, simply not yet written** | TC-SP-013, 014, 015, 017, 019, 021, 024, 026, 033 |
| **Real finding, no screenshot** — verified, kept out of the automated set because the brief was UI-visible failures | TC-SP-030, 031 |

The nine automated cases were chosen to be read-only or self-reversing, so a
demo run cannot disturb anything. Every write goes to the signed-in account's own
calendar and is undone in the same case.
