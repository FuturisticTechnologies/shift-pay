"""
Build the Power BI integration technical document.

    python "Power BI/build-technical-doc.py"

Writes ShiftPay-PowerBI-Integration.docx next to this script.

Branding comes from testing/evidence-generator/branding.py — the same module the
test evidence packs use, so the two document families stay visually identical and
a rebrand is still one file. Only DOC_KIND differs, and that is overridden here
rather than changed there.

Requires python-docx, which the test pack already depends on.
"""

import sys
from pathlib import Path

HERE = Path(__file__).parent
REPO = HERE.parent
sys.path.insert(0, str(REPO / "testing" / "evidence-generator"))

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

import branding as B

DOC_KIND = "Technical Design Document"
DOC_TITLE = "Power BI Reporting Integration"
VERSION = "1.0"
DOC_DATE = "19 August 2026"
AUTHOR = "Futuristic Technologies"

CODE_FILL = "F4F6F8"
WHITE = RGBColor(0xFF, 0xFF, 0xFF)


# --------------------------------------------------------------------------
# Layout helpers. Deliberately a local copy rather than an import of the
# evidence generator's private functions — branding is the shared seam, the
# furniture is not.
# --------------------------------------------------------------------------

def shade(cell, fill_hex):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill_hex)
    tc_pr.append(shd)


def cell_text(cell, text, *, bold=False, size=B.SIZE_SMALL, colour=B.INK, mono=False):
    cell.text = ""
    p = cell.paragraphs[0]
    p.paragraph_format.space_before = Pt(2)
    p.paragraph_format.space_after = Pt(2)
    run = p.add_run(text)
    run.bold = bold
    run.font.size = size
    run.font.color.rgb = colour
    run.font.name = B.MONO_FONT if mono else B.BODY_FONT
    return p


def field(paragraph, instruction):
    run = paragraph.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = instruction
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    run._r.append(begin)
    run._r.append(instr)
    run._r.append(end)
    return run


def rule(doc, colour=B.RULE, space_after=6):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.space_after = Pt(space_after)
    pPr = p._p.get_or_add_pPr()
    borders = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "6")
    bottom.set(qn("w:color"), f"{colour}")
    borders.append(bottom)
    pPr.append(borders)
    return p


def base_document():
    doc = Document()
    style = doc.styles["Normal"]
    style.font.name = B.BODY_FONT
    style.font.size = B.SIZE_BODY
    style.font.color.rgb = B.INK
    for section in doc.sections:
        section.top_margin = B.PAGE_MARGIN
        section.bottom_margin = B.PAGE_MARGIN
        section.left_margin = B.PAGE_MARGIN
        section.right_margin = B.PAGE_MARGIN
    return doc


def h1(doc, text, number=None):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(18)
    p.paragraph_format.space_after = Pt(5)
    p.paragraph_format.keep_with_next = True
    if number:
        n = p.add_run(f"{number}   ")
        n.bold = True
        n.font.size = B.SIZE_H1
        n.font.color.rgb = B.ORANGE
    run = p.add_run(text)
    run.bold = True
    run.font.size = B.SIZE_H1
    run.font.color.rgb = B.DEEP
    return p


def h2(doc, text):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(12)
    p.paragraph_format.space_after = Pt(3)
    p.paragraph_format.keep_with_next = True
    run = p.add_run(text)
    run.bold = True
    run.font.size = B.SIZE_H2
    run.font.color.rgb = B.BLUE
    return p


def body(doc, text, *, size=B.SIZE_BODY, colour=B.INK, italic=False,
         space_after=6, bullet=False):
    p = doc.add_paragraph(style="List Bullet" if bullet else None)
    p.paragraph_format.space_after = Pt(space_after)
    run = p.add_run(text)
    run.font.size = size
    run.font.color.rgb = colour
    run.italic = italic
    return p


def code(doc, text, caption=None):
    """A monospaced block in a shaded single-cell table, so it survives a reflow."""
    if caption:
        cap = doc.add_paragraph()
        cap.paragraph_format.space_before = Pt(8)
        cap.paragraph_format.space_after = Pt(2)
        run = cap.add_run(caption)
        run.bold = True
        run.font.size = Pt(8.5)
        run.font.color.rgb = B.MUTED
    table = doc.add_table(rows=1, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    table.columns[0].width = Inches(6.4)
    cell = table.rows[0].cells[0]
    shade(cell, CODE_FILL)
    cell.text = ""
    p = cell.paragraphs[0]
    p.paragraph_format.space_before = Pt(4)
    p.paragraph_format.space_after = Pt(4)
    for i, line in enumerate(text.strip("\n").split("\n")):
        if i:
            p.add_run().add_break()
        run = p.add_run(line)
        run.font.name = B.MONO_FONT
        run.font.size = B.SIZE_MONO
        run.font.color.rgb = B.INK
    doc.add_paragraph().paragraph_format.space_after = Pt(4)
    return table


def table(doc, headers, rows, widths=None, mono_cols=()):
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = "Table Grid"
    for i, head in enumerate(headers):
        shade(t.rows[0].cells[i], B.HEADER_FILL)
        cell_text(t.rows[0].cells[i], head, bold=True, colour=WHITE)
    for row in rows:
        cells = t.add_row().cells
        for i, value in enumerate(row):
            cell_text(cells[i], str(value), mono=(i in mono_cols))
    if widths:
        for i, w in enumerate(widths):
            for row in t.rows:
                row.cells[i].width = Inches(w)
    doc.add_paragraph().paragraph_format.space_after = Pt(6)
    return t


def note(doc, text):
    """A called-out paragraph for something that will bite if ignored."""
    t = doc.add_table(rows=1, cols=1)
    t.alignment = WD_TABLE_ALIGNMENT.LEFT
    t.columns[0].width = Inches(6.4)
    cell = t.rows[0].cells[0]
    shade(cell, "FDF1E0")
    cell.text = ""
    p = cell.paragraphs[0]
    p.paragraph_format.space_before = Pt(5)
    p.paragraph_format.space_after = Pt(5)
    run = p.add_run(text)
    run.font.size = Pt(9.5)
    run.font.color.rgb = B.INK
    doc.add_paragraph().paragraph_format.space_after = Pt(6)
    return t


def wordmark(doc, space_after=24):
    logo = B.logo_path()
    if logo:
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT
        p.add_run().add_picture(str(logo), width=Inches(1.7))
        p.paragraph_format.space_after = Pt(space_after)
        return
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(2)
    run = p.add_run(B.COMPANY.upper())
    run.bold = True
    run.font.size = Pt(13)
    run.font.color.rgb = B.BLUE
    rPr = run._r.get_or_add_rPr()
    spacing = OxmlElement("w:spacing")
    spacing.set(qn("w:val"), "60")
    rPr.append(spacing)
    rule(doc, space_after=space_after)


def header_footer(doc):
    section = doc.sections[0]
    section.different_first_page_header_footer = True

    head = section.header.paragraphs[0]
    head.text = ""
    head.paragraph_format.space_after = Pt(4)
    run = head.add_run(DOC_TITLE)
    run.font.size = B.SIZE_SMALL
    run.font.color.rgb = B.BLUE
    run.bold = True
    head.add_run("\t\t")
    tail = head.add_run(f"{B.PRODUCT} {DOC_KIND}")
    tail.font.size = B.SIZE_SMALL
    tail.font.color.rgb = B.MUTED

    foot = section.footer.paragraphs[0]
    foot.text = ""
    n = foot.add_run(B.CONFIDENTIALITY.split(".")[0] + ".   ")
    n.font.size = Pt(7.5)
    n.font.color.rgb = B.MUTED
    foot.add_run("\t\t")
    for text, instruction in (("Page ", "PAGE"), (" of ", "NUMPAGES")):
        label = foot.add_run(text)
        label.font.size = Pt(7.5)
        label.font.color.rgb = B.MUTED
        field(foot, instruction).font.size = Pt(7.5)


# --------------------------------------------------------------------------
# The document
# --------------------------------------------------------------------------

def cover(doc):
    wordmark(doc, space_after=26)

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(2)
    run = p.add_run(f"{B.PRODUCT}  ·  {DOC_KIND}")
    run.font.size = Pt(10)
    run.font.color.rgb = B.BLUE
    run.bold = True

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(6)
    run = p.add_run(DOC_TITLE)
    run.bold = True
    run.font.size = B.SIZE_TITLE
    run.font.color.rgb = B.DEEP

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(20)
    run = p.add_run(
        "Extracting shift, pay and approval data from ServiceNow into a "
        "Power BI semantic model, and the reports built on it."
    )
    run.font.size = Pt(13)
    run.font.color.rgb = B.INK

    facts = [
        ("Document", f"{DOC_TITLE} v{VERSION}"),
        ("Date", DOC_DATE),
        ("Author", AUTHOR),
        ("Application", f"{B.PRODUCT} — {B.SCOPE}"),
        ("Source system", "ServiceNow, dev307042.service-now.com"),
        ("Target", "Power BI Desktop (Microsoft Fabric Free licence)"),
        ("Deliverable", "Power BI/ShiftPay.pbix"),
        ("Status", "Built and verified against the source data"),
    ]
    t = doc.add_table(rows=0, cols=2)
    t.style = "Table Grid"
    for label, value in facts:
        row = t.add_row()
        shade(row.cells[0], B.LABEL_FILL)
        cell_text(row.cells[0], label, bold=True, colour=B.DEEP)
        cell_text(row.cells[1], value)
    t.columns[0].width = Inches(1.9)
    t.columns[1].width = Inches(4.5)

    doc.add_paragraph().paragraph_format.space_after = Pt(14)
    body(doc,
         "This document records how the reporting layer was built and why the "
         "design decisions were taken. It is written to be followed: anyone with "
         "the instance credentials should be able to rebuild the model from "
         "scratch using sections 5 to 9, and arrive at the same numbers.",
         size=Pt(10), colour=B.MUTED)

    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


def build(path):
    doc = base_document()
    header_footer(doc)
    cover(doc)

    # -- 1 ---------------------------------------------------------------
    h1(doc, "Purpose and scope", "1")
    body(doc,
         "ShiftPay records shifts, computes pay and routes monthly timesheets for "
         "approval. All three widgets show the current month and the person in "
         "front of them. Nothing in the application answers questions across "
         "months or across a team: how cost is trending, who carries the on-call "
         "load, how long approvals take, or which compensatory-off entitlements "
         "are about to expire unused.")
    body(doc,
         "Those are reporting questions rather than transactional ones, and they "
         "do not belong in a Service Portal widget. This integration puts the "
         "same data into Power BI, where the shape of the question can change "
         "without a code change.")
    body(doc,
         "The scope is read-only. Nothing in this integration writes to "
         "ServiceNow, and the application is unaware it exists. The in-portal "
         "reporting widget on the shift_reports page is a separate piece of work "
         "and is not covered here.")

    # -- 2 ---------------------------------------------------------------
    h1(doc, "How the data is reached", "2")
    body(doc,
         "Three routes were considered. The choice matters mainly because it "
         "determines what has to be installed and maintained.")
    table(doc,
          ["Option", "Assessment"],
          [["ODBC driver",
            "ServiceNow publishes an ODBC driver, but it needs an on-premises "
            "data gateway to refresh and the driver itself is legacy. Too much "
            "standing infrastructure for a proof of concept."],
           ["Scripted REST API",
            "A custom endpoint in the scoped application could return one "
            "pre-joined payload and reuse ShiftPayAggregator, so the report and "
            "the widget could never disagree on arithmetic. It is the better "
            "long-term answer and the wrong place to start: it is real "
            "ServiceNow development before anyone has seen a report."],
           ["Table API (chosen)",
            "The stock REST interface every ServiceNow instance already "
            "exposes. No gateway, no server-side build, no deployment. Power "
            "Query calls it directly over HTTPS with Basic authentication."]],
          widths=[1.5, 4.9])
    body(doc,
         "The Table API was chosen. Its weakness is that it pulls whole tables "
         "and will get chattier as the daily shift table grows; section 12 "
         "records the point at which that becomes worth fixing.")

    h2(doc, "Licensing")
    body(doc,
         "The model is built and used in Power BI Desktop, which is free "
         "permanently, runs on Windows and needs no account. Publishing to the "
         "Power BI service was deliberately not done. The service requires an "
         "organisational sign-in, and a free licence there cannot share a report "
         "with another person at all — the only outward route is Publish to Web, "
         "which makes the report publicly reachable by anyone holding the link. "
         "That is not an acceptable place for salary figures.")
    body(doc,
         "Distribution is therefore by file. The .pbix caches its query results "
         "internally, so a recipient installs Desktop, opens the file and sees "
         "the data without credentials or a licence of their own. If the report "
         "ever needs a shared, always-current URL, that is Power BI Pro at "
         "roughly £14 per user per month and a decision to take then.")

    # -- 3 ---------------------------------------------------------------
    h1(doc, "Model design", "3")
    body(doc,
         "A star schema: two fact tables and three dimensions, with a generated "
         "date table. The two facts are kept separate because they are at "
         "different grains and because only one of them is allowed to answer "
         "questions about money.")
    table(doc,
          ["Table", "Role", "Grain", "Source"],
          [["FactDays", "Fact", "One row per user per day",
            "x_1995110_shift_0_u_shift_submission"],
           ["FactPay", "Fact", "One row per user, period and shift type",
            "x_1995110_shift_0_shift_submission_summary"],
           ["DimShiftType", "Dimension", "One row per shift type",
            "x_1995110_shift_0_shift_type"],
           ["DimUser", "Dimension", "One row per user", "sys_user"],
           ["Timesheets", "Fact", "One row per user per month",
            "x_1995110_shift_0_monthly_timesheet"],
           ["Entitlements", "Fact", "One row per CO entitlement",
            "x_1995110_shift_0_shift_co_entitlement"],
           ["DimDate", "Dimension", "One row per calendar day",
            "Generated in DAX"]],
          widths=[1.1, 0.85, 1.85, 2.6], mono_cols=(3,))

    h2(doc, "Where money comes from, and why it matters")
    body(doc,
         "Every monetary figure in the model reads u_amount and u_rate_snapshot "
         "from the summary table. No measure multiplies a shift count by the "
         "live catalogue rate, and none should be added that does.")
    body(doc,
         "The summary rows carry the rate as it stood when the month was "
         "aggregated. That snapshot is the number the employee saw on their "
         "calendar and the number the manager approved. Recomputing from current "
         "rates would produce a figure that is arithmetically defensible and "
         "different, and a pay figure that disagrees between two screens is read "
         "as a defect no matter which one is right. There is also a known wart "
         "in the aggregator: its rate map reads active catalogue rows only, so a "
         "shift type deactivated after being logged already re-aggregates at "
         "zero. The snapshot and the live rate are not interchangeable.")

    note(doc,
         "The summary table holds week rows as well as month rows, and the week "
         "rows are clipped to the month they are reported under, so a week "
         "straddling month-end appears under both. Every monetary measure must "
         "filter u_period_type = \"month\". Without that filter the totals "
         "roughly double: 196,950 becomes 393,900 on the current data set.")

    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)

    # -- 4 ---------------------------------------------------------------
    h1(doc, "Extraction", "4")
    body(doc,
         "One Power Query function does all the fetching. Each table query is "
         "then a single call, which keeps the queries readable and means a fix "
         "to the fetch logic lands in one place.")
    code(doc, FN_NOW, caption="fnNow — Power Query M")

    h2(doc, "Three details that are load-bearing")
    body(doc,
         "RelativePath and Query rather than a concatenated URL. Power BI runs a "
         "static analysis over Web.Contents to decide whether a query is safe to "
         "refresh unattended. A URL assembled by string concatenation fails that "
         "check and blocks scheduled refresh in the service. It costs nothing to "
         "write it correctly now and would be tedious to retrofit.",
         bullet=True)
    body(doc,
         "The pagination loop. The Table API caps a single response well below "
         "the row counts here. Without List.Generate the query returns a "
         "truncated result that still looks entirely plausible, which is the "
         "worst kind of wrong.",
         bullet=True)
    body(doc,
         "Converting empty strings to null. ServiceNow returns an unset field as "
         "an empty string, not as null. Left alone, an empty date column throws "
         "on type conversion, and ISBLANK returns false for every row — so the "
         "CO expiry report would silently show nothing outstanding. One "
         "Table.ReplaceValue across all columns fixes both.",
         bullet=True)

    h2(doc, "Authentication")
    body(doc,
         "Basic authentication against the instance, entered once when the first "
         "query runs. The credential level must be set to the instance root "
         "rather than the full API path that Power BI offers by default. Set at "
         "the root, one credential serves every query; set at the table path, "
         "Power BI treats each table as a separate source and prompts again for "
         "each one.")
    body(doc,
         "Credentials are stored in the local per-user credential store, not "
         "inside the .pbix. A file passed to a colleague therefore carries the "
         "data but not the password, which is the behaviour we want.")

    # -- 5 ---------------------------------------------------------------
    h1(doc, "Query inventory", "5")
    body(doc,
         "Seven queries were specified and six are in the model. Each is a "
         "single call to fnNow with a table name and an explicit field list; the "
         "field lists are deliberate, since the daily table grows without limit "
         "and there is no reason to carry system columns into the model.")
    table(doc,
          ["Query", "Table", "Rows"],
          [["FactDays", "x_1995110_shift_0_u_shift_submission", "545"],
           ["FactPay", "x_1995110_shift_0_shift_submission_summary", "359"],
           ["DimShiftType", "x_1995110_shift_0_shift_type", "9"],
           ["Timesheets", "x_1995110_shift_0_monthly_timesheet", "19"],
           ["Entitlements", "x_1995110_shift_0_shift_co_entitlement", "1"],
           ["DimUser", "sys_user", "200+"],
           ["Corrections", "x_1995110_shift_0_shift_day_change", "0 — omitted"]],
          widths=[1.3, 3.6, 1.5], mono_cols=(1,))
    body(doc,
         "Corrections was left out. The manager day-correction audit table is "
         "empty, and an empty result produces a table with no columns, which "
         "then breaks every downstream step that names one. It should be added "
         "when the first correction exists; the query is written up in "
         "Power BI/README.md ready for that.")
    code(doc, QUERY_PATTERN, caption="The pattern every table query follows")

    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)

    # -- 6 ---------------------------------------------------------------
    h1(doc, "Typing and the date dimension", "6")
    body(doc,
         "Everything arrives from the API as text and has to be typed before it "
         "will aggregate. This is the step most likely to be missed, and it "
         "fails late: the query loads without complaint and the first measure "
         "that touches the column reports that SUM cannot work with values of "
         "type String.")
    table(doc,
          ["Query", "Columns", "Type"],
          [["FactDays", "u_date", "Date"],
           ["FactPay", "u_period_start", "Date"],
           ["FactPay", "u_year, u_month, u_count", "Whole number"],
           ["FactPay", "u_rate_snapshot, u_amount", "Decimal number"],
           ["DimShiftType", "rate", "Decimal number"],
           ["DimShiftType", "active, allow_weekday, allow_weekend_holiday", "True/False"],
           ["Timesheets", "u_year, u_month", "Whole number"],
           ["Timesheets", "u_submitted_on, actioned_on", "Date/Time"],
           ["Entitlements", "oc_date, u_oc_window_end, u_co_date", "Date"]],
          widths=[1.2, 3.5, 1.7], mono_cols=(1,))
    body(doc,
         "A quick way to audit the result: every column header in Power Query "
         "carries a type icon. Anything numeric or date-like still showing ABC "
         "did not convert.")
    note(doc,
         "Date/Time conversion can fail on locale. The API returns "
         "YYYY-MM-DD HH:MM:SS in UTC, which United States locale parsing "
         "mangles. Use Change Type, Using Locale and select English (United "
         "Kingdom) if the plain conversion errors.")

    h2(doc, "Date table")
    body(doc,
         "Generated in DAX rather than fetched, and marked as the model's date "
         "table so time intelligence resolves against it. WeekStart is included "
         "because the calendar report needs a Monday-anchored week, which is the "
         "same convention the aggregator uses.")
    code(doc, DIM_DATE, caption="DimDate — DAX")
    body(doc,
         "Two sort orders have to be set by hand or every axis comes out "
         "alphabetical: Month sorted by MonthSort, and Weekday sorted by "
         "WeekdayNo.")

    h2(doc, "Relationships")
    body(doc,
         "Eight, all one-to-many and single-direction, from the dimension into "
         "the fact. Power BI's auto-detection guesses some of these on load and "
         "guesses others wrongly, so the model was checked rather than accepted.")
    table(doc,
          ["From (one)", "To (many)"],
          [["DimUser[sys_id]", "FactDays[u_user]"],
           ["DimUser[sys_id]", "FactPay[u_user]"],
           ["DimUser[sys_id]", "Timesheets[u_user]"],
           ["DimUser[sys_id]", "Entitlements[u_user]"],
           ["DimShiftType[sys_id]", "FactDays[u_shift_type]"],
           ["DimShiftType[sys_id]", "FactPay[u_shift_type]"],
           ["DimDate[Date]", "FactDays[u_date]"],
           ["DimDate[Date]", "FactPay[u_period_start]"]],
          widths=[3.2, 3.2], mono_cols=(0, 1))
    body(doc,
         "Timesheets[approver] also points at DimUser and becomes an inactive "
         "relationship, because a table can hold only one active path to a given "
         "dimension. It was left inactive. Filtering approvals by the manager who "
         "made the decision would need USERELATIONSHIP and is not worth the "
         "complexity yet.")

    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)

    # -- 7 ---------------------------------------------------------------
    h1(doc, "Measures", "7")
    body(doc,
         "Seven measures. They are short by design — the model does the work, "
         "and a measure that needs explaining usually means the model is wrong.")
    code(doc, MEASURES, caption="DAX")
    body(doc,
         "Shift Colour exists to drive conditional formatting rather than to be "
         "displayed. It returns the catalogue's colour for whatever shift type "
         "is in scope, which lets the calendar report reuse the exact palette the "
         "widget uses instead of maintaining a second one that drifts.")

    # -- 8 ---------------------------------------------------------------
    h1(doc, "Reports", "8")
    body(doc,
         "Five pages. The first two carry the business case; the rest answer "
         "questions the application cannot.")
    table(doc,
          ["Page", "Visual", "Configuration"],
          [["Pay by month", "Card + Matrix",
            "Card: Total Pay. Matrix rows DimDate[Month], columns "
            "DimShiftType[name], values Shifts Paid and Total Pay. Slicer on "
            "DimUser[name]."],
           ["Team cost", "Stacked bar",
            "Y-axis DimUser[name], legend DimShiftType[name], X-axis Total Pay, "
            "sliced by month."],
           ["Approvals", "Donut + Card + Table",
            "Donut on Timesheets[status]. Card with Avg Approval Days. Table of "
            "submitted months, oldest first."],
           ["CO watch", "Cards + Table",
            "CO Outstanding and CO Expiring Soon. Table of entitlements where "
            "u_co_date is blank, sorted by u_oc_window_end."],
           ["Calendar grid", "Matrix",
            "Rows DimDate[WeekStart], columns DimDate[Weekday], values "
            "DimShiftType[name] set to First. Cell background from the Shift "
            "Colour measure."]],
          widths=[1.15, 1.35, 3.9])

    h2(doc, "What each page is for")
    body(doc,
         "Pay by month is the calendar widget's summary panel with history "
         "attached. Team cost answers who is expensive and why, which the "
         "approval queue cannot show because it only ever displays one month. "
         "Approvals gives turnaround time and a queue-ageing view.")
    body(doc,
         "CO watch is the page that justifies the exercise on its own. It lists "
         "entitlements with an open window and no consumption date, sorted by "
         "expiry. Nothing in the application tells anyone that a compensatory "
         "off is about to be lost, and the data to say so has been sitting in "
         "the table all along.")
    body(doc,
         "The calendar grid is the most convincing in a demonstration because it "
         "visibly matches the widget, cell colour for cell colour. It is also "
         "the fiddliest to configure, and it is the one to build last.")

    # -- 9 ---------------------------------------------------------------
    h1(doc, "Verification", "9")
    body(doc,
         "The model was checked against the source rather than eyeballed. "
         "Summing u_amount over the 105 monthly summary rows in the instance "
         "gives 196,950. The Total Pay card reads the same.")
    table(doc,
          ["Check", "Source of truth", "Model", "Result"],
          [["Total pay, all users and months", "196,950", "196,950", "Match"],
           ["Monthly summary rows", "105", "105", "Match"],
           ["Week rows excluded", "254 rows", "Filtered out", "Correct"],
           ["Total if week rows were included", "393,900", "Not shown", "Correct"]],
          widths=[2.5, 1.5, 1.2, 1.2])
    body(doc,
         "The last two lines are the useful part. Had the month filter been "
         "missing, the card would have read 393,900 — almost exactly double, "
         "because every day is counted once in its month row and again in its "
         "week row. A doubling is easy to miss on a screen and obvious in a "
         "reconciliation, which is why the check was done this way round.")

    # -- 10 --------------------------------------------------------------
    h1(doc, "Operating it", "10")
    h2(doc, "Refreshing")
    body(doc,
         "Open the .pbix in Power BI Desktop and press Refresh on the Home "
         "ribbon. That re-runs all six queries against the instance and repaints "
         "every page. There is no schedule and no gateway; refresh is a "
         "deliberate act by someone with credentials.")
    note(doc,
         "The ServiceNow instance is a Personal Developer Instance and "
         "hibernates after roughly ten days idle. Every query fails with a "
         "connection error when that happens, which presents as a broken report. "
         "Wake the instance from the developer portal first.")

    h2(doc, "Distributing")
    body(doc,
         "Send the .pbix. Import mode caches the query results inside the file, "
         "so the recipient installs Power BI Desktop, opens it and sees "
         "everything without an account, a licence or the instance password. "
         "They are looking at a snapshot taken at the last refresh.")
    body(doc,
         "They should not press Refresh unless they have credentials configured. "
         "Without them it prompts, fails, and leaves the report empty until the "
         "file is closed without saving.")
    body(doc,
         "The file holds real pay figures in something freely copyable. It is "
         "excluded from version control for that reason and should be treated "
         "the way the equivalent spreadsheet would be.")

    # -- 11 --------------------------------------------------------------
    h1(doc, "Limitations and next steps", "11")
    table(doc,
          ["Limitation", "Consequence", "When to act"],
          [["Whole-table extraction",
            "Six queries pull entire tables on every refresh. Fine at current "
            "volume, increasingly slow as the daily table grows.",
            "Replace with a Scripted REST endpoint returning a pre-joined "
            "payload, reusing ShiftPayAggregator so the report and the widget "
            "cannot diverge."],
           ["Manual refresh only",
            "The report is as current as the last person to open and refresh it.",
            "Power BI Pro plus a gateway-free scheduled refresh, once a shared "
            "URL is worth paying for."],
           ["Corrections omitted",
            "The manager day-correction audit trail is not reported anywhere.",
            "Add the query once the table has rows."],
           ["Snapshot distribution",
            "A recipient sees data frozen at the sender's last refresh.",
            "Same as manual refresh: it resolves when the report is published "
            "rather than posted."]],
          widths=[1.4, 2.4, 2.6])

    body(doc,
         "None of these are blocking. The model reconciles to the source, the "
         "reports answer questions the application cannot, and the whole thing "
         "cost nothing to licence.")

    doc.save(str(path))
    return path


# --------------------------------------------------------------------------
# Code listings, kept at the bottom so the prose above reads uninterrupted
# --------------------------------------------------------------------------

FN_NOW = r"""
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
      AsTable  = Table.FromRecords(Combined),
      Blanked  = Table.ReplaceValue(
                   AsTable, "", null, Replacer.ReplaceValue,
                   Table.ColumnNames(AsTable))
    in
      Blanked
in
  fnNow
"""

QUERY_PATTERN = r"""
let
  Source = fnNow(
    "x_1995110_shift_0_u_shift_submission",
    "sys_id,number,u_user,u_date,u_shift_type,u_comment"
  )
in
  Source
"""

DIM_DATE = r"""
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
"""

MEASURES = r"""
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
"""


if __name__ == "__main__":
    out = build(HERE / "ShiftPay-PowerBI-Integration.docx")
    print(f"Written: {out}")
