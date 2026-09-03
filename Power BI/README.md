# ShiftPay in Power BI

Reporting layer over the ShiftPay tables: shift history, pay, approvals and CO
entitlements, read straight out of the ServiceNow instance via the Table API.

Built on **Power BI Desktop**, which is free permanently — no account, no sign-in,
no trial clock. Windows only.

---

## Read this first: are you demoing, or building?

**If you are demoing, you almost certainly do not need to build anything.**

`ShiftPay.pbix` in this folder already contains the data. Power BI import mode
caches the query results inside the file, so:

1. Install **Power BI Desktop** from the Microsoft Store (free, no account — dismiss
   the sign-in prompt, it will nag).
2. Open `ShiftPay.pbix`.
3. Demo. Slicers, drill-down and cross-filtering all work on the cached data.

You are looking at a snapshot taken at the last refresh — the date is on the Pay page.
Do **not** press Refresh unless you have instance credentials; it will prompt for them
and fail without, leaving the report empty until you close without saving.

Everything below is for whoever rebuilds or extends the model.

> **The `.pbix` contains real pay figures.** Credentials do not travel with it —
> Power BI keeps those in the local per-user credential store, not in the file — but
> the numbers do. Treat it like the spreadsheet version.

---

## Rebuilding from scratch

Budget 2–3 hours the first time. Steps 1–3 are copy-paste and take about twenty
minutes; the rest is drag-and-drop report building, which is where the time goes.

### 1. Install

Power BI Desktop from the Microsoft Store — it self-updates, the standalone installer
does not. Dismiss the sign-in prompt. Nothing here needs an account; sign-in only
unlocks publishing to the web service (see the appendix).

Stay on the built-in visuals. Every visual used below is built in. Pulling extras from
AppSource is the one ordinary thing that does ask you to sign in.

### 2. Point it at the instance

You need the instance base URL (`https://dev227442.service-now.com`, no trailing
slash) and a username and password for Basic auth. Use the credentials behind the
`shiftpay-demo` cnit profile — the app runs as `admin` anyway.

1. **Home → Transform data** to open Power Query Editor.
2. **Manage Parameters → New Parameter**. Name it `Instance`, type Text, current value
   = the base URL.

**To retarget the shipped `ShiftPay.pbix`** the parameter already exists: **Home →
Transform data → Manage Parameters → `Instance`**, change *Current Value*, then
**Close & Apply** and Refresh. Power BI Desktop is the only way to do this — the
parameter and every query live compressed inside the file's `DataModel` part, so
there is no text in the `.pbix` to edit from outside. Note that refreshing
replaces the cached data the demo relies on, so only do it when you actually want
the new instance's numbers.

> **Basic auth has to be allow-listed on the instance.** Every query here
> authenticates with Basic, and current ServiceNow releases block that unless the
> user holds `snc_basic_auth_api_access` — see
> `glide.authenticate.basic_auth.allowed_roles`. `admin` was granted that role on
> dev227442 on 2026-08-20, so it works today. Without it every query fails with a
> credentials error indistinguishable from a wrong password, and re-entering the
> password will not fix it.

> **PDI hibernation.** A Personal Developer Instance sleeps after about ten days idle.
> Every query fails with a connection error when that happens — wake the instance from
> the developer portal first. It looks like a broken report but isn't.

### 3. Extract: one function, seven queries

**New Source → Blank Query → Advanced Editor**, paste this, rename the query `fnNow`.

```m
let
  fnNow = (table as text, fields as text) as table =>
    let
      GetPage = (offset as number) as list =>
        Json.Document(
          Web.Contents(
            Instance,
            [
              RelativePath = "api/now/table/" & table,
              Query = [
                sysparm_fields                 = fields,
                sysparm_display_value          = "false",
                sysparm_exclude_reference_link = "true",
                sysparm_limit                  = "1000",
                sysparm_offset                 = Text.From(offset)
              ],
              Headers = [Accept = "application/json"]
            ]
          )
        )[result],

      Pages = List.Generate(
        () => [Offset = 0, Rows = GetPage(0)],
        each List.Count([Rows]) > 0,
        each [Offset = [Offset] + 1000, Rows = GetPage([Offset] + 1000)],
        each [Rows]
      ),

      Combined = List.Combine(Pages),

      // An empty table answers {"result":[]}, which carries no field names at
      // all, so Table.FromRecords would return a table with zero columns and
      // every later step fails with "the column ... wasn't found". The field
      // list we asked for is the schema, so build the empty table from that.
      Columns  = List.Transform(Text.Split(fields, ","), Text.Trim),
      AsTable  = if List.IsEmpty(Combined)
                 then #table(Columns, {})
                 else Table.FromRecords(Combined),

      Blanked  = Table.ReplaceValue(
                   AsTable, "", null, Replacer.ReplaceValue, Table.ColumnNames(AsTable))
    in
      Blanked
in
  fnNow
```

Four parts of that are load-bearing:

- **`RelativePath` and `Query` rather than a concatenated URL string.** A URL built by
  string-joining fails Power BI's static analysis and blocks refresh in the web
  service. Costs nothing to do right.
- **The pagination loop.** The Table API caps each response well below the row count.
  Without `List.Generate` you get a silently truncated dataset that still looks
  plausible.
- **The `Blanked` step.** ServiceNow returns empty fields as empty *strings*, not
  nulls. Left alone, an empty `u_co_date` errors the moment the column is set to Date
  type, and `ISBLANK` in DAX returns false for every row — so the CO reports would
  silently read zero. This converts `""` to null across every column.
- **The empty-table branch.** `{"result":[]}` has no field names in it, so
  `Table.FromRecords` on an empty list gives a table with **zero columns**, and
  Power BI blocks the load with *"The column 'x' of the table wasn't found."* Two of
  the seven queries hit this on any freshly seeded instance: `Entitlements` and
  `Corrections` are both legitimately empty until someone creates a CO or a manager
  corrects a day. Reconstructing the schema from the `fields` argument is what keeps
  a correct, empty table from looking like a broken query.

Then, for each row below: **New Source → Blank Query → Advanced Editor**, paste
`let Source = fnNow("<table>", "<fields>") in Source`, rename the query.

| Query | Table | Fields |
|---|---|---|
| `FactDays` | `x_1995110_shift_0_u_shift_submission` | `sys_id,number,u_user,u_date,u_shift_type,u_comment` |
| `FactPay` | `x_1995110_shift_0_shift_submission_summary` | `sys_id,u_user,u_period_type,u_period_start,u_year,u_month,u_shift_type,u_count,u_rate_snapshot,u_amount,u_currency` |
| `DimShiftType` | `x_1995110_shift_0_shift_type` | `sys_id,name,description,rate,currency,active,color_hex,oc_role,allow_weekday,allow_weekend_holiday,day_category` |
| `Timesheets` | `x_1995110_shift_0_monthly_timesheet` | `sys_id,u_user,u_year,u_month,u_submitted_on,status,approver,actioned_on,manager_comment` |
| `Entitlements` | `x_1995110_shift_0_shift_co_entitlement` | `sys_id,u_user,oc_date,u_oc_entry,u_oc_window_end,u_co_date,u_co_entry` |
| `Corrections` | `x_1995110_shift_0_shift_day_change` | `sys_id,user,date,previous_shift,new_shift,reason,changed_by,changed_on` |
| `DimUser` | `sys_user` | `sys_id,user_name,name,email,manager,active` |

Power BI prompts for credentials on the first query: choose **Basic**, enter username
and password, and set the scope to the **instance root** so all seven queries share one
credential. Pick too narrow a scope and it re-prompts for every query.

> **If a query errors with "column not found":** an empty table returns a table with no
> columns, so any later step referencing one fails. `Corrections` is the likely
> candidate on a fresh instance — no manager has corrected a day yet. Either make one
> correction in the widget to seed a row, or drop that query until the table has data.

### 4. Shape: types, date table, relationships

Everything arrives as text. Select the column, then **Transform → Data Type**.

| Query | Column | Type |
|---|---|---|
| `FactDays` | `u_date` | Date |
| `FactPay` | `u_period_start` | Date |
| `FactPay` | `u_count`, `u_year`, `u_month` | Whole number |
| `FactPay` | `u_amount`, `u_rate_snapshot` | Decimal number |
| `DimShiftType` | `rate` | Decimal number |
| `DimShiftType` | `active`, `allow_weekday`, `allow_weekend_holiday` | True/False |
| `Timesheets` | `u_submitted_on`, `actioned_on` | Date/Time |
| `Entitlements` | `oc_date`, `u_oc_window_end`, `u_co_date` | Date |
| `Corrections` | `date` | Date |
| `Corrections` | `changed_on` | Date/Time |

If a Date/Time conversion errors, use **Change Type → Using Locale** and pick English
(United Kingdom) — the API returns `YYYY-MM-DD HH:MM:SS` in UTC, which US locale
parsing mangles. Then **Close & Apply**.

**Modeling → New table** for the date dimension, then right-click it in the Data pane
and **Mark as date table** on the `Date` column:

```dax
DimDate =
ADDCOLUMNS(
    CALENDAR(DATE(2025, 1, 1), DATE(2027, 12, 31)),
    "Year",      YEAR([Date]),
    "MonthNo",   MONTH([Date]),
    "Month",     FORMAT([Date], "MMM yyyy"),
    "MonthSort", YEAR([Date]) * 100 + MONTH([Date]),
    "Weekday",   FORMAT([Date], "ddd"),
    "WeekdayNo", WEEKDAY([Date], 2),
    "WeekStart", [Date] - WEEKDAY([Date], 2) + 1,
    "IsWeekend", WEEKDAY([Date], 2) > 5
)
```

Sort the display columns or the axes come out alphabetical: select `Month` →
**Column tools → Sort by column → MonthSort**, and `Weekday` → sort by `WeekdayNo`.

In **Model view**, create these. All one-to-many, single direction, dimension → fact:

| From | To |
|---|---|
| `DimUser[sys_id]` | `FactDays[u_user]` |
| `DimUser[sys_id]` | `FactPay[u_user]` |
| `DimUser[sys_id]` | `Timesheets[u_user]` |
| `DimUser[sys_id]` | `Entitlements[u_user]` |
| `DimShiftType[sys_id]` | `FactDays[u_shift_type]` |
| `DimShiftType[sys_id]` | `FactPay[u_shift_type]` |
| `DimDate[Date]` | `FactDays[u_date]` |
| `DimDate[Date]` | `FactPay[u_period_start]` |

Power BI will also want to link `Timesheets[approver]` and `Corrections[changed_by]` to
`DimUser`. Those become inactive relationships — a table can have only one active path
to a dimension. Leave them inactive; filtering "by manager" is a later nice-to-have via
`USERELATIONSHIP`, not worth the complexity on a first pass.

### 5. Measures

**Modeling → New measure**, one at a time.

```dax
Total Pay =
CALCULATE(SUM(FactPay[u_amount]), FactPay[u_period_type] = "month")

Shifts Paid =
CALCULATE(SUM(FactPay[u_count]), FactPay[u_period_type] = "month")

Days Logged =
COUNTROWS(FactDays)

CO Outstanding =
CALCULATE(COUNTROWS(Entitlements), ISBLANK(Entitlements[u_co_date]))

CO Expiring Soon =
CALCULATE(
    COUNTROWS(Entitlements),
    ISBLANK(Entitlements[u_co_date]),
    Entitlements[u_oc_window_end] <= TODAY() + 3
)

Avg Approval Days =
AVERAGEX(
    FILTER(Timesheets, NOT ISBLANK(Timesheets[actioned_on])),
    DATEDIFF(Timesheets[u_submitted_on], Timesheets[actioned_on], DAY)
)

Shift Colour =
SELECTEDVALUE(DimShiftType[color_hex])
```

> **The two rules that matter.**
>
> **Money comes from `FactPay[u_amount]` and `u_rate_snapshot`** — never from a measure
> multiplying `FactDays` counts by the live `DimShiftType[rate]`. The snapshot is the
> point: it records the rate as it stood when the month was computed. A recomputing
> measure will quietly disagree with what the employee saw on their calendar, and a pay
> figure that differs between two screens is the one defect nobody forgives. Note also
> that `ShiftPayAggregator._getRateMap` reads *active* catalogue rows only, so a shift
> type deactivated after being logged already aggregates at ₹0 — another reason the
> snapshot and the live rate are not interchangeable.
>
> **Every money measure filters `u_period_type = "month"`.** The summary table holds
> week rows too, and the week rows are clipped to the month, so a week straddling
> month-end appears twice. Unfiltered, you double-count.

### 5b. Reconcile before anyone acts on the numbers

```bash
SN_INSTANCE=dev227442 SN_USER=admin SN_PASSWORD=... \
  node "Power BI/reconcile-monthly-totals.mjs" 2026 8
```

Read-only. It prints the month-row total, the week-row total and what an
unfiltered measure would report, so the size of the double-count is visible in
rupees rather than only described above. Then it lists month totals per user —
compare a couple against the Manager Approval drill-in for the same month; if
they agree to the rupee, the model is reading the right rows.

It also flags the states that make a total untrustworthy rather than merely
surprising: a user with week rows but no month row (the report shows nothing
while their calendar shows work), an amount with no rate snapshot behind it,
and any unexpected `u_period_type` that a `"month"` filter would silently drop.

Note the month argument is 1-indexed, matching `u_month`. The widgets are
0-indexed and convert at the table boundary; this script sits on the table side
of that boundary.

### 6. Report pages

**Pay by month** — card with `Total Pay`. Matrix: rows `DimDate[Month]`, columns
`DimShiftType[name]`, values `Shifts Paid` and `Total Pay`. Slicer on `DimUser[name]`.
The calendar widget's summary panel, with history the widget doesn't show.

**Calendar grid** — matrix: rows `DimDate[WeekStart]`, columns `DimDate[Weekday]`,
values `DimShiftType[name]` set to First. Then **Format → Cell elements → Background
colour → Style: Field value** and pick the `Shift Colour` measure. Cells pick up the
same `color_hex` the widget uses, so the two screens agree without a second palette to
maintain. This is the page to open the demo on.

**Team cost** — stacked bar: axis `DimUser[name]`, legend `DimShiftType[name]`, value
`Total Pay`, sliced by month. Answers "who is expensive and why", which the approval
queue can't.

**Approvals** — donut on `Timesheets[status]`, card with `Avg Approval Days`, and a
table of submitted-but-not-actioned months sorted oldest first: a real queue-ageing
view.

**CO watch** — cards for `CO Outstanding` and `CO Expiring Soon`, plus a table of
`Entitlements` where `u_co_date` is blank, sorted by `u_oc_window_end`. Nothing in the
app surfaces "three days to use this or lose it". This is the page that earns its keep.

Optionally a sixth page on `Corrections` — `date`, `previous_shift`, `new_shift`,
`reason`, `changed_by`. The manager-correction audit trail, currently write-only from
the app's point of view.

### 7. Save and refresh

Save the `.pbix` in this folder. The refresh loop is one button:

```
Open the .pbix in Desktop → Home → Refresh
```

Re-runs all seven queries and repaints every page. A few seconds.

---

## Appendix: publishing to the web service

Only worth it if a bookmarkable URL matters more than the friction. Nothing above
depends on it.

The web service needs an organisational sign-in — consumer email (Gmail, Hotmail) is
rejected at signup. Either a work or school Microsoft account, or a Microsoft 365 trial
that mints an identity like `you@yourdomain.onmicrosoft.com`. Then **Home → Publish →
My Workspace**, and the report appears at app.powerbi.com. The loop becomes
Refresh → Publish → Replace.

What it costs: the trial route expires in about a month and takes the workspace with
it. Even while it lasts, a free licence cannot share My Workspace content with another
person — the only outward option is **Publish to web**, which makes the report
*publicly* reachable by anyone with the link. Do not point that at pay data. Real
sharing is Power BI Pro at $14/month each.

Which is the argument for staying on Desktop: a permanent free setup, versus a link
that expires and still can't be shared.

---

## If this outgrows POC status

The extraction layer is the thing to revisit. Seven REST queries pulling whole tables
is fine at POC volume and gets slow and chatty as `u_shift_submission` grows. The
replacement is a Scripted REST endpoint in the scoped app returning one pre-joined
payload, ideally reusing `ShiftPayAggregator` so the report's arithmetic and the
widget's arithmetic cannot drift apart. That is real ServiceNow work, so it waits until
something justifies it.
