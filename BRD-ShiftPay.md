# Business Requirements Document (BRD)

## ShiftPay — Shift Submission, Approval & Payroll Export

| | |
| --- | --- |
| Document title | ShiftPay — Business Requirements Document |
| Version | 1.0 (Draft) |
| Date | 13 June 2026 |
| Document owner | Product Owner (Business Sponsor) |
| Intended build | Net-new ServiceNow scoped application |
| Commercial intent | To be certified and listed for sale on the ServiceNow Store |
| Status | For build estimation & development |

### Revision history

| Version | Date | Author | Summary of change |
| --- | --- | --- | --- |
| 1.0 | 13 Jun 2026 | Product Owner | First complete draft of requirements for build |

---

## 1. Purpose of this document

This Business Requirements Document specifies a **new ServiceNow application, "ShiftPay,"** to be **built from scratch** by the appointed development partner. Nothing described here exists yet; every capability in this document is to be designed and delivered as part of the engagement.

The document is written for:

- The **development partner** who will design, build and unit-test the application against these requirements; and
- Our **company**, who will take the delivered application, package it as a **commercial scoped application** and publish it on the **ServiceNow Store** for sale to other ServiceNow customers.

Because the end product is a **sellable, multi-customer Store application** (not a one-off internal build), the requirements emphasise configurability, tenant-neutrality, upgrade-safety and ServiceNow Store certification readiness (see §3 and §13). The partner is expected to build to **ServiceNow ISV / Store publishing standards**, not just to make it work for a single customer.

---

## 2. Product summary

ShiftPay lets staff who rotate across different shift patterns record, on a calendar, which shift they worked on each working day of the month (for example UK shift, US shift, On-Call, Comp-Off, Leave). Each shift type carries a configurable pay rate, so the recorded calendar becomes the source data for shift-allowance calculation.

The product delivers one end-to-end process in three functional modules:

1. **Employee shift submission** — an employee fills in and submits their own monthly shift calendar.
2. **Manager review & approval** — managers review the timesheets submitted by their direct reportees and **approve or reject (with comments), individually or in bulk**.
3. **Automated payroll export** — on a configured working day of the following month, the system automatically generates a **CSV of all approved timesheets** (employee details, shift details, pay per shift type and total monthly pay) and **attaches it to a ServiceNow record (a Requested Item or an HR Case)** for the payroll / HR team.

The objective is a single, auditable, low-effort flow from "employee logs a shift" to "payroll receives an approved, costed file" each month — delivered as a configurable product any customer can install and adopt.

---

## 3. Product & commercialisation context

| Ref | Requirement |
| --- | --- |
| PC-1 | The application must be delivered as a **ServiceNow scoped application** (its own application scope, e.g. `x_<vendor>_shiftpay`), with all tables, scripts, roles and UI contained in that scope. |
| PC-2 | The application must be **tenant-neutral**: no hardcoded customer names, user names, rates, currencies, holidays or shift types. All such values are **configuration/data**, set up per customer after install. |
| PC-3 | The application must be **multi-customer configurable** — shift catalogue, rates, currencies, holiday calendar, approval routing, export timing and export target are all administrator-configurable without code changes. |
| PC-4 | The application must be built to be **ServiceNow Store certification ready** (passes ServiceNow AppCheck / Instance Scan, no `gs.log` noise, no hardcoded sys_ids, no writes outside scope, proper ACLs, no use of unsupported/private APIs). |
| PC-5 | The application must be **upgrade-safe and re-installable**: shipping new versions must not destroy customer data or configuration. |
| PC-6 | The application must ship with **roles** (at minimum: Employee/self-service user, Manager, ShiftPay Admin) and an out-of-the-box **ACL model** so visibility rules in §13 hold without per-customer scripting. |
| PC-7 | The application must ship with **seed/demo data and a guided setup** (or setup documentation) so a customer can stand it up quickly for evaluation. |
| PC-8 | The application must include **admin and end-user documentation** suitable for a Store listing, plus release notes per version. |
| PC-9 | The application should support **localisation** (UI strings translatable; currency and date formats respect the instance/user locale). |
| PC-10 | Licensing/entitlement approach (if any) must not block evaluation; any licensing enforcement must follow ServiceNow ISV guidance. |

---

## 4. Business objectives & success criteria

| Ref | Objective | Success measure |
| --- | --- | --- |
| OBJ-1 | Let employees record their shifts accurately and easily each month | ≥ 95% of working days logged before the monthly cut-off, with no spreadsheet involved |
| OBJ-2 | Give managers a fast way to review and approve/reject their team's submissions | A manager can action a full team's month from one screen, including a single bulk-approve |
| OBJ-3 | Produce a reliable, costed payroll file automatically | CSV generated and attached on the configured working day every month with zero manual collation |
| OBJ-4 | Make the whole process auditable | Every submission, approval, rejection (with comment) and export is traceable to a user and timestamp |
| OBJ-5 | Be sellable as a product | Application passes ServiceNow Store certification and can be installed and configured by a customer without vendor code changes |

---

## 5. Scope

### 5.1 In scope

- Employee monthly shift calendar (record, edit, bulk-fill, comment, submit/lock).
- Configurable shift catalogue with rates, including weekday / weekend / holiday eligibility rules and Comp-Off (CO) entitlement earned from On-Call (OC) shifts.
- Manager dashboard to view direct reportees' submitted timesheets.
- Manager **approve / reject with comments**, individually and in **bulk**.
- Rejection feedback loop back to the employee (re-open / re-submit).
- Automatic monthly CSV export of approved timesheets with pay totals.
- Automatic attachment of that CSV to a Requested Item (RITM) **or** HR Case (configurable target).
- Notifications at key transitions (submitted, approved, rejected, exported).
- Packaging as a configurable, certifiable ServiceNow Store application.

### 5.2 Out of scope (this release)

- Actual disbursement of pay / integration with a payroll or banking system (the CSV is the hand-off boundary).
- Tax, statutory or net-pay calculation — ShiftPay produces **gross shift allowance** only.
- Native mobile app (the Service Portal UI must be responsive/mobile-friendly, but no separate app).
- Historical back-loading of pre-go-live months.

---

## 6. Stakeholders & user roles

| Role | Description | Key interactions |
| --- | --- | --- |
| Employee (Reportee) | A staff member who works shifts | Fills calendar, submits month, reads approval/rejection outcome, re-submits if rejected |
| Manager | Line manager of one or more employees (direct reportees) | Reviews submitted timesheets, approves/rejects (single + bulk) with comments |
| Payroll / HR team | Receives the exported CSV | Consumes the monthly CSV attached to the RITM / HR Case |
| ShiftPay Administrator | Configures the application for the customer | Maintains shift catalogue, rates, holidays, approval routing, export schedule and target |
| System (scheduled job) | Automated actor | Generates and attaches the monthly CSV |

The direct-reportee relationship is sourced from the standard ServiceNow `sys_user.manager` field by default, and must be **configurable** so a customer can point it at a different relationship if required.

---

## 7. Module 1: Employee shift submission

### 7.1 Functional requirements — Employee

| Ref | Requirement |
| --- | --- |
| FR-E1 | The employee sees a monthly calendar and can navigate between months. |
| FR-E2 | For each in-month working day, the employee can select a shift type from the catalogue of shifts allowed for that date. |
| FR-E3 | The set of selectable shifts per date respects business rules (weekday vs weekend/holiday, and Comp-Off entitlement) — see §10. |
| FR-E4 | The employee can add an optional free-text comment to a day. |
| FR-E5 | The employee can **bulk-fill** the same shift across multiple selected dates in one action (excluding shift types that require individual validation, e.g. CO and compound-OC). |
| FR-E6 | The employee can clear a day's entry. |
| FR-E7 | The UI shows progress ("X of Y working days logged") and only enables **Submit month** when all working days are logged. |
| FR-E8 | On **Submit month**, the month is **locked**: all further edits are blocked except the actions defined by the approval flow (§8). |
| FR-E9 | The employee can view a read-only summary of the previous month. |
| FR-E10 | All data is scoped to the logged-in user; an employee can only ever see and edit their own submissions. |
| FR-E11 | The calendar UI must be **responsive / mobile-friendly** and accessible (keyboard navigation, Esc to dismiss pop-ups). |

---

## 8. Module 2: Manager review & approval

### 8.1 Overview

Managers need a single screen to see what their direct reportees submitted for a given month and to action it. Approval can be done **per employee/timesheet** or in **bulk across the team**, and **rejection must carry a comment** so the employee knows what to fix.

### 8.2 Functional requirements — Manager

| Ref | Requirement |
| --- | --- |
| FR-M1 | A manager can open a **team dashboard** listing their direct reportees and each reportee's timesheet status for a selected month (Not started / In progress / Submitted / Approved / Rejected). |
| FR-M2 | The dashboard shows, per reportee, summary information: working days logged, shift-type breakdown (counts), and computed total for the month. |
| FR-M3 | The manager can drill into an individual reportee's month to see day-by-day detail and any employee comments before deciding. |
| FR-M4 | The manager can **Approve** a single submitted timesheet. |
| FR-M5 | The manager can **Reject** a single submitted timesheet, and a **comment/reason is mandatory** on rejection. |
| FR-M6 | The manager can **bulk Approve** multiple (or all) submitted timesheets in one action. |
| FR-M7 | The manager can **bulk Reject** multiple timesheets; a comment is captured for the bulk action and applied to each rejected timesheet. |
| FR-M8 | Only timesheets in **Submitted** status are eligible for approve/reject; the UI prevents actioning timesheets in other statuses. |
| FR-M9 | A manager can only see and action the timesheets of **their own direct reportees**. |
| FR-M10 | Approval and rejection are recorded with the actioning manager's identity, timestamp, and comment for audit. |
| FR-M11 | On **rejection**, the affected month is **re-opened** to the employee for editing and re-submission (the lock from FR-E8 is lifted for that employee/month). |
| FR-M12 | On **approval**, the timesheet is marked Approved and becomes **read-only** to both employee and manager (changes thereafter only via an admin exception path). |
| FR-M13 | The dashboard must let the manager filter/sort at minimum by status and by reportee, and clearly flag timesheets still awaiting action. |
| FR-M14 | Whether managers can see **monetary pay values** (vs. only shift counts/types) must be a **configurable** setting, so a customer can choose to keep pay confidential from line managers. |
| FR-M15 | Approval authority must support **delegation/cover** using ServiceNow's standard delegation, so an absent manager's reportees can still be actioned. |

### 8.3 Business rules — Manager

| Ref | Rule |
| --- | --- |
| BR-M1 | A timesheet can only move **Submitted → Approved** or **Submitted → Rejected**. |
| BR-M2 | **Rejected** timesheets return to the employee as editable and must be re-submitted to be re-actioned. |
| BR-M3 | Only **Approved** timesheets are eligible for the payroll export (§9). |
| BR-M4 | Rejection without a comment is not permitted. |
| BR-M5 | Re-submission after rejection restarts the approval step (the manager must act again). |
| BR-M6 | Approval is at **whole-month timesheet** granularity (a manager approves or rejects an employee's month, not individual days). |

---

## 9. Module 3: Automated payroll CSV export

### 9.1 Overview

After the approval window closes, the export runs **hands-off**. On a configured working day of the **following** month, the system gathers all approved timesheets, produces a single CSV that payroll can consume, and attaches it to a ServiceNow record so it is tracked and routed like any other request.

### 9.2 Functional requirements — Export

| Ref | Requirement |
| --- | --- |
| FR-X1 | A **scheduled job** runs automatically on a **configurable working day of the following month** (default: the 3rd working day) to export the prior month's approved timesheets. The "working day" definition respects the configured holiday calendar. |
| FR-X2 | The export includes **only timesheets in Approved status** for the target month. Submitted-but-unapproved and rejected timesheets are excluded. |
| FR-X3 | The export produces a **CSV file** containing at minimum the columns in §9.4. |
| FR-X4 | The CSV is **attached to a ServiceNow record** — a Requested Item (RITM) **or** an HR Case — with the target type, catalog item / case type, and assignment **configurable** by the administrator. |
| FR-X5 | The export is **idempotent / safe to re-run**: re-running for the same month does not create duplicate pay lines; it regenerates/replaces rather than double-counts. |
| FR-X6 | Each export run is **logged and auditable** (target month, number of timesheets, total value, the record it was attached to, and success/failure). |
| FR-X7 | On failure or exception (e.g. no target record could be created, or zero approved timesheets), the system raises a **notification/alert to the administrator** rather than failing silently. |
| FR-X8 | Timesheets **not approved** by the export date are **excluded and listed** in the run log and administrator notification, so payroll knows what was left out. |
| FR-X9 | Export timing, target and format settings must be **configurable per customer** without code changes. |

### 9.3 Pay calculation rules

| Ref | Rule |
| --- | --- |
| BR-X1 | **Pay per shift type** = (number of days of that shift type in the month) × (the rate for that shift type). |
| BR-X2 | The **rate** comes from the shift catalogue (rate + currency per shift type). Rates are **snapshotted** at aggregation time so later rate changes never retroactively alter past months. |
| BR-X3 | **Total monthly pay** for an employee = the sum of pay across all shift types for that month. |
| BR-X4 | Only **approved** timesheets contribute to the totals in the export. |
| BR-X5 | ShiftPay produces **gross shift allowance** only — no tax/statutory/net calculation. |
| BR-X6 | Currency is taken from the catalogue (configurable per customer); the CSV states the currency. |

### 9.4 CSV content (minimum columns)

| Column | Description |
| --- | --- |
| Employee name | Reportee's display name |
| Employee ID | Employee number / user identifier |
| Manager | Approving manager's name |
| Period | Year + month being paid |
| Shift type | Catalogue shift name (e.g. UK, US, OC + CO) |
| Days worked | Count of days of this shift type in the month |
| Rate | Per-day rate for the shift type (snapshot) |
| Currency | e.g. INR |
| Shift subtotal | Days × Rate for this shift type |
| Total monthly pay | Sum across all shift types for the employee |
| Approval date | When the timesheet was approved |

The file layout is **one row per employee × shift type**, with a clearly identifiable **total monthly pay** value per employee. Exact header labels, delimiter and encoding (UTF-8 recommended) are a design detail to be confirmed with the customer's payroll team during configuration, and must be adjustable without code changes where practical.

### 9.5 Business rules — Export timing & packaging

| Ref | Rule |
| --- | --- |
| BR-X7 | The export targets the **previous calendar month's** approved data and runs in the **current** month. |
| BR-X8 | The trigger day is a **configurable working day** (default: Nth working day of the month), skipping weekends and holidays per the holiday calendar. |
| BR-X9 | One export run produces **one consolidated CSV** covering all in-scope employees, attached to one target record per run. The product should also support **optional splits** (e.g. per manager or per cost centre) as a configurable option. |

---

## 10. Cross-cutting business rules — shift catalogue, eligibility & entitlement

| Ref | Rule |
| --- | --- |
| BR-C1 | Shift types are defined centrally in a **configurable shift catalogue** (name, description, rate, currency, effective date, colour, active flag). The catalogue is the single source of truth for shift types and rates. |
| BR-C2 | Which shifts are **selectable for a given date** depends on whether the date is a **weekday, weekend, or holiday**, and on **Comp-Off (CO) entitlement**. |
| BR-C3 | **On-Call compound shifts** (e.g. "OC + CO", "OC + UK + CO", "OC + US + CO") worked on a holiday/weekend **earn a Comp-Off (CO) entitlement** that can later be consumed on a normal weekday within an entitlement window. |
| BR-C4 | A **CO** day can only be logged if the employee holds an unconsumed CO entitlement whose window covers that date. |
| BR-C5 | An entry that **granted** a CO that is still relied upon cannot be changed or cleared while a dependent CO exists. |
| BR-C6 | Public **holidays** come from a configurable schedule; holiday/weekend status changes shift eligibility. |
| BR-C7 | All month/period handling must resolve to the correct calendar month and year consistently across the calendar UI, stored data, and the export. |

---

## 11. Status / lifecycle model

Each timesheet (employee × month) moves through the statuses below. This model is the backbone that ties the three modules together.

```
 Not started --> In progress --> Submitted --> Approved --> Exported
                      ^             |   |
                      |             |   +--> Rejected --+
                      +-------------+------------------+
                        (rejection re-opens for edit & re-submit)
```

| Status | Meaning | Editable by employee? | Manager action available? | Eligible for export? |
| --- | --- | --- | --- | --- |
| Not started | No days logged | Yes | No | No |
| In progress | Some days logged, not submitted | Yes | No | No |
| Submitted | Employee submitted & locked the month | No | Approve / Reject | No |
| Rejected | Manager sent back with comment | Yes (re-opened) | No (until re-submitted) | No |
| Approved | Manager approved | No | No (read-only) | Yes |
| Exported | Included in a generated payroll CSV | No | No | Already exported |

---

## 12. Data requirements

The solution must implement the following data model, entirely within the application's own scope. Logical entities are listed; the partner is responsible for detailed table and field design.

| Entity | Purpose | Key data |
| --- | --- | --- |
| Shift submission | One row per user × date | user, date, shift type (reference to catalogue), comment |
| Shift type catalogue | Configurable shift definitions | name, description, rate, currency, effective date, colour, active |
| Submission lock | Submission lock per user × month | user, year, month, submitted-on |
| Submission summary | Weekly/monthly aggregates for payroll | user, period, shift type, count, rate snapshot, amount, currency |
| Comp-Off entitlement | CO rights earned from OC shifts | user, OC date, entitlement window, consuming CO entry |
| Approval record | Approval state per timesheet (user × month) | status, approving manager, action timestamp, manager comment |
| Export run / log | Audit of each export | target month, count of timesheets, total value, attached record reference, status |
| User & manager hierarchy | Identity and approval routing | name, employee ID, manager (from `sys_user`, configurable) |
| Payroll hand-off record | Carrier for the CSV | RITM or HR Case the CSV is attached to, routed to payroll/HR |

The approval status may be modelled as fields on a per-month object or as a dedicated approval table — the partner's choice — provided all status, manager, timestamp and comment data is captured and auditable.

---

## 13. Notifications

| Ref | Trigger | Recipient | Content |
| --- | --- | --- | --- |
| NF-1 | Employee submits month | Manager | "X submitted their timesheet for review" |
| NF-2 | Manager approves | Employee | "Your timesheet for [month] was approved" |
| NF-3 | Manager rejects | Employee | "Your timesheet for [month] was rejected — [comment]" |
| NF-4 | Approval window approaching | Manager | Reminder of pending timesheets before the export date |
| NF-5 | Export completed | Payroll/HR + Administrator | "Payroll CSV for [month] generated and attached to [record]" |
| NF-6 | Export failed / exceptions | Administrator | Failure details and list of excluded (unapproved) timesheets |

All notifications must be delivered via standard ServiceNow notifications so customers can re-template, re-route or disable them without code changes.

---

## 14. Non-functional requirements

| Ref | Requirement |
| --- | --- |
| NFR-1 | **Security/visibility:** employees see only their own data; managers see only their direct reportees; payroll sees only the exported file. Enforced by ACLs and query scoping shipped with the app. |
| NFR-2 | **Auditability:** every submission, approval, rejection (with comment) and export is attributable to a user and timestamp. |
| NFR-3 | **Usability:** UI is responsive/mobile-friendly, reuses Service Portal look & feel, and is accessible (keyboard + Esc behaviour). |
| NFR-4 | **Reliability:** the scheduled export runs unattended, alerts on failure, and is safe to re-run. |
| NFR-5 | **Configurability:** shift catalogue, rates, currency, holiday calendar, manager source, export trigger day, export target (RITM vs HR Case) and CSV options are all configurable without code changes. |
| NFR-6 | **Performance:** the manager dashboard and the export must handle a realistic org size (e.g. a manager with 25 reportees; thousands of submission rows per month) within acceptable response times. |
| NFR-7 | **Data integrity:** rate snapshots ensure historical months are not altered by later rate changes. |
| NFR-8 | **Store certification:** built as a scoped app that passes ServiceNow AppCheck/Instance Scan — no hardcoded sys_ids, no out-of-scope writes, no unsupported APIs, proper ACLs, clean logs. |
| NFR-9 | **Upgrade safety:** new versions install over existing ones without destroying customer data or configuration. |
| NFR-10 | **Supportability:** ships with admin + end-user documentation, seed/demo data, and per-version release notes. |

---

## 15. Assumptions, dependencies & constraints

### Assumptions
- A-1: Customers maintain accurate direct-reportee relationships in `sys_user.manager` (or configure an alternative source).
- A-2: Each employee has a single approving manager for a given month.
- A-3: An administrator maintains shift rates, currency, and the holiday calendar before each pay cycle.
- A-4: Each customer has the ServiceNow modules needed for their chosen export target (Request/Catalog for RITM, or HRSD for HR Case).

### Dependencies
- D-1: ServiceNow Service Portal, Notifications and Scheduled Jobs.
- D-2: ServiceNow Request (RITM) and/or HR Service Delivery (HR Case) for the export hand-off.
- D-3: Accurate identity and manager data in `sys_user`.

### Constraints
- C-1: Delivered as a **scoped application** suitable for ServiceNow Store publication; all logic stays within the application scope.
- C-2: Server logic must remain **user-scoped** for self-service data and enforce visibility via ACLs.
- C-3: No customer-specific hardcoding; everything customer-specific is data/configuration.

---

## 16. Acceptance criteria (high level)

| Ref | Criterion |
| --- | --- |
| AC-1 | An employee can log a full month, submit it, and the month locks. |
| AC-2 | A manager sees only their direct reportees and the status of each one's timesheet for a chosen month. |
| AC-3 | A manager can approve a single timesheet and bulk-approve the whole team in one action. |
| AC-4 | A manager cannot reject without entering a comment; the employee receives that comment and can re-submit. |
| AC-5 | Only approved timesheets feed the export. |
| AC-6 | On the configured working day of the next month, a CSV of approved timesheets is generated with correct per-shift and total monthly pay, and attached to a RITM/HR Case automatically. |
| AC-7 | Re-running the export for the same month does not double-count pay. |
| AC-8 | All approvals, rejections and exports are visible in an audit trail. |
| AC-9 | The application installs as a scoped app, is configurable by an administrator with no vendor code changes, and passes ServiceNow Store certification checks. |

---

## 17. Glossary

| Term | Meaning |
| --- | --- |
| Shift type | A category of work (UK, US, On-Call, Leave, Comp-Off, etc.) with an associated pay rate. |
| OC | On-Call shift. |
| CO / Comp-Off | Compensatory off earned by working an on-call/holiday shift, consumable later. |
| Compound OC | A shift such as "OC + CO" / "OC + UK + CO" that grants a CO entitlement. |
| Timesheet | An employee's set of shift entries for one calendar month. |
| Lock / Submit | The action that freezes an employee's month for review. |
| RITM | Requested Item — a ServiceNow request record. |
| HR Case | A ServiceNow HR Service Delivery case record. |
| Working day | A weekday that is not a configured holiday. |
| Gross shift allowance | The pre-tax pay value ShiftPay computes; not net pay. |
| Scoped application | A ServiceNow app contained in its own namespace/scope, suitable for Store distribution. |

---

## Appendix A: Expected deliverables & design-stage decisions

This appendix sets the partner's expected response to this BRD. It is contractual intent: the development partner is expected to respond with the design artifacts in A.1 before build begins, and to confirm the decisions in A.2 **in writing** as part of that design.

### A.1 Deliverables expected from the development partner

| # | Deliverable | What it must contain | Traces to |
| --- | --- | --- | --- |
| DL-1 | Requirements clarification log | Written answers to the design-stage decisions in A.2, plus any assumptions | A.2, whole BRD |
| DL-2 | Functional Design Document (FDD) | Screen-by-screen behaviour, wireframes/mockups, field-level UI, validation, and the status-transition design | §7–§11 |
| DL-3 | Technical / Solution Design Document | Scoped app name & scope, data model / ERD with concrete table and field names, ACL matrix, Business Rules / Script Includes, Scheduled Job design, Flow Designer flows, and notification design | §12, §13, §14 |
| DL-4 | Store certification design note | Scope-hygiene approach, AppCheck / Instance Scan strategy, upgrade/versioning & data-preservation strategy, demo data & guided setup, localisation approach | §3, NFR-8/9/10 |
| DL-5 | Requirements traceability matrix | Every FR-/BR-/AC- ID mapped to a design element and to a test case | All numbered requirements |
| DL-6 | Test plan / ATF suite | Automated Test Framework tests that prove AC-1…AC-9 | §16 |
| DL-7 | Effort estimate & delivery plan | Story breakdown, sprint/milestone plan, and dependencies | Whole BRD |

The FDD (DL-2), Solution Design (DL-3) and Traceability matrix (DL-5) are **build-gate** deliverables: development should not start until these are reviewed and signed off.

### A.2 Design-stage decisions to confirm in writing

The following are pre-set with a default in the body of this BRD; the partner must confirm or formally propose an alternative during design, with any cost/effort impact noted.

| # | Decision | Default position in this BRD |
| --- | --- | --- |
| DD-1 | Source of the manager/approver relationship | `sys_user.manager`, configurable |
| DD-2 | Approval granularity | Whole-month timesheet (not per-day) — BR-M6 |
| DD-3 | Comp-Off (CO) entitlement scope in v1 | Included; may be delivered as a toggleable module |
| DD-4 | Export target record type | RITM **or** HR Case, administrator-configurable — FR-X4 |
| DD-5 | Treatment of timesheets unapproved by the export date | Excluded and listed in run log + admin notification — FR-X8 |
| DD-6 | Export trigger day | Configurable Nth working day; default 3rd — FR-X1 |
| DD-7 | Manager visibility of pay amounts | Configurable; can be hidden from line managers — FR-M14 |
| DD-8 | Consolidated vs split CSV | One consolidated file, optional per-manager/cost-centre split — BR-X9 |
| DD-9 | Target ServiceNow release family for certification | To be agreed at design start |
| DD-10 | Expected scale (users, reportees per manager, rows/month) | To be agreed; drives performance design — NFR-6 |

### A.3 Acceptance gate

A deliverable is accepted only when it (a) covers every requirement ID it traces to in A.1, (b) records a confirmed position for every decision in A.2, and (c) — for the build itself — passes the ATF suite (DL-6) and ServiceNow Store certification checks (AC-9 / NFR-8).

---

*End of document.*
