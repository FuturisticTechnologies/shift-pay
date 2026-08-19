# Setup

Machine setup and demo guide for this repo, from a fresh Windows box. Written to
be executed top-to-bottom by a person or an AI agent.

Credentials are **not** here — they are in `connection.txt` at this same root.
If `connection.txt` is missing, stop and ask whoever sent you the ZIP for it.

## What the ZIP already contains

This folder was zipped from a working machine, so it carries files that are
gitignored and would be absent from a `git clone`. **Do not recreate them.**

| Already here | Meaning |
|---|---|
| `connection.txt` | Instance URL and login, filled in |
| `testing/automation/.env` | `SN_USER` / `SN_PASSWORD`, already set |
| `testing/automation/node_modules/` | npm dependencies, ~18 MB, intact |
| `Power BI/ShiftPay.pbix` | The report with its data cached inside |

What does **not** travel in the ZIP is anything installed outside this folder:
Node.js, Python, Power BI Desktop, and Playwright's browser binaries — those
live in a user-level cache at `%LOCALAPPDATA%\ms-playwright`, not in
`node_modules`. That distinction is the whole of the install work below.

---

## First: decide which track you need

The three tracks are independent. Install only what your track needs.

| I want to… | Track | Install needed | Time |
|---|---|---|---|
| Demo the ShiftPay app — calendar and manager approvals | **A** | none, just a browser | 0 min |
| Demo the Power BI report | **B** | Power BI Desktop | 10 min |
| Run the automated test pack and produce Word evidence | **C** | Node, Python, Playwright browser | 20 min |

**Track A is the main demo.** B and C are supporting demos and neither is
required for A.

### What this repo does NOT need

Do not go looking for these — their absence is not a problem to fix:

- No build step, bundler, or package manager at the repo root. The widget files
  under `*/UI Widget/` are source exports that get pasted or pushed into a
  ServiceNow instance; they are not compiled. **Nothing in this repo has to be
  built or deployed to run the demo** — the app is already live on the instance.
- No lint config, no test runner at the root. `testing/` is the only runnable
  part of the repo.
- No global npm installs. Everything track C needs is local to
  `testing/automation/`.

---

## Track A — demo the ShiftPay app

Nothing to install. The app is already deployed and running on the instance;
these are just URLs. Sign in with the username and password from
`connection.txt`.

**Start at the landing page and navigate from there.** Deep-linking to an inner
page works, but the front door is part of the product — open it first and click
through.

```
https://dev307042.service-now.com/shiftpay
```

That is the `shiftpay_home` page. It greets the signed-in user by first name and
shows cards through to the calendar and to manager approvals. Four portal pages
exist in total:

| Page | Page ID | Card on the landing page |
|---|---|---|
| Home | `shiftpay_home` | — it *is* the landing page |
| Employee calendar | `fill_shift` | yes |
| Manager approvals | `manager_approval` | yes |
| Reports | `shift_reports` | yes |

Any of them can also be opened directly as
`https://dev307042.service-now.com/shiftpay?id=<page id>`.

> **Read "Known defects to demo around" at the end of this track before
> presenting.** Three are deliberate or known, and one of them will make the
> manager screen show a number that looks wrong. Being surprised by it live is
> avoidable.

### A1 — the employee calendar

The story: shift rules are **data-driven**, not hard-coded, and pay is computed
as you go.

1. **From the landing page, click the calendar card.** A month grid, a legend of
   shift types, and weekly and monthly totals down the side.
2. **Click a weekday.** The dropdown offers only weekday-legal shifts — UK, US,
   Leave. This list came from the server, per date.
3. **Pick UK.** The chip appears in its catalogue colour, and the weekly total
   and pay amount update immediately without a page reload.
4. **Click a Saturday.** The dropdown is now a different set — the on-call
   family. Nothing in the code branches on the name "Saturday" or "OC"; the
   catalogue rows carry `allow_weekday` / `allow_weekend_holiday` columns and
   the server composes the allowed list from them. Renaming a shift type changes
   nothing.
5. **Pick a compound on-call shift** (one of the `OC+…+CO` types). This silently
   creates a compensatory-off entitlement with a window of seven *weekdays*.
6. **Click a weekday inside that window.** `CO` is now offered — it was not
   before step 5. That is the entitlement being honoured.
7. **Pick CO.** It consumes the entitlement.

The point to land in step 4–7: the calendar is not a form with a list of
options. It is a rules engine reading a catalogue.

> **Do not demo "Submit month".** `submitMonth` refuses unless *every weekday in
> the month is logged* — it counts unlogged weekdays and rejects with "Cannot
> submit: N weekday(s) still unlogged". No month on the `admin` calendar is
> complete, so the click would be refused.
>
> That refusal is also **invisible**: it goes through `gs.addErrorMessage()`,
> which is the TC-SP-004 defect, so the screen can repaint as though the submit
> landed. A step that appears to succeed while doing nothing is the one failure
> mode worth engineering out of a demo.
>
> The submitted state is shown from the manager side instead, in A2, where July
> holds six real submissions. Same point, no risk. If you later want the employee
> submit flow on screen, it needs a fully-logged month seeded for `admin` first.

### A2 — manager approvals

The story: the manager works a real queue, and every rule is enforced
server-side.

1. **Back to the landing page, then the manager card.** Per-month tabs, and a
   queue containing exactly the signed-in manager's direct reportees — nobody
   else's team can appear. It opens on the **All** tab, so every reportee is
   visible at once; **Awaiting me** narrows it to the ones needing a decision.
   Move to **July 2026** — that is the month with the fullest data.
2. **Drill into a submission.** The review panel shows that person's days and
   the cost per shift type.
3. **Correct a single day.** A reason is mandatory and enforced on the server.
   The correction writes an audit row and re-runs the same entitlement logic the
   employee's calendar uses. Corrections are only possible while the month is
   `submitted` — approved is final, rejected is back with the employee.
4. **Reject one with a comment.** Rejection *reopens* the month so the employee
   can fix and resubmit; it does not create a second record.
5. **Approve another**, then **select several and bulk approve**. The bulk path
   loops the single-row action, so every authorisation check still runs per row.
6. **Open the History tab.** The manager's own past decisions, across every
   month. Scoped to decisions *they* made, so it cannot show anyone else's.

> **These are real writes and they do not reverse themselves.** Unlike the test
> pack, approving or rejecting in a demo changes live records. Decide beforehand
> which reportee-month you will act on, and be willing to leave it in that state.

### A3 — the reports page

```
https://dev307042.service-now.com/shiftpay?id=shift_reports
```

In-portal reporting, rendered by `shiftpay-reporting-ui`, reachable from the
reports card on the landing page. Source lives in `Reports UI Widget/`.

Six tabs — **Cost & volume**, **Shift mix**, **Team**, **Activity**,
**Timeliness** and **CO health** — sitting under a scope selector with three
settings: *My data*, *My team* and *Organisation*.

**It opens on Organisation**, which is the fullest view and the one to demo. The
scope is resolved server-side against what the signed-in user is actually
entitled to: the organisation setting requires the `x_1995110_shift_0.admin`
role, and anyone without it silently lands on their own data instead. The
selector is a convenience, not the control — worth saying out loud if anyone asks
how a reporting screen over everyone's pay is safe.

No test case covers this widget yet.

Where this leaves the reporting story: the in-portal page is the one you can
show inside ShiftPay, and the Power BI report in track B is the one whose
contents are documented and reproducible. They are separate things and it is
worth being clear which you are showing.

### Known defects to demo around

Three are known and two of those are real bugs, kept visible on purpose because
the test pack in track C exists to evidence them. Read before presenting.

| What you'll see | Why |
|---|---|
| Manager "Awaiting action" tile shows a count that disagrees with the queue | **Deliberate demo defect.** The tile is bound to the total row count instead of the submitted count. It is display-only and affects no data. This is `TC-SP-009`, and the test pack is built to catch it. |
| A blocked action appears to succeed on the calendar | **Real bug (`TC-SP-004`).** Every server-side refusal in the calendar is invisible, *and* the screen repaints as though the write landed. The stored record is correct — only the display lies. Reload the page and the true state returns. |
| A Saturday dropdown offers `L` and `Not Eligible` | **Real bug (`TC-SP-005`)**, a data problem: those two catalogue rows carry `allow_weekend_holiday = true` against the documented rules. Harmless today because both rates are ₹0. |

**Do not demo holiday behaviour.** No holiday schedule is configured on this
instance, so no date is ever classified as a holiday and the entire holiday
branch is inert. Weekend detection works fine; holidays are untested ground.

If you want the safest possible calendar demo, stay on steps A1 1–7 and avoid
deliberately triggering a refusal — that is the one place the screen can mislead
you live.

---

## Track B — Power BI report

**Dependency: Power BI Desktop.** Free, permanent, no account, Windows only.

1. Install **Power BI Desktop** from the Microsoft Store. Use the Store build,
   not the standalone installer — the Store one self-updates, and a `.pbix`
   saved by a newer Desktop will not open in an older one.
2. Launch it and **dismiss the sign-in prompt**. It nags on most launches.
   Nothing here needs an account.
3. Open `Power BI/ShiftPay.pbix`.

That is the whole of track B. The report opens with its data already in it —
Power BI import mode caches query results inside the `.pbix` — so no instance
connection is involved.

> **Do not press Refresh.** Refresh re-queries the live ServiceNow instance;
> without credentials configured it prompts, fails, and leaves the report empty
> until you close without saving. The data you see is a snapshot from the last
> refresh before the ZIP was made.

Open on the **calendar grid** page — the cell colours are driven by the same
`color_hex` column the widget uses, so it visibly matches the app.

To rebuild or refresh the model for real, follow `Power BI/README.md` — that
needs the instance URL and login from `connection.txt`.

---

## Track C — the automated test pack

Drives the deployed widgets in a real browser and produces a branded Word
evidence document per case.

### Dependencies

| Need | Minimum | Check with | Where to get it |
|---|---|---|---|
| Node.js | 20 LTS | `node --version` | nodejs.org, or `winget install OpenJS.NodeJS.LTS` |
| npm | ships with Node | `npm --version` | — |
| Python | 3.10 | `python --version` | python.org, or `winget install Python.Python.3.12` |
| python-docx | any | `python -c "import docx; print('ok')"` | `pip install python-docx` |
| PowerShell | 5.1 | built into Windows | — |
| Chromium | — | installed below | Playwright installs its own |

When installing Python from python.org, **tick "Add python.exe to PATH"** on the
first installer screen. The test runner probes for an interpreter by name, so a
Python that is not on PATH is a Python it cannot find.

### Install

Two dependencies are machine-level and have to be installed even though the
project files are all present: Python with `python-docx`, and Playwright's
browser binaries.

```powershell
pip install python-docx
cd testing/automation
npx playwright install chromium
```

`npx playwright install chromium` is **not** redundant with the `node_modules/`
in the ZIP. The npm package is the test framework; the actual Chromium build it
drives is downloaded separately into `%LOCALAPPDATA%\ms-playwright`, which is
outside this folder and therefore was not zipped. It does not touch any Chrome
or Edge you already have.

`npm install` is **not** required — `node_modules/` came with the ZIP. Run it
only if Node reports a missing module, which would mean the copy is damaged.

### Credentials — already done

`testing/automation/.env` is in the ZIP with `SN_USER` and `SN_PASSWORD`
filled in. There is nothing to copy or create. Open it only to confirm both
values are non-empty; an empty `.env` surfaces as a sign-in failure rather than
a clear "no credentials" message.

The sign-in session is cached to `testing/automation/.auth/` and reused for 8
hours, after which the runner signs in again on its own. If sign-in behaves
strangely on the first run, delete the `.auth/` folder — it may hold a session
cached on the machine that made the ZIP.

### Verify

```powershell
node --version                              # v20 or newer
python -c "import docx; print('ok')"        # ok
```

If `node --version` fails, install Node — `node_modules/` shipping in the ZIP
does not mean Node itself is on the machine.

Both must succeed **under the same names the runner probes**. It tries
`python`, then `py`, then `python3`, running `import docx` under each, and uses
the first that works. If you installed `python-docx` inside a virtualenv that is
not active, every probe fails and the run dies with "Python with python-docx is
not available" even though the package is on the machine somewhere.

### Run

From the repo root:

```powershell
.\testing\run-case.ps1 TC-SP-003              # one case
.\testing\run-case.ps1 TC-SP-004 TC-SP-005    # several
.\testing\run-case.ps1 all                    # all 9, plus a run summary
.\testing\run-case.ps1 TC-SP-003 -Headless    # no visible browser
.\testing\run-case.ps1 TC-SP-003 -NoOpen      # build the doc, don't open it
```

Outside PowerShell:

```bash
cd testing/automation
node run-case.mjs TC-SP-003
```

Nine cases are automated, `TC-SP-001` through `TC-SP-009`. Watching a case drive
the real widget in a visible browser is the demo; the Word document is the
deliverable.

### Read this before reacting to a red result

**Three of the nine cases are expected to FAIL. A green run is the broken one.**
They are the same three described in track A — `TC-SP-004`, `TC-SP-005` and
`TC-SP-009`.

A non-zero Playwright exit is therefore a **normal** outcome, and the runner
carries on by design. Do not "fix" a red case before reading
`testing/README.md` — `TC-SP-009` in particular exists so the pack can
demonstrate a failing case, and fixing it silently makes the demo pointless.

Nothing in the pack approves, rejects or corrects a timesheet. Every write goes
to the signed-in account's own calendar two months ahead and reverses itself, so
a full run cannot disturb the demo data.

---

## If everything suddenly fails

A ServiceNow Personal Developer Instance hibernates after about ten days idle.
Every screen, every test and every Power BI refresh then returns a connection
error. Wake it at developer.servicenow.com → your instance → **Wake**, then
retry.

This is the single most likely cause of a working setup appearing to break, and
it looks exactly like a broken repo. Check it before debugging anything else.
**Wake the instance the day before a demo, not an hour before** — a cold start
can take several minutes.

---

## Where to read next

| File | What it covers |
|---|---|
| `README.md` | Data model, roles, business rules |
| `BRD-ShiftPay.md` | Business requirements |
| `CLAUDE.md` | Architecture, conventions, and the traps worth not rediscovering |
| `testing/README.md` | The test pack in depth, and why three cases are red |
| `testing/TEST-CASES-SHIFTPAY.md` | All 40 case definitions — the source of truth |
| `Power BI/README.md` | Rebuilding the Power BI model from scratch |
| `connection.txt` | Instance URL and login (gitignored, ZIP only) |
