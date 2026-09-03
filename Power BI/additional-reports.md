# Four more report pages

Extends the five pages in [README.md](README.md) §6. Each answers a question the
application itself cannot, which is the only good reason to add a page.

Same two rules apply throughout. **Money comes from `FactPay[u_amount]` and
`u_rate_snapshot`, never from live catalogue rates**, and **every money measure
filters `u_period_type = "month"`** or the clipped week rows double-count. One
measure below deliberately breaks the first rule; it is labelled, and it is a
diagnostic, not a figure to show anyone.

Add the measures in **Modeling → New measure**, one at a time, then build the
visuals described under each page.

---

## 1. Rate integrity

**The question:** are any months priced at a rate that no longer matches the
catalogue, and does anyone care?

This is the page that justifies the snapshot. `ShiftPayAggregator` freezes the
rate at compute time, so a month computed in June keeps June's rate for ever.
That is correct, and it also means the report and the catalogue will legitimately
disagree over time. Without this page nobody knows by how much.

```dax
Rate Drift Rows =
COUNTROWS(
    FILTER(
        FactPay,
        FactPay[u_period_type] = "month"
            && FactPay[u_rate_snapshot] <> RELATED(DimShiftType[rate])
    )
)

Shifts At Zero Rate =
CALCULATE(
    SUM(FactPay[u_count]),
    FactPay[u_period_type] = "month",
    FactPay[u_rate_snapshot] = 0
)

-- DIAGNOSTIC ONLY. This is the number the snapshot exists to prevent anyone
-- reporting. Never put it on a page a manager or an employee will read: it
-- reprices history at today's rates, which is precisely the mistake the
-- snapshot design rules out. It is here so the gap can be measured.
Value At Current Rates =
SUMX(
    FILTER(FactPay, FactPay[u_period_type] = "month"),
    FactPay[u_count] * RELATED(DimShiftType[rate])
)

Snapshot Gap =
[Value At Current Rates] - [Total Pay]
```

**Build it:** cards for `Total Pay`, `Snapshot Gap` and `Rate Drift Rows`. Table
of `DimShiftType[name]`, `FactPay[u_rate_snapshot]`, `DimShiftType[rate]`,
`Shifts Paid`, `Total Pay`, filtered to `Rate Drift Rows > 0`.

**Expect `Shifts At Zero Rate` to be non-zero, and know why before you
investigate.** `ShiftPayAggregator._getRateMap` reads *active* catalogue rows
only, so a shift type deactivated after being logged re-aggregates at ₹0. That
is a known wart, preserved deliberately so the Script Include extraction stayed
behaviour-neutral, and it is tracked as SP-80. Unpaid shift types also sit at ₹0
legitimately. Separate the two by checking `DimShiftType[active]`.

---

## 2. Submission timeliness

**The question:** who submits late, and is the window realistic?

The documented window is the last weekday of the month to the second weekday of
the next. The approvals page already shows how long managers take; nothing shows
how long employees take.

```dax
Avg Days To Submit =
AVERAGEX(
    FILTER(Timesheets, NOT ISBLANK(Timesheets[u_submitted_on])),
    DATEDIFF(
        EOMONTH(DATE(Timesheets[u_year], Timesheets[u_month], 1), 0),
        Timesheets[u_submitted_on],
        DAY
    )
)

Submitted After Window =
COUNTROWS(
    FILTER(
        Timesheets,
        NOT ISBLANK(Timesheets[u_submitted_on])
            && Timesheets[u_submitted_on]
               > EOMONTH(DATE(Timesheets[u_year], Timesheets[u_month], 1), 0) + 4
    )
)

Never Submitted =
CALCULATE(COUNTROWS(Timesheets), ISBLANK(Timesheets[u_submitted_on]))
```

**`u_month` is 1-indexed here and `DATE()` wants 1-indexed too, so they agree —
do not "fix" it.** The widgets and their `data` object are 0-indexed and convert
at the table boundary; the model sits on the table side of that boundary. Getting
this wrong shifts every timeliness figure by a month, and the result still looks
plausible, which is what makes it dangerous.

**`+ 4` is an approximation.** The real window ends on the second *weekday* of the
following month, which is four calendar days only when the month ends on a
weekday. Treat `Submitted After Window` as "worth a look", not as a compliance
verdict. Doing it exactly needs a weekday-aware date table, which is more
machinery than this question justifies.

**Build it:** column chart of `Avg Days To Submit` by `DimUser[name]`. Card for
`Never Submitted`. Table of the late ones with the actual dates, so a
conversation starts from evidence rather than an average.

---

## 3. Weekend and on-call load

**The question:** is unsocial work spread fairly, or does it land on the same
two people every month?

Nothing in the application answers this. A manager sees one reportee at a time,
and the person carrying every weekend is the least likely to raise it.

```dax
Weekend Shifts =
CALCULATE(
    SUM(FactPay[u_count]),
    FactPay[u_period_type] = "month",
    DimShiftType[allow_weekend_holiday] = TRUE()
)

Weekend Share =
DIVIDE([Weekend Shifts], [Shifts Paid])

On Call Shifts =
CALCULATE(
    SUM(FactPay[u_count]),
    FactPay[u_period_type] = "month",
    DimShiftType[oc_role] <> "none"
)
```

**Two things will make this wrong if you skip them.**

The Table API returns booleans as the *strings* `"true"` and `"false"`, so
`allow_weekend_holiday` arrives as text. Set the column to True/False in Power
Query, or the `= TRUE()` comparison silently matches nothing and every figure
reads zero. A measure that returns zero because of a type mismatch looks exactly
like a measure that returns zero because there is no weekend work.

More importantly: **`allow_weekend_holiday` is currently wrong in the catalogue.**
Two weekday-only shift types carry it, which is TC-SP-005 / SP-58. Until that fix
is applied this page overstates weekend load. Do not present it to anyone until
`One Time Scripts/fix-weekend-shift-flags.js` has run and TC-SP-005 is green.

Note also that "weekend or holiday" is weekend-only in practice: no holiday
schedule is configured, so no date is ever classified as a holiday. That is
TC-SP-030, and it is a real finding rather than an absence of holidays.

**Build it:** stacked bar of `Weekend Shifts` and ordinary shifts by
`DimUser[name]`, sorted by `Weekend Share` descending. Line of `Weekend Share`
by month per person — the trend matters more than any single month.

---

## 4. Compensatory-off lifecycle

**The question:** how many earned days off are quietly expiring unused?

The CO watch page in §6 shows what is outstanding and what expires in three
days. This one closes the loop: of everything ever granted, how much was
actually taken.

```dax
CO Granted =
COUNTROWS(Entitlements)

CO Consumed =
CALCULATE(COUNTROWS(Entitlements), NOT ISBLANK(Entitlements[u_co_date]))

CO Lapsed =
CALCULATE(
    COUNTROWS(Entitlements),
    ISBLANK(Entitlements[u_co_date]),
    Entitlements[u_oc_window_end] < TODAY()
)

CO Consumption Rate =
DIVIDE([CO Consumed], [CO Granted])

Avg Days To Take CO =
AVERAGEX(
    FILTER(Entitlements, NOT ISBLANK(Entitlements[u_co_date])),
    DATEDIFF(Entitlements[oc_date], Entitlements[u_co_date], DAY)
)
```

**`CO Lapsed` is the number this page exists for.** It is a right the employee
earned, that the system granted, and that expired because the seven-weekday
window ran out. Nobody is told when this happens — not the employee, not the
manager — and the entitlement row simply stays unconsumed for ever. A rising
count here is a process problem, not a data problem.

Remember the window is seven *weekdays*, not seven days, so `Avg Days To Take CO`
will read higher than the window in calendar terms whenever a weekend
intervenes. That is correct, not drift.

**Build it:** funnel or three cards — granted, consumed, lapsed. Gauge on
`CO Consumption Rate`. Table of lapsed entitlements with `u_user`, `oc_date`,
`u_oc_window_end`, sorted newest first, so a manager can at least apologise
accurately.

---

## Saving

Add the pages to `ShiftPay.pbix` in this folder and save. The file is gitignored
(`*.pbix`) and travels in the folder ZIP, so committing it is not the way to
share it — send the ZIP, and remember it carries real pay figures.
