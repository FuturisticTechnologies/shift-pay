"""Build ShiftPay-Reports.pbit — a Power BI Template.

Why a template and not a .pbix: a .pbix stores its model in a proprietary
compressed part that only Power BI Desktop writes. A .pbit stores the same model
as plain TMSL JSON, so it can be authored outside Desktop. Opening the template
prompts for the instance URL, runs the queries, and produces a live report which
is then saved as .pbix.

The model here is the one specified in Power BI/README.md §3–5, plus the four
extra pages and measures from Power BI/additional-reports.md. Those two documents
stay the prose explanation; this is the executable form.

    py -3 tools/build-powerbi-template.py [--no-visuals]

--no-visuals emits the same model with four empty, named pages. Use it if
Desktop rejects the report layout: the model is the valuable half and the
visuals can be dragged on by hand.
"""
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "Power BI" / "ShiftPay-Reports.pbit"

DEFAULT_INSTANCE = "https://dev227442.service-now.com"

# ---------------------------------------------------------------- M queries

FN_NOW = '''let
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
      Columns  = List.Transform(Text.Split(fields, ","), Text.Trim),
      AsTable  = if List.IsEmpty(Combined) then #table(Columns, {}) else Table.FromRecords(Combined),
      Blanked  = Table.ReplaceValue(AsTable, "", null, Replacer.ReplaceValue, Table.ColumnNames(AsTable))
    in
      Blanked
in
  fnNow'''


def m_query(table, fields, casts):
    """A table query: call fnNow, then coerce the columns that are not text.

    Everything arrives from the Table API as text. The cast list mirrors the
    table in README.md §4. Dates are parsed with an explicit en-GB culture
    because the API returns UTC 'YYYY-MM-DD HH:MM:SS', which US-locale parsing
    silently mangles rather than erroring.
    """
    lines = [
        "let",
        f'  Source = fnNow("{table}", "{fields}")',
    ]
    if casts:
        pairs = ", ".join(f'{{"{c}", {t}}}' for c, t in casts)
        lines[-1] += ","
        lines.append(f"  Typed = Table.TransformColumnTypes(Source, {{{pairs}}}, \"en-GB\")")
        lines.append("in")
        lines.append("  Typed")
    else:
        lines.append("in")
        lines.append("  Source")
    return "\n".join(lines)


TEXT, INT, DEC, DATE, DTIME, BOOL = (
    "type text", "Int64.Type", "type number", "type date", "type datetime", "type logical",
)

TABLES = [
    {
        "name": "FactDays",
        "sn": "x_1995110_shift_0_u_shift_submission",
        "fields": "sys_id,number,u_user,u_date,u_shift_type,u_comment",
        "casts": [("u_date", DATE)],
        "columns": [
            ("sys_id", "string"), ("number", "string"), ("u_user", "string"),
            ("u_date", "dateTime"), ("u_shift_type", "string"), ("u_comment", "string"),
        ],
    },
    {
        "name": "FactPay",
        "sn": "x_1995110_shift_0_shift_submission_summary",
        "fields": ("sys_id,u_user,u_period_type,u_period_start,u_year,u_month,"
                   "u_shift_type,u_count,u_rate_snapshot,u_amount,u_currency"),
        "casts": [("u_period_start", DATE), ("u_year", INT), ("u_month", INT),
                  ("u_count", INT), ("u_rate_snapshot", DEC), ("u_amount", DEC)],
        "columns": [
            ("sys_id", "string"), ("u_user", "string"), ("u_period_type", "string"),
            ("u_period_start", "dateTime"), ("u_year", "int64"), ("u_month", "int64"),
            ("u_shift_type", "string"), ("u_count", "int64"),
            ("u_rate_snapshot", "double"), ("u_amount", "double"), ("u_currency", "string"),
        ],
    },
    {
        "name": "DimShiftType",
        "sn": "x_1995110_shift_0_shift_type",
        "fields": ("sys_id,name,description,rate,currency,active,color_hex,"
                   "oc_role,allow_weekday,allow_weekend_holiday,day_category"),
        # The booleans matter: the API sends the strings "true"/"false", and a
        # DAX filter of = TRUE() against text matches nothing while looking
        # exactly like a legitimate zero. Coerced here so no measure has to.
        "casts": [("rate", DEC), ("active", BOOL),
                  ("allow_weekday", BOOL), ("allow_weekend_holiday", BOOL)],
        "columns": [
            ("sys_id", "string"), ("name", "string"), ("description", "string"),
            ("rate", "double"), ("currency", "string"), ("active", "boolean"),
            ("color_hex", "string"), ("oc_role", "string"),
            ("allow_weekday", "boolean"), ("allow_weekend_holiday", "boolean"),
            ("day_category", "string"),
        ],
    },
    {
        "name": "Timesheets",
        "sn": "x_1995110_shift_0_monthly_timesheet",
        "fields": ("sys_id,u_user,u_year,u_month,u_submitted_on,status,"
                   "approver,actioned_on,manager_comment"),
        "casts": [("u_year", INT), ("u_month", INT),
                  ("u_submitted_on", DTIME), ("actioned_on", DTIME)],
        "columns": [
            ("sys_id", "string"), ("u_user", "string"), ("u_year", "int64"),
            ("u_month", "int64"), ("u_submitted_on", "dateTime"), ("status", "string"),
            ("approver", "string"), ("actioned_on", "dateTime"),
            ("manager_comment", "string"),
        ],
    },
    {
        "name": "Entitlements",
        "sn": "x_1995110_shift_0_shift_co_entitlement",
        "fields": "sys_id,u_user,oc_date,u_oc_entry,u_oc_window_end,u_co_date,u_co_entry",
        "casts": [("oc_date", DATE), ("u_oc_window_end", DATE), ("u_co_date", DATE)],
        "columns": [
            ("sys_id", "string"), ("u_user", "string"), ("oc_date", "dateTime"),
            ("u_oc_entry", "string"), ("u_oc_window_end", "dateTime"),
            ("u_co_date", "dateTime"), ("u_co_entry", "string"),
        ],
    },
    {
        "name": "DimUser",
        "sn": "sys_user",
        "fields": "sys_id,user_name,name,email,manager,active",
        "casts": [("active", BOOL)],
        "columns": [
            ("sys_id", "string"), ("user_name", "string"), ("name", "string"),
            ("email", "string"), ("manager", "string"), ("active", "boolean"),
        ],
    },
]

# Corrections is deliberately omitted. It is legitimately empty on a fresh
# instance until a manager corrects a day, and an empty Table API response
# carries no field names, so the query loads a zero-column table and Desktop
# blocks the refresh with "the column 'date' wasn't found". Add it once the
# table has a row; README.md §3 explains the same trap.

# ------------------------------------------------------------------ measures
# Placed on the table each one reads, so the field list stays navigable.
MEASURES = {
    "FactPay": [
        ("Total Pay",
         'CALCULATE(SUM(FactPay[u_amount]), FactPay[u_period_type] = "month")',
         '"₹"#,##0.00'),
        ("Shifts Paid",
         'CALCULATE(SUM(FactPay[u_count]), FactPay[u_period_type] = "month")', None),
        ("Rate Drift Rows",
         'COUNTROWS(FILTER(FactPay, FactPay[u_period_type] = "month" '
         '&& FactPay[u_rate_snapshot] <> RELATED(DimShiftType[rate])))', None),
        ("Shifts At Zero Rate",
         'CALCULATE(SUM(FactPay[u_count]), FactPay[u_period_type] = "month", '
         'FactPay[u_rate_snapshot] = 0)', None),
        # Diagnostic only. This is the figure the rate snapshot exists to stop
        # anyone reporting; it reprices history at today's rates. Kept so the
        # gap can be measured, never to be put in front of an employee.
        ("Value At Current Rates",
         'SUMX(FILTER(FactPay, FactPay[u_period_type] = "month"), '
         'FactPay[u_count] * RELATED(DimShiftType[rate]))', '"₹"#,##0.00'),
        ("Snapshot Gap", "[Value At Current Rates] - [Total Pay]", '"₹"#,##0.00'),
        ("Weekend Shifts",
         'CALCULATE(SUM(FactPay[u_count]), FactPay[u_period_type] = "month", '
         'DimShiftType[allow_weekend_holiday] = TRUE())', None),
        ("Weekend Share", "DIVIDE([Weekend Shifts], [Shifts Paid])", "0.0%"),
        ("On Call Shifts",
         'CALCULATE(SUM(FactPay[u_count]), FactPay[u_period_type] = "month", '
         'DimShiftType[oc_role] <> "none")', None),
    ],
    "Timesheets": [
        ("Avg Approval Days",
         "AVERAGEX(FILTER(Timesheets, NOT ISBLANK(Timesheets[actioned_on])), "
         "DATEDIFF(Timesheets[u_submitted_on], Timesheets[actioned_on], DAY))", "0.0"),
        # u_month is 1-indexed and DATE() wants 1-indexed, so they agree. The
        # widgets are 0-indexed and convert at the table boundary; the model
        # sits on the table side of it. Getting this wrong shifts every figure
        # by a month and still looks plausible.
        ("Avg Days To Submit",
         "AVERAGEX(FILTER(Timesheets, NOT ISBLANK(Timesheets[u_submitted_on])), "
         "DATEDIFF(EOMONTH(DATE(Timesheets[u_year], Timesheets[u_month], 1), 0), "
         "Timesheets[u_submitted_on], DAY))", "0.0"),
        ("Submitted After Window",
         "COUNTROWS(FILTER(Timesheets, NOT ISBLANK(Timesheets[u_submitted_on]) "
         "&& Timesheets[u_submitted_on] > "
         "EOMONTH(DATE(Timesheets[u_year], Timesheets[u_month], 1), 0) + 4))", None),
        ("Never Submitted",
         "CALCULATE(COUNTROWS(Timesheets), ISBLANK(Timesheets[u_submitted_on]))", None),
    ],
    "Entitlements": [
        ("CO Granted", "COUNTROWS(Entitlements)", None),
        ("CO Consumed",
         "CALCULATE(COUNTROWS(Entitlements), NOT ISBLANK(Entitlements[u_co_date]))", None),
        ("CO Outstanding",
         "CALCULATE(COUNTROWS(Entitlements), ISBLANK(Entitlements[u_co_date]))", None),
        ("CO Expiring Soon",
         "CALCULATE(COUNTROWS(Entitlements), ISBLANK(Entitlements[u_co_date]), "
         "Entitlements[u_oc_window_end] <= TODAY() + 3)", None),
        # The number this page exists for: a right the employee earned, that the
        # system granted, that expired because the seven-weekday window ran out.
        # Nobody is told when it happens.
        ("CO Lapsed",
         "CALCULATE(COUNTROWS(Entitlements), ISBLANK(Entitlements[u_co_date]), "
         "Entitlements[u_oc_window_end] < TODAY())", None),
        ("CO Consumption Rate", "DIVIDE([CO Consumed], [CO Granted])", "0.0%"),
        ("Avg Days To Take CO",
         "AVERAGEX(FILTER(Entitlements, NOT ISBLANK(Entitlements[u_co_date])), "
         "DATEDIFF(Entitlements[oc_date], Entitlements[u_co_date], DAY))", "0.0"),
    ],
    "DimShiftType": [
        ("Shift Colour", "SELECTEDVALUE(DimShiftType[color_hex])", None),
    ],
}

DIMDATE_DAX = (
    "ADDCOLUMNS(CALENDAR(DATE(2025,1,1), DATE(2027,12,31)), "
    '"Year", YEAR([Date]), '
    '"MonthNo", MONTH([Date]), '
    '"Month", FORMAT([Date], "MMM yyyy"), '
    '"MonthSort", YEAR([Date]) * 100 + MONTH([Date]), '
    '"Weekday", FORMAT([Date], "ddd"), '
    '"WeekdayNo", WEEKDAY([Date], 2), '
    '"WeekStart", [Date] - WEEKDAY([Date], 2) + 1, '
    '"IsWeekend", WEEKDAY([Date], 2) > 5)'
)

DIMDATE_COLUMNS = [
    ("Date", "dateTime"), ("Year", "int64"), ("MonthNo", "int64"),
    ("Month", "string"), ("MonthSort", "int64"), ("Weekday", "string"),
    ("WeekdayNo", "int64"), ("WeekStart", "dateTime"), ("IsWeekend", "boolean"),
]

RELATIONSHIPS = [
    ("DimUser", "sys_id", "FactDays", "u_user"),
    ("DimUser", "sys_id", "FactPay", "u_user"),
    ("DimUser", "sys_id", "Timesheets", "u_user"),
    ("DimUser", "sys_id", "Entitlements", "u_user"),
    ("DimShiftType", "sys_id", "FactDays", "u_shift_type"),
    ("DimShiftType", "sys_id", "FactPay", "u_shift_type"),
    ("DimDate", "Date", "FactDays", "u_date"),
    ("DimDate", "Date", "FactPay", "u_period_start"),
]


def build_model():
    tables = []

    for t in TABLES:
        cols = [
            {
                "name": n,
                "dataType": dt,
                "sourceColumn": n,
                "summarizeBy": "none",
                "annotations": [{"name": "SummarizationSetBy", "value": "Automatic"}],
            }
            for n, dt in t["columns"]
        ]
        table = {
            "name": t["name"],
            "columns": cols,
            "partitions": [{
                "name": t["name"],
                "mode": "import",
                "source": {"type": "m", "expression": m_query(t["sn"], t["fields"], t["casts"])},
            }],
            "annotations": [{"name": "PBI_ResultType", "value": "Table"}],
        }
        if t["name"] in MEASURES:
            table["measures"] = [
                {k: v for k, v in
                 {"name": nm, "expression": expr, "formatString": fmt}.items() if v}
                for nm, expr, fmt in MEASURES[t["name"]]
            ]
        tables.append(table)

    # DimDate is a calculated table; its columns are inferred from the DAX, so
    # they are declared with isNameInferred and a calculated source.
    tables.append({
        "name": "DimDate",
        "isHidden": False,
        "columns": [
            {
                "name": n,
                "dataType": dt,
                "isNameInferred": True,
                "isDataTypeInferred": True,
                "source": {"type": "calculated"},
                "type": "calculatedTableColumn",
                "sourceColumn": f"[{n}]",
                "summarizeBy": "none",
                # Month and Weekday sort by their numeric partners or every axis
                # in the report comes out alphabetical: Apr, Aug, Dec...
                **({"sortByColumn": "MonthSort"} if n == "Month" else {}),
                **({"sortByColumn": "WeekdayNo"} if n == "Weekday" else {}),
            }
            for n, dt in DIMDATE_COLUMNS
        ],
        "partitions": [{
            "name": "DimDate",
            "mode": "import",
            "source": {"type": "calculated", "expression": DIMDATE_DAX},
        }],
        "dataCategory": "Time",
        "annotations": [{"name": "PBI_ResultType", "value": "Table"}],
    })

    relationships = [
        {
            "name": f"rel_{i}",
            "fromTable": ft, "fromColumn": fc,
            "toTable": tt, "toColumn": tc,
            "crossFilteringBehavior": "oneDirection",
        }
        # fromTable is the many side in TMSL, so the fact table leads.
        for i, (tt, tc, ft, fc) in enumerate(RELATIONSHIPS)
    ]

    return {
        "name": "ShiftPay Reports",
        "compatibilityLevel": 1567,
        "model": {
            "culture": "en-GB",
            "dataAccessOptions": {
                "legacyRedirects": True,
                "returnErrorValuesAsNull": True,
            },
            "defaultPowerBIDataSourceVersion": "powerBI_V3",
            "sourceQueryCulture": "en-GB",
            "tables": tables,
            "relationships": relationships,
            "expressions": [
                {
                    "name": "Instance",
                    "kind": "m",
                    "expression": (
                        f'"{DEFAULT_INSTANCE}" meta '
                        '[IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]'
                    ),
                    "annotations": [{"name": "PBI_ResultType", "value": "Text"}],
                },
                {"name": "fnNow", "kind": "m", "expression": FN_NOW,
                 "annotations": [{"name": "PBI_ResultType", "value": "Function"}]},
            ],
            "annotations": [
                {"name": "PBI_QueryOrder",
                 "value": json.dumps(["Instance", "fnNow"] + [t["name"] for t in TABLES])},
                {"name": "__PBI_TimeIntelligenceEnabled", "value": "0"},
            ],
        },
    }


# ------------------------------------------------------------------- report

def measure_select(table, measure, alias=None):
    return {
        "Measure": {"Expression": {"SourceRef": {"Source": "s"}}, "Property": measure},
        "Name": alias or f"{table}.{measure}",
    }


def column_select(table, column, alias=None):
    return {
        "Column": {"Expression": {"SourceRef": {"Source": "s"}}, "Property": column},
        "Name": alias or f"{table}.{column}",
    }


def visual(vid, vtype, x, y, w, h, entity, projections, selects, title=None):
    single = {
        "visualType": vtype,
        "projections": projections,
        "prototypeQuery": {
            "Version": 2,
            "From": [{"Name": "s", "Entity": entity, "Type": 0}],
            "Select": selects,
        },
        "drillFilterOtherVisuals": True,
    }
    if title:
        single["vcObjects"] = {
            "title": [{"properties": {
                "text": {"expr": {"Literal": {"Value": f"'{title}'"}}},
                "show": {"expr": {"Literal": {"Value": "true"}}},
            }}]
        }
    config = {
        "name": vid,
        "layouts": [{"id": 0, "position": {"x": x, "y": y, "z": 0, "width": w, "height": h}}],
        "singleVisual": single,
    }
    return {
        "x": x, "y": y, "z": 0, "width": w, "height": h,
        "config": json.dumps(config),
        "filters": "[]",
    }


def card(vid, x, y, w, h, table, measure, title):
    return visual(vid, "card", x, y, w, h, table,
                  {"Values": [{"queryRef": f"{table}.{measure}"}]},
                  [measure_select(table, measure)], title)


def bar(vid, x, y, w, h, entity, cat_table, cat_col, val_table, measure, title):
    return visual(
        vid, "clusteredColumnChart", x, y, w, h, entity,
        {"Category": [{"queryRef": f"{cat_table}.{cat_col}"}],
         "Y": [{"queryRef": f"{val_table}.{measure}"}]},
        [column_select(cat_table, cat_col), measure_select(val_table, measure)],
        title,
    )


def table_visual(vid, x, y, w, h, entity, cols, title):
    return visual(
        vid, "tableEx", x, y, w, h, entity,
        {"Values": [{"queryRef": f"{t}.{c}"} for t, c, _ in cols]},
        [column_select(t, c) if kind == "col" else measure_select(t, c)
         for t, c, kind in cols],
        title,
    )


def page(ordinal, name, display, containers):
    return {
        "id": ordinal,
        "name": name,
        "displayName": display,
        "ordinal": ordinal,
        "visualContainers": containers,
        "config": "{}",
        "filters": "[]",
        "displayOption": 1,
        "width": 1280,
        "height": 720,
    }


def build_report(with_visuals=True):
    if not with_visuals:
        sections = [
            page(i, f"ReportSection{i}", d, [])
            for i, d in enumerate(
                ["Rate integrity", "Submission timeliness",
                 "Weekend and on-call load", "CO lifecycle"])
        ]
    else:
        sections = [
            page(0, "ReportSection0", "Rate integrity", [
                card("rate_total", 20, 20, 280, 140, "FactPay", "Total Pay", "Total pay (snapshot)"),
                card("rate_gap", 320, 20, 280, 140, "FactPay", "Snapshot Gap",
                     "Gap vs current rates (diagnostic)"),
                card("rate_drift", 620, 20, 280, 140, "FactPay", "Rate Drift Rows",
                     "Rows priced off current rate"),
                card("rate_zero", 920, 20, 280, 140, "FactPay", "Shifts At Zero Rate",
                     "Shifts at a zero snapshot"),
                bar("rate_by_type", 20, 180, 1180, 400, "FactPay",
                    "DimShiftType", "name", "FactPay", "Total Pay",
                    "Pay by shift type — snapshot rates"),
            ]),
            page(1, "ReportSection1", "Submission timeliness", [
                card("sub_avg", 20, 20, 280, 140, "Timesheets", "Avg Days To Submit",
                     "Avg days after month end"),
                card("sub_late", 320, 20, 280, 140, "Timesheets", "Submitted After Window",
                     "Submitted after the window"),
                card("sub_never", 620, 20, 280, 140, "Timesheets", "Never Submitted",
                     "Never submitted"),
                card("sub_appr", 920, 20, 280, 140, "Timesheets", "Avg Approval Days",
                     "Avg days to approve"),
                bar("sub_by_user", 20, 180, 1180, 400, "Timesheets",
                    "DimUser", "name", "Timesheets", "Avg Days To Submit",
                    "Days to submit, by person"),
            ]),
            page(2, "ReportSection2", "Weekend and on-call load", [
                card("wk_total", 20, 20, 280, 140, "FactPay", "Weekend Shifts",
                     "Weekend shifts"),
                card("wk_share", 320, 20, 280, 140, "FactPay", "Weekend Share",
                     "Share of all shifts"),
                card("wk_oncall", 620, 20, 280, 140, "FactPay", "On Call Shifts",
                     "On-call shifts"),
                bar("wk_by_user", 20, 180, 1180, 400, "FactPay",
                    "DimUser", "name", "FactPay", "Weekend Shifts",
                    "Weekend load by person — overstates until SP-58 lands"),
            ]),
            page(3, "ReportSection3", "CO lifecycle", [
                card("co_granted", 20, 20, 280, 140, "Entitlements", "CO Granted", "Granted"),
                card("co_consumed", 320, 20, 280, 140, "Entitlements", "CO Consumed", "Taken"),
                card("co_lapsed", 620, 20, 280, 140, "Entitlements", "CO Lapsed",
                     "Lapsed unused"),
                card("co_rate", 920, 20, 280, 140, "Entitlements", "CO Consumption Rate",
                     "Consumption rate"),
                table_visual("co_table", 20, 180, 1180, 400, "Entitlements", [
                    ("Entitlements", "u_user", "col"),
                    ("Entitlements", "oc_date", "col"),
                    ("Entitlements", "u_oc_window_end", "col"),
                ], "Entitlements — check the unconsumed ones against the window end"),
            ]),
        ]

    return {
        "id": 0,
        "resourcePackages": [],
        "sections": sections,
        "config": json.dumps({
            "version": "5.43",
            "activeSectionIndex": 0,
            "defaultDrillFilterOtherVisuals": True,
        }),
        "layoutOptimization": 0,
        "publicCustomVisuals": [],
    }


# --------------------------------------------------------------------- pack

def utf16(obj):
    """Power BI writes these parts as UTF-16 LE with a BOM."""
    text = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)
    return ("﻿" + text).encode("utf-16-le")


CONTENT_TYPES = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="" />
  <Override PartName="/Version" ContentType="" />
  <Override PartName="/Settings" ContentType="" />
  <Override PartName="/Metadata" ContentType="" />
  <Override PartName="/DataModelSchema" ContentType="" />
  <Override PartName="/DiagramLayout" ContentType="" />
  <Override PartName="/Report/Layout" ContentType="" />
</Types>
"""


def main():
    with_visuals = "--no-visuals" not in sys.argv

    model = build_model()
    report = build_report(with_visuals)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES.encode("utf-8"))
        z.writestr("Version", utf16("1.28"))
        z.writestr("Settings", utf16({"Version": 4}))
        z.writestr("Metadata", utf16({"Version": 3, "AutoCreatedRelationships": []}))
        z.writestr("DataModelSchema", utf16(model))
        z.writestr("DiagramLayout", utf16({"version": "1.1.0", "diagrams": []}))
        z.writestr("Report/Layout", utf16(report))

    n_meas = sum(len(v) for v in MEASURES.values())
    print(f"wrote {OUT.relative_to(ROOT)}  ({OUT.stat().st_size:,} bytes)")
    print(f"  tables        {len(model['model']['tables'])} (6 queried + DimDate calculated)")
    print(f"  measures      {n_meas}")
    print(f"  relationships {len(model['model']['relationships'])}")
    print(f"  report pages  {len(report['sections'])}"
          f"{'' if with_visuals else '  (empty — --no-visuals)'}")


if __name__ == "__main__":
    main()
