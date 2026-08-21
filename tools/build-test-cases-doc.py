"""
Build the ShiftPay test case specification document.

    python tools/build-test-cases-doc.py

Reads testing/TEST-CASES-SHIFTPAY.md and writes ShiftPay-Test-Cases.docx to the
repository root, beside the other two documents.

THE MARKDOWN IS THE SOURCE OF TRUTH AND THIS IS A ONE-WAY RENDER. That file is
parsed at run time by testing/evidence-generator/case_parser.py, which reads the
case headings and the `| **Label** | value |` metadata rows. Edit the markdown
and re-run this; never edit the .docx and copy back, or the evidence packs and
the specification will disagree about what a case is.

Nothing is rewritten on the way through except three glyphs that Calibri does
not carry (see GLYPHS) — those are substituted at render time rather than in the
source, precisely because the source is parsed by something else.

Branding comes from testing/evidence-generator/branding.py, shared with the
evidence packs and the other two documents. The page furniture is a local copy,
following the convention set in Power BI/build-technical-doc.py: branding is the
shared seam, layout is not — these three documents have genuinely different
shapes and a common layout module would end up parameterised into uselessness.

Requires python-docx.
"""

import re
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

SOURCE = REPO / "testing" / "TEST-CASES-SHIFTPAY.md"
TARGET = REPO / "ShiftPay-Test-Cases.docx"

DOC_KIND = "Test Case Specification"
DOC_TITLE = "Test Cases"
VERSION = "1.0"

CODE_FILL = "F4F6F8"
NOTE_FILL = "FDF1E0"
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
CONTENT_WIDTH = 6.4

CONFIDENTIALITY = (
    "Confidential. Prepared by Futuristic Technologies. "
    "Contains system test specifications and must not be redistributed without written consent."
)

# Calibri carries none of these. Substituted at render time only — the source
# file is parsed by the evidence generator and is not ours to rewrite.
GLYPHS = {"\u2714": "Yes", "\u2718": "No", "\u26a0": "(!)"}

CASE_HEADING = re.compile(r"^(TC-SP-\d+)\s*[\u2014-]\s*(.*)$")
TABLE_DIVIDER = re.compile(r"^\|[\s:\-|]+\|$")
ORDERED = re.compile(r"^(\d+)\.\s+(.*)$")
BOLD_ONLY = re.compile(r"^\*\*([^*]+)\*\*\.?$")
# Bold is matched non-greedily rather than as "no asterisks inside", so a
# span like **No `x_shiftpay.*` property exists** still closes correctly.
INLINE = re.compile(r"(\*\*.+?\*\*|`[^`]+`|(?<!\*)\*(?!\*)[^*]+\*(?!\*))")

BLOCK_STARTERS = ("#", ">", "-", "|", "```", "!", "---")


# ---------------------------------------------------------------------------
# Rendered-document suppressions.
#
# The source file keeps every line of this, and must: the expected-failure
# statuses are what tell a runner that a red result is the correct one, the
# July mix is what keeps two of the manager counts different, and CLAUDE.md
# requires the TC-SP-009 provenance to be updated in step with the comment on
# the template line it describes. None of it is specification, though — it is
# internal scaffolding — so it is dropped on the way into the client-facing
# document rather than deleted at source.
#
# Matching is on distinctive literal text. A source edit that moves this
# material makes a suppression stop matching, which shows up in the document,
# rather than silently swallowing the wrong paragraph.
# ---------------------------------------------------------------------------

STATUS_SUFFIX = re.compile(r"\s*[—-]\s*expected to fail\s*$", re.I)

DROP_QUOTES = ("is the demo month",)
DROP_ROWS = ("INTRODUCED DEFECT",)
DROP_SECTIONS = ("provenance",)

REWRITES = (
    ("nothing seeds entitlements, the demo creates one live on screen, and the "
     "reveal depends on there being none beforehand.",
     "nothing seeds entitlements. TC-SP-003 creates one during its run and "
     "releases it again at teardown."),
    ("**Writes approval state** that the demo data depends on",
     "**Writes approval state** that the seeded data depends on"),
    ("so a demo run cannot disturb anything.",
     "so a full run cannot disturb anything."),
    ("The nine automated cases were chosen to be read-only or self-reversing",
     "The automated cases are read-only or self-reversing"),
)


# --------------------------------------------------------------------------
# Layout helpers
# --------------------------------------------------------------------------

def shade(cell, fill_hex):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill_hex)
    tc_pr.append(shd)


def no_borders(table):
    """Strip the grid from a label/value block so it reads as a definition list."""
    tbl_pr = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), "4")
        el.set(qn("w:color"), "E4E8ED")
        borders.append(el)
    tbl_pr.append(borders)


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


def clean(text):
    for bad, good in GLYPHS.items():
        text = text.replace(bad, good)
    for before, after in REWRITES:
        text = text.replace(before, after)
    return text


def plain_status(value):
    """The status without the expected-failure qualifier."""
    return STATUS_SUFFIX.sub("", re.sub(r"[*`]", "", value)).strip()


def add_runs(paragraph, text, *, size=B.SIZE_BODY, colour=B.INK,
             bold=False, italic=False):
    """Recursive, so a code span nested inside a bold span still renders."""
    for token in INLINE.split(clean(text)):
        if not token:
            continue
        if token.startswith("**") and token.endswith("**") and len(token) > 4:
            add_runs(paragraph, token[2:-2], size=size, colour=colour,
                     bold=True, italic=italic)
            continue
        if token.startswith("*") and token.endswith("*") and len(token) > 2:
            add_runs(paragraph, token[1:-1], size=size, colour=colour,
                     bold=bold, italic=True)
            continue
        mono = token.startswith("`") and token.endswith("`") and len(token) > 1
        run = paragraph.add_run(token[1:-1] if mono else token)
        run.bold = bold
        run.italic = italic
        run.font.name = B.MONO_FONT if mono else B.BODY_FONT
        run.font.size = Pt(size.pt - 0.5) if mono else size
        run.font.color.rgb = colour
    return paragraph


def cell_rich(cell, text, *, bold=False, size=B.SIZE_SMALL, colour=B.INK):
    cell.text = ""
    p = cell.paragraphs[0]
    p.paragraph_format.space_before = Pt(2)
    p.paragraph_format.space_after = Pt(2)
    add_runs(p, text, size=size, colour=colour, bold=bold)
    return p


# --------------------------------------------------------------------------
# Block elements
# --------------------------------------------------------------------------

def part_divider(doc, text):
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(70)
    p.paragraph_format.space_after = Pt(4)
    run = p.add_run("TEST GROUP")
    run.bold = True
    run.font.size = Pt(10.5)
    run.font.color.rgb = B.ORANGE
    rPr = run._r.get_or_add_rPr()
    spacing = OxmlElement("w:spacing")
    spacing.set(qn("w:val"), "60")
    rPr.append(spacing)

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(10)
    run = p.add_run(text)
    run.bold = True
    run.font.size = Pt(28)
    run.font.color.rgb = B.DEEP
    rule(doc, space_after=10)


def h1(doc, text):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(18)
    p.paragraph_format.space_after = Pt(5)
    p.paragraph_format.keep_with_next = True
    run = p.add_run(clean(text))
    run.bold = True
    run.font.size = B.SIZE_H1
    run.font.color.rgb = B.DEEP
    return p


def case_heading(doc, case_id, title):
    """A case opens with its identifier set apart, so the page can be scanned."""
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(16)
    p.paragraph_format.space_after = Pt(4)
    p.paragraph_format.keep_with_next = True
    n = p.add_run(f"{case_id}   ")
    n.bold = True
    n.font.size = Pt(12)
    n.font.name = B.MONO_FONT
    n.font.color.rgb = B.ORANGE
    run = p.add_run(clean(title))
    run.bold = True
    run.font.size = Pt(13)
    run.font.color.rgb = B.DEEP
    return p


def sub_label(doc, text):
    """The `**Steps**` / `**Expected**` markers inside a case."""
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(9)
    p.paragraph_format.space_after = Pt(2)
    p.paragraph_format.keep_with_next = True
    run = p.add_run(clean(text).upper())
    run.bold = True
    run.font.size = Pt(9)
    run.font.color.rgb = B.BLUE
    rPr = run._r.get_or_add_rPr()
    spacing = OxmlElement("w:spacing")
    spacing.set(qn("w:val"), "50")
    rPr.append(spacing)
    return p


def paragraph(doc, text, *, indent=0.0):
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(6)
    if indent:
        p.paragraph_format.left_indent = Inches(indent)
    add_runs(p, text)
    return p


def bullet(doc, text):
    p = doc.add_paragraph(style="List Bullet")
    p.paragraph_format.space_after = Pt(3)
    add_runs(p, text)
    return p


def code(doc, lines):
    t = doc.add_table(rows=1, cols=1)
    t.alignment = WD_TABLE_ALIGNMENT.LEFT
    t.columns[0].width = Inches(CONTENT_WIDTH)
    cell = t.rows[0].cells[0]
    shade(cell, CODE_FILL)
    cell.text = ""
    p = cell.paragraphs[0]
    p.paragraph_format.space_before = Pt(4)
    p.paragraph_format.space_after = Pt(4)
    for i, line in enumerate(lines):
        if i:
            p.add_run().add_break()
        run = p.add_run(clean(line))
        run.font.name = B.MONO_FONT
        run.font.size = B.SIZE_MONO
        run.font.color.rgb = B.INK
    doc.add_paragraph().paragraph_format.space_after = Pt(4)
    return t


def note(doc, text):
    t = doc.add_table(rows=1, cols=1)
    t.alignment = WD_TABLE_ALIGNMENT.LEFT
    t.columns[0].width = Inches(CONTENT_WIDTH)
    cell = t.rows[0].cells[0]
    shade(cell, NOTE_FILL)
    cell.text = ""
    p = cell.paragraphs[0]
    p.paragraph_format.space_before = Pt(5)
    p.paragraph_format.space_after = Pt(5)
    add_runs(p, text, size=Pt(9.5))
    doc.add_paragraph().paragraph_format.space_after = Pt(6)
    return t


# Status and priority carry the weight in a test specification, so they are
# coloured rather than left as prose.
def status_colour(value):
    v = value.upper()
    if "EXPECTED TO FAIL" in v:
        return B.VERDICT_COLOURS["FAIL"], B.VERDICT_FILL["FAIL"]
    if "AUTOMATED" in v:
        return B.VERDICT_COLOURS["PASS"], B.VERDICT_FILL["PASS"]
    if "PENDING" in v:
        return B.MUTED, B.VERDICT_FILL["NOT RUN"]
    return B.INK, None


def priority_colour(value):
    v = value.strip().upper()
    if v.startswith("P1"):
        return B.VERDICT_COLOURS["FAIL"]
    if v.startswith("P2"):
        return B.VERDICT_COLOURS["BLOCKED"]
    return B.MUTED


def meta_table(doc, rows):
    """A header-less `| | |` block: a label/value definition list."""
    t = doc.add_table(rows=0, cols=2)
    t.style = "Table Grid"
    no_borders(t)
    for row in rows:
        label = row[0] if row else ""
        value = row[1] if len(row) > 1 else ""
        if any(marker in value for marker in DROP_ROWS):
            continue
        cells = t.add_row().cells
        shade(cells[0], B.LABEL_FILL)
        cell_rich(cells[0], label, bold=True, colour=B.DEEP)

        plain = re.sub(r"[*`]", "", value).strip()
        key = re.sub(r"[*`]", "", label).strip().lower()
        if key == "status":
            plain = plain_status(value)
            colour, fill = status_colour(plain)
            if fill:
                shade(cells[1], fill)
            cell_rich(cells[1], plain, bold=True, colour=colour)
        elif key == "priority":
            cell_rich(cells[1], value, bold=True, colour=priority_colour(plain))
        else:
            cell_rich(cells[1], value)
    t.columns[0].width = Inches(1.35)
    t.columns[1].width = Inches(5.05)
    doc.add_paragraph().paragraph_format.space_after = Pt(4)
    return t


def grid(doc, headers, rows):
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = "Table Grid"
    for i, head in enumerate(headers):
        shade(t.rows[0].cells[i], B.HEADER_FILL)
        cell_rich(t.rows[0].cells[i], head, bold=True, colour=WHITE)
    for row in rows:
        cells = t.add_row().cells
        for i, value in enumerate(row):
            if i < len(cells):
                cell_rich(cells[i], value)

    weights = []
    for i in range(len(headers)):
        longest = max([len(headers[i])] + [len(r[i]) for r in rows if i < len(r)])
        weights.append(max(longest, 8))
    total = float(sum(weights))
    for i, w in enumerate(weights):
        width = Inches(max(0.6, CONTENT_WIDTH * w / total))
        for row in t.rows:
            row.cells[i].width = width
    doc.add_paragraph().paragraph_format.space_after = Pt(6)
    return t


# --------------------------------------------------------------------------
# Cover, header, footer, index
# --------------------------------------------------------------------------

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
    n = foot.add_run(CONFIDENTIALITY.split(".")[0] + ".   ")
    n.font.size = Pt(7.5)
    n.font.color.rgb = B.MUTED
    foot.add_run("\t\t")
    for text, instruction in (("Page ", "PAGE"), (" of ", "NUMPAGES")):
        label = foot.add_run(text)
        label.font.size = Pt(7.5)
        label.font.color.rgb = B.MUTED
        field(foot, instruction).font.size = Pt(7.5)


def scan_cases(lines):
    """
    Pull every case, with its priority and status, for the index.

    Read from the same headings and metadata rows the evidence generator parses,
    so the index cannot list a case the specification does not define.
    """
    cases = []
    for i, line in enumerate(lines):
        s = line.strip()
        if not s.startswith("### "):
            continue
        m = CASE_HEADING.match(s[4:].strip())
        if not m:
            continue
        entry = {"id": m.group(1), "title": m.group(2),
                 "priority": "", "status": "", "type": ""}
        for probe in lines[i + 1:i + 16]:
            p = probe.strip()
            if p.startswith("### ") or p.startswith("## "):
                break
            if not p.startswith("|"):
                continue
            parts = [c.strip() for c in p.strip("|").split("|")]
            if len(parts) < 2:
                continue
            key = re.sub(r"[*`]", "", parts[0]).strip().lower()
            val = re.sub(r"[*`]", "", parts[1]).strip()
            if key in entry and not entry[key]:
                entry[key] = plain_status(val) if key == "status" else val
        cases.append(entry)
    return cases


def case_index(doc, cases):
    h1(doc, "Case index")
    automated = sum(1 for c in cases if "AUTOMATED" in c["status"].upper())
    paragraph(
        doc,
        f"{len(cases)} cases across the Employee Calendar, Manager Approval and "
        f"the shared rule modules. {automated} are automated end to end and "
        f"{len(cases) - automated} are specified and pending. Each is set out in "
        f"full in the pages that follow, with the record-level assertion that "
        f"decides it.")

    t = doc.add_table(rows=1, cols=4)
    t.style = "Table Grid"
    for i, head in enumerate(("Case", "Title", "Pri", "Status")):
        shade(t.rows[0].cells[i], B.HEADER_FILL)
        cell_rich(t.rows[0].cells[i], head, bold=True, colour=WHITE)
    for c in cases:
        cells = t.add_row().cells
        cell_rich(cells[0], f"`{c['id']}`", bold=True)
        cell_rich(cells[1], c["title"])
        cell_rich(cells[2], c["priority"], bold=True,
                  colour=priority_colour(c["priority"]))
        colour, fill = status_colour(c["status"])
        if fill:
            shade(cells[3], fill)
        cell_rich(cells[3], c["status"], bold=True, colour=colour)
    widths = (0.95, 3.35, 0.5, 1.6)
    for i, w in enumerate(widths):
        for row in t.rows:
            row.cells[i].width = Inches(w)
    doc.add_paragraph().paragraph_format.space_after = Pt(6)


def cover(doc, cases):
    wordmark(doc, space_after=26)

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(2)
    run = p.add_run(f"{B.PRODUCT}  \u00b7  {DOC_KIND}")
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
        "What each case exercises, what it expects, and how the result is "
        "verified against the record rather than the screen."
    )
    run.font.size = Pt(13)
    run.font.color.rgb = B.INK

    automated = sum(1 for c in cases if "AUTOMATED" in c["status"].upper())
    facts = [
        ("Document", f"{DOC_KIND} v{VERSION}"),
        ("Application", f"{B.PRODUCT} \u2014 {B.SCOPE}"),
        ("Coverage", f"{len(cases)} cases \u2014 {automated} automated, "
                     f"{len(cases) - automated} pending"),
        ("Under test", "Employee Calendar, Manager Approval, and the three "
                       "shared rule modules"),
        ("Evidence", "Dual proof \u2014 what the screen showed and what the "
                     "record holds"),
        ("Verification", "Every state change asserted against the record, "
                         "independently of the screen"),
    ]
    t = doc.add_table(rows=0, cols=2)
    t.style = "Table Grid"
    for label, value in facts:
        row = t.add_row()
        shade(row.cells[0], B.LABEL_FILL)
        cell_rich(row.cells[0], label, bold=True, colour=B.DEEP)
        cell_rich(row.cells[1], value)
    t.columns[0].width = Inches(1.6)
    t.columns[1].width = Inches(4.8)

    doc.add_paragraph().paragraph_format.space_after = Pt(14)
    p = doc.add_paragraph()
    add_runs(p,
             "This document is rendered from the test case source file and is "
             "read-only. The source is parsed directly by the evidence "
             "generator when a case runs, so a produced evidence record cannot "
             "claim an expected result this specification does not contain.",
             size=Pt(10), colour=B.MUTED)
    p.paragraph_format.space_after = Pt(6)

    p = doc.add_paragraph()
    add_runs(p, B.TAGLINE, size=Pt(10), colour=B.ORANGE)

    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


# --------------------------------------------------------------------------
# The markdown reader
# --------------------------------------------------------------------------

def split_row(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def is_block_start(s):
    return (not s) or s.startswith(BLOCK_STARTERS) or bool(ORDERED.match(s))


def fold(lines, i, *, strip_prefix=0):
    """
    Gather a hard-wrapped paragraph into one string.

    The source wraps prose at column ~78; Word does its own wrapping, so the
    line breaks have to be undone or every line becomes its own paragraph.
    """
    parts = [lines[i].strip()[strip_prefix:].strip()]
    i += 1
    while i < len(lines) and not is_block_start(lines[i].strip()):
        parts.append(lines[i].strip())
        i += 1
    return " ".join(p for p in parts if p), i


def render(doc, lines):
    i = 0
    # Set while inside a suppressed field (see DROP_SECTIONS); cleared by the
    # next field marker or heading, so only that field's body is dropped.
    skipping = False

    while i < len(lines):
        line = lines[i]
        s = line.strip()

        if s.startswith(("#", "|", "```")) or TABLE_DIVIDER.match(s):
            skipping = False

        if skipping and s and not s.startswith("**"):
            i += 1
            continue

        if s.startswith("```"):
            i += 1
            block = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                block.append(lines[i].rstrip("\n"))
                i += 1
            i += 1
            code(doc, block)
            continue

        if s.startswith("|") and i + 1 < len(lines) and TABLE_DIVIDER.match(lines[i + 1].strip()):
            headers = split_row(s)
            i += 2
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(split_row(lines[i].strip()))
                i += 1
            if all(not h for h in headers):
                meta_table(doc, rows)
            else:
                grid(doc, headers, rows)
            continue

        if s.startswith(">"):
            parts = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                parts.append(lines[i].strip().lstrip(">").strip())
                i += 1
            body = " ".join(p for p in parts if p)
            if not any(marker in body for marker in DROP_QUOTES):
                note(doc, body)
            continue

        if s.startswith("### "):
            m = CASE_HEADING.match(s[4:].strip())
            if m:
                case_heading(doc, m.group(1), m.group(2))
            else:
                h1(doc, s[4:].strip())
            i += 1
            continue

        if s.startswith("## "):
            h1(doc, s[3:].strip())
            i += 1
            continue

        if s.startswith("# "):
            part_divider(doc, s[2:].strip())
            i += 1
            continue

        if s == "---":
            i += 1
            continue

        if s.startswith("- "):
            text, i = fold(lines, i, strip_prefix=2)
            bullet(doc, text)
            continue

        m = ORDERED.match(s)
        if m:
            text, i = fold(lines, i, strip_prefix=len(m.group(1)) + 2)
            paragraph(doc, f"{m.group(1)}.  {text}", indent=0.25)
            continue

        if not s:
            i += 1
            continue

        # A line that is nothing but a bold run is a field marker inside a case.
        bm = BOLD_ONLY.match(s)
        if bm:
            name = re.sub(r"[^a-z ]", "", clean(bm.group(1)).lower()).strip()
            skipping = any(d in name for d in DROP_SECTIONS)
            if not skipping:
                sub_label(doc, bm.group(1))
            i += 1
            continue

        text, i = fold(lines, i)
        paragraph(doc, text)


def strip_title(text):
    """Drop the H1 title; the cover carries it."""
    lines = text.split("\n")
    return lines[1:] if lines and lines[0].startswith("# ") else lines


def build():
    if not SOURCE.exists():
        raise SystemExit(f"source not found: {SOURCE}")

    lines = strip_title(SOURCE.read_text(encoding="utf-8"))
    cases = scan_cases(lines)

    doc = base_document()
    header_footer(doc)
    cover(doc, cases)
    case_index(doc, cases)
    render(doc, lines)
    doc.save(TARGET)
    return TARGET, len(cases)


if __name__ == "__main__":
    out, n = build()
    print(f"wrote {out}  ({n} cases indexed)")
