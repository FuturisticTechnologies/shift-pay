# ShiftPay — test pack

Test cases, automated execution, and branded Word evidence records.
**Start here.**

| | |
|---|---|
| [TEST-CASES-SHIFTPAY.md](TEST-CASES-SHIFTPAY.md) | 40 cases — employee calendar, manager approval, configuration |
| [automation/](automation/) | Playwright harness (TypeScript) |
| [evidence-generator/](evidence-generator/) | Python + python-docx → one .docx per case |
| [evidence-packs/](evidence-packs/) | Generated Word documents (git-ignored output) |

**9 cases are automated: 6 PASS, 3 FAIL.** The three failures are correct
outcomes, not broken tests — see [Read this before "fixing" a red case](#read-this-before-fixing-a-red-case).

---

## How it fits together

```
TEST-CASES-SHIFTPAY.md        the definition — priority, component, steps, expected
        │
        ├──> automation/specs/shiftpay-cases.spec.ts   executes, records what happened
        │              │
        │              └──> automation/results/cases/TC-SP-*.json
        │
        └──> evidence-generator/            merges definition + result
                       │
                       └──> evidence-packs/TC-SP-*.docx
```

The markdown is the single source of truth for what a case *is*; the run supplies
what happened. **Nothing is retyped between them**, so a document cannot claim an
expected result the specification does not contain.

### Two proofs per case, always

Every case that asserts a state change records **what the screen showed** and
**what the record holds**. A repainted calendar cell proves the browser did
something, not that the row moved.

That is not academic here. **TC-SP-004 is a case where the two disagree** — the
screen shows a day cleared that the server refused to clear. A single-sided check
would have called it a pass.

---

## Running it

One command per case. It signs in if needed, opens a browser, runs the case, and
opens the Word document when it is done.

```powershell
.\testing\run-case.ps1 TC-SP-003              # one case
.\testing\run-case.ps1 TC-SP-004 TC-SP-005    # several
.\testing\run-case.ps1 all                    # everything, plus the run summary
.\testing\run-case.ps1 TC-SP-003 -Headless    # no visible browser
.\testing\run-case.ps1 TC-SP-003 -NoOpen      # build it, don't open it
```

Not in PowerShell:

```bash
cd testing/automation
node run-case.mjs TC-SP-003
```

### First-time setup

```powershell
cd testing/automation
npm install
npx playwright install chromium
copy .env.example .env     # then fill in SN_USER and SN_PASSWORD
```

The account needs its own calendar at `/shiftpay?id=fill_shift` and at least one
direct reportee for the manager cases. `admin` satisfies both on `dev227442`: six
direct reportees, and its own calendar, which starts empty because the seeder
does not seed the manager. The writing cases make their own data, so that is the
expected starting state.
`.env` is gitignored and must never be committed.

The session is saved to `.auth/` and reused for 8 hours; after that the runner
signs in again on its own.

---

## Read this before "fixing" a red case

Three of the nine automated cases are **expected to fail**. A green run is the
broken one.

| Case | Verdict | Why |
|---|---|---|
| TC-SP-004 | **FAIL (real)** | A refused write is painted on screen as though it succeeded |
| TC-SP-005 | **FAIL (real)** | The weekend dropdown offers two shifts the documented rules forbid |
| TC-SP-009 | **FAIL (introduced)** | The "Awaiting action" count contradicts the queue — a deliberate demo defect |

That table is duplicated in machine-readable form in
`automation/lib/expected-outcomes.ts`, so a run can be checked against it
without anyone having to remember the prose. `compareRun()` reports deviations
in **both** directions: a case that was expected to fail and passed is the more
interesting one, because it means either a defect was fixed without the spec
being updated, or an assertion has quietly stopped asserting. A case that did
not run at all counts as a deviation too — a missing case is not a passing case.
Fixing a defect means changing its entry there and in
`TEST-CASES-SHIFTPAY.md` in the same commit.

**TC-SP-004** is the serious one. `c.saveCell`, `c.clearCell` and `c.bulkApply`
all branch on `r.data.error`; the calendar server script never sets it — all six
refusal paths call `gs.addErrorMessage()` instead. So every server-side refusal
in the calendar is invisible, *and* the client takes its success branch and
repaints the day as though the write landed. The record is correct throughout;
only the screen lies. The Manager Approval widget already does this properly —
its `fail()` sets `data.actionError` **and** raises the message.

**TC-SP-005** is a data problem, not a code one: the `L` and `Not Eligible`
catalogue rows carry `allow_weekend_holiday = true`, so both appear in a
Saturday's dropdown against README §Business Rules. Untick the two columns and it
goes green. Harmless today only because both rates are ₹0.

**TC-SP-009 is a deliberately introduced defect**, committed and deployed on
purpose so the pack demonstrates a failing manager-side case. The manager widget
is otherwise sound. The tile is bound to `c.data.counts.all` instead of
`c.data.counts.submitted`; the line in `Manager Approval UI Widget/widget.template.html`
carries a comment saying so. It is cosmetic by construction — `data.counts` is
display-only and no write path reads it. **If you fix it, update
TEST-CASES-SHIFTPAY.md too**, or the pack goes green for no visible reason.

Two further real findings are recorded but not automated, because neither
produces a screenshot: **TC-SP-030** (no holiday schedule is configured, so no
date is ever a holiday and the whole holiday branch is inert) and **TC-SP-031**
(the calendar widget's five default table names name no table).

---

## What the automated cases cover

| Case | Surface | Writes | Verdict |
|---|---|---|---|
| TC-SP-001 | Calendar | none | PASS — allowed shifts are data-driven; CO is withheld without an entitlement |
| TC-SP-002 | Calendar | self-reversing | PASS — one row written, aggregate recomputed with a rate snapshot |
| TC-SP-003 | Calendar | self-reversing | PASS — the whole CO entitlement lifecycle, window arithmetic included |
| TC-SP-004 | Calendar | self-reversing | FAIL — a refused write is shown as success |
| TC-SP-005 | Calendar | none | FAIL — the weekend dropdown offers forbidden shifts |
| TC-SP-006 | Manager | none | PASS — the queue is exactly the direct reportees |
| TC-SP-007 | Manager | none | PASS — the drill-in agrees with the payroll records |
| TC-SP-008 | Manager | none | PASS — tabs and search filter correctly |
| TC-SP-009 | Manager | none | FAIL — the introduced defect above |

**Nothing here approves, rejects or corrects a timesheet.** Every write goes to
the signed-in account's own calendar in a month two ahead of today — unlocked,
unsubmitted, and cleaned up in the same case. A full run cannot disturb the demo
data.

---

## Harness facts worth not rediscovering

- **The Table API needs `X-UserToken`.** A session cookie alone returns 401 even
  with the browser fully logged in. The token is `window.g_ck`, captured at setup
  and cached beside the storage state; the two files are only meaningful
  together.
- **Never take a table name from the widget source.** The employee calendar's
  option defaults (`u_shift_submission`, `u_shift_type_catalog`, …) name no table
  at all — it runs only because the `sp_instance` `widget_parameters` override
  all five. `lib/servicenow.ts` holds the real names. This is TC-SP-031.
- **Angular bootstraps after DOMContentLoaded**, then fetches the month in a
  second call. Wait on `.shift-cal__grid .shift-cell` or the manager table, never
  a fixed delay.
- **Calendar cells are keyed by `cell.idx`, not by date**, and the padding cells
  carry day numbers too. `cellForDate()` matches an exact date string inside a
  cell that is not `--outside`. Never index positionally.
- **`c.recalc()` runs off `ng-change`**, one digest after the keystroke, so the
  manager row set must be allowed to settle before it is read. Asserting on the
  next tick reads the pre-filter list and passes against the wrong data.
- **A closed popover is not proof a write landed.** That is exactly what
  TC-SP-004 is about. Always confirm against the record.
- **Per-case JSON, never an accumulating manifest.** Playwright restarts its
  worker after a failed test and resets module state; with three expected
  failures, an in-memory array would lose most of the pack.
- **Record first, assert last** in the failing cases. The expectation that turns
  the run red must come after every screenshot and record dump, or the document
  arrives with a red badge and none of the evidence that justifies it.
- **Serial, one worker, zero retries.** Two cases write to a live instance and
  the entitlement lifecycle is order-dependent.
- **The runner exits 0 even when a case fails.** A failing document is the
  deliverable; conflating "a case failed" with "the tooling failed" would make
  the pack unusable. It aborts only when *no* result was produced — that means
  the case id was wrong.

## Data hazards

- **`cnit` has no delete verb.** A case that aborts mid-transaction leaves
  residue that has to be cleared through the platform UI.
- **The entitlement table holds one row at baseline** (OC 2026-06-07, consumed
  2026-06-09). Confirm it still does after running TC-SP-003 or TC-SP-004.
- **`admin` has 86 day rows** spanning 2026-04-01 to 2026-08-21. The write cases
  deliberately work two months ahead of that.
- **`shiftpay-reporting-ui` now has source** in `Reports UI Widget/`, exported
  from the instance on 18 Aug 2026. No cases cover it yet.
- **The reportee roster grew to six** on 18 Aug 2026 (`One Time Scripts/seed-demo-data.js`),
  and May–July day rows were reseeded for all of them. The manager cases derive
  their expectations at runtime from `manager=<me>^active=true`, so they absorb
  this — but any figure you remember from an earlier run is stale.
