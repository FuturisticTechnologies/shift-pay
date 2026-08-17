"""
Build branded Word evidence records from a Playwright run.

    python generate_evidence.py                  # every case with a result
    python generate_evidence.py --only TC-SP-003 # just one, and no run summary

One .docx per executed test case, plus a run summary. The case definition comes
from TEST-CASES-SHIFTPAY.md; what happened comes from the run's JSON. Nothing is
retyped between the two, so a document cannot drift from either.

Requires python-docx. No other dependencies — image dimensions are read from the
PNG header directly rather than pulling in Pillow for four bytes.
"""

import argparse
import io
import json
import re
import struct
import sys

from pathlib import Path

# Windows consoles default to cp1252, which cannot encode the ⚠ this generator
# prints for an introduced-defect case — and a UnicodeEncodeError on a *log line*
# would abort a build that had otherwise succeeded.
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

import branding as B
from case_parser import parse_cases

HERE = Path(__file__).parent
TESTING = HERE.parent
DEFAULT_RESULTS = TESTING / "automation" / "results" / "cases"
DEFAULT_OUT = TESTING / "evidence-packs"
CASE_FILES = [TESTING / "TEST-CASES-SHIFTPAY.md"]

WHITE = RGBColor(0xFF, 0xFF, 0xFF)

MAX_TABLE_ROWS = 14
MAX_TABLE_COLS = 7
MAX_CELL_CHARS = 46
CONTENT_WIDTH_IN = 6.4
MAX_IMAGE_HEIGHT_IN = 6.6


# --------------------------------------------------------------------------
# Low-level docx helpers for the things python-docx has no API for
# --------------------------------------------------------------------------

ANSI = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def clean(text):
    """
    Make a string safe to put in a Word document.

    Playwright's failure messages carry ANSI colour codes, and OOXML rejects
    control characters outright — so without this an otherwise perfect evidence
    pack fails to build on the one thing it most needs to report: a test failure.
    Three of the nine cases here are expected to fail, so this is load-bearing.
    """
    if text is None:
        return ""
    return CONTROL.sub("", ANSI.sub("", str(text))).strip()


def _field(paragraph, instruction):
    """Insert a Word field (PAGE, NUMPAGES) that recalculates on open."""
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


def _shade(cell, fill_hex):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill_hex)
    tc_pr.append(shd)


def _cell_text(cell, text, *, bold=False, size=B.SIZE_SMALL, colour=B.INK, mono=False):
    cell.text = ""
    p = cell.paragraphs[0]
    p.paragraph_format.space_before = Pt(2)
    p.paragraph_format.space_after = Pt(2)
    run = p.add_run(clean(text))
    run.bold = bold
    run.font.size = size
    run.font.color.rgb = colour
    run.font.name = B.MONO_FONT if mono else B.BODY_FONT
    return p


def _png_size(path):
    """Width and height from a PNG header, without a third-party imaging library."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(24)
        if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n":
            return None
        return struct.unpack(">II", head[16:24])
    except OSError:
        return None


def _rule(doc, colour=B.RULE, space_after=6):
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


# --------------------------------------------------------------------------
# Document furniture
# --------------------------------------------------------------------------

def _base_document():
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


def _heading(doc, text, size=B.SIZE_H1, colour=B.DEEP, space_before=14, space_after=4):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(space_before)
    p.paragraph_format.space_after = Pt(space_after)
    p.paragraph_format.keep_with_next = True
    run = p.add_run(clean(text))
    run.bold = True
    run.font.size = size
    run.font.color.rgb = colour
    return p


def _body(doc, text, *, size=B.SIZE_BODY, colour=B.INK, italic=False, space_after=4, bullet=False):
    p = doc.add_paragraph(style="List Bullet" if bullet else None)
    p.paragraph_format.space_after = Pt(space_after)
    run = p.add_run(clean(text))
    run.font.size = size
    run.font.color.rgb = colour
    run.italic = italic
    return p


def _wordmark(doc, width_in=1.7, space_after=24):
    """The logo, or a typographic fallback when no asset has been supplied."""
    logo = B.logo_path()
    if logo:
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT
        p.add_run().add_picture(str(logo), width=Inches(width_in))
        p.paragraph_format.space_after = Pt(space_after)
        return

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(2)
    run = p.add_run(B.COMPANY.upper())
    run.bold = True
    run.font.size = Pt(13)
    run.font.color.rgb = B.BLUE
    # Letter-spacing is not exposed by python-docx; the XML attribute is.
    rPr = run._r.get_or_add_rPr()
    spacing = OxmlElement("w:spacing")
    spacing.set(qn("w:val"), "60")
    rPr.append(spacing)
    _rule(doc, space_after=space_after)


def _header_footer(doc, case_id, title):
    section = doc.sections[0]
    section.different_first_page_header_footer = True

    header = section.header.paragraphs[0]
    header.text = ""
    header.paragraph_format.space_after = Pt(4)
    run = header.add_run(clean(f"{case_id}   ·   {title}"))
    run.font.size = B.SIZE_SMALL
    run.font.color.rgb = B.BLUE
    run.bold = True
    header.add_run("\t\t")
    tail = header.add_run(f"{B.PRODUCT} {B.DOC_KIND}")
    tail.font.size = B.SIZE_SMALL
    tail.font.color.rgb = B.MUTED

    footer = section.footer.paragraphs[0]
    footer.text = ""
    note = footer.add_run(B.CONFIDENTIALITY.split(".")[0] + ".   ")
    note.font.size = Pt(7.5)
    note.font.color.rgb = B.MUTED
    footer.add_run("\t\t")
    # Auto-updating, so a document that grows never carries a wrong page count.
    for text, field in (("Page ", "PAGE"), (" of ", "NUMPAGES")):
        label = footer.add_run(text)
        label.font.size = Pt(7.5)
        label.font.color.rgb = B.MUTED
        _field(footer, field).font.size = Pt(7.5)


def _warning_banner(doc, text):
    """
    The provenance banner for a deliberately introduced defect.

    Above the verdict, in the accent colour, and unmissable. A reader must not be
    able to mistake a demonstration prop for a genuine finding — that is the same
    failure mode as a retyped expected result, and it would discredit the two
    real findings sitting beside it.
    """
    table = doc.add_table(rows=1, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    cell = table.rows[0].cells[0]
    _shade(cell, "FDF0E9")
    para = _cell_text(cell, f"⚠  {text}", bold=True, size=Pt(9.5), colour=B.ORANGE)
    para.paragraph_format.space_before = Pt(5)
    para.paragraph_format.space_after = Pt(5)
    doc.add_paragraph().paragraph_format.space_after = Pt(6)


def _cover(doc, case_def, result, run_meta):
    verdict = result.get("verdict", "NOT RUN")

    _wordmark(doc, space_after=26)

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(2)
    run = p.add_run(f"{B.PRODUCT}  ·  {B.DOC_KIND}")
    run.font.size = Pt(10)
    run.font.color.rgb = B.BLUE
    run.bold = True

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(4)
    run = p.add_run(case_def.get("id", result["id"]))
    run.bold = True
    run.font.size = B.SIZE_TITLE
    run.font.color.rgb = B.DEEP

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(18)
    run = p.add_run(case_def.get("title") or result.get("title", ""))
    run.font.size = Pt(14)
    run.font.color.rgb = B.INK

    if case_def.get("warning"):
        _warning_banner(doc, case_def["warning"])

    # Verdict badge — the first thing anyone opening this looks for.
    badge = doc.add_table(rows=1, cols=1)
    badge.alignment = WD_TABLE_ALIGNMENT.LEFT
    badge.columns[0].width = Inches(2.5)
    cell = badge.rows[0].cells[0]
    _shade(cell, B.VERDICT_FILL.get(verdict, "EEF0F3"))
    para = _cell_text(cell, f"RESULT:  {verdict}", bold=True, size=Pt(13),
                      colour=B.VERDICT_COLOURS.get(verdict, B.MUTED))
    para.paragraph_format.space_before = Pt(6)
    para.paragraph_format.space_after = Pt(6)
    doc.add_paragraph().paragraph_format.space_after = Pt(10)

    if result.get("verdictReason"):
        _body(doc, result["verdictReason"], size=Pt(10), colour=B.INK, space_after=16)

    facts = [
        ("Test case", case_def.get("id", result["id"])),
        ("Priority", case_def.get("priority") or "—"),
        ("Type", case_def.get("type") or "—"),
        ("Component under test", case_def.get("component") or "—"),
        ("Application", f"{B.PRODUCT} — {B.SCOPE}"),
        ("Environment", run_meta.get("instance", "—")),
        ("Executed by", run_meta.get("executedBy", "—")),
        ("Execution method", run_meta.get("executedVia", "—")),
        ("Specification", case_def.get("source", "—")),
    ]
    table = doc.add_table(rows=0, cols=2)
    table.style = "Table Grid"
    for label, value in facts:
        row = table.add_row()
        _shade(row.cells[0], B.LABEL_FILL)
        _cell_text(row.cells[0], label, bold=True, colour=B.DEEP)
        _cell_text(row.cells[1], value)
    table.columns[0].width = Inches(1.9)
    table.columns[1].width = Inches(4.5)

    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


def _record_table(doc, dump):
    rows = dump.get("rows") or []
    _body(doc, dump["label"], size=Pt(10), colour=B.DEEP, space_after=1)
    meta = f"{dump.get('table', '')}"
    if dump.get("query"):
        meta += f"   ·   {dump['query']}"
    p = _body(doc, meta, size=Pt(8), colour=B.MUTED, space_after=3)
    p.runs[0].font.name = B.MONO_FONT

    if not rows:
        _body(doc, "No rows returned.", size=B.SIZE_SMALL, colour=B.MUTED, italic=True, space_after=10)
        return

    columns = list(rows[0].keys())[:MAX_TABLE_COLS]
    shown = rows[:MAX_TABLE_ROWS]

    table = doc.add_table(rows=1, cols=len(columns))
    table.style = "Table Grid"
    for i, col in enumerate(columns):
        _shade(table.rows[0].cells[i], B.HEADER_FILL)
        _cell_text(table.rows[0].cells[i], col, bold=True, size=Pt(8), colour=WHITE, mono=True)

    for r in shown:
        cells = table.add_row().cells
        for i, col in enumerate(columns):
            value = str(r.get(col, ""))
            if len(value) > MAX_CELL_CHARS:
                value = value[: MAX_CELL_CHARS - 1] + "…"
            _cell_text(cells[i], value, size=Pt(8), mono=True)

    footnotes = []
    if len(rows) > MAX_TABLE_ROWS:
        footnotes.append(f"{len(rows) - MAX_TABLE_ROWS} further row(s) not shown")
    if len(rows[0].keys()) > MAX_TABLE_COLS:
        footnotes.append(f"{len(rows[0].keys()) - MAX_TABLE_COLS} further column(s) not shown")
    if footnotes:
        _body(doc, "; ".join(footnotes) + ". Full data in the run JSON.",
              size=Pt(7.5), colour=B.MUTED, italic=True, space_after=10)
    else:
        doc.add_paragraph().paragraph_format.space_after = Pt(6)


def _add_screenshot(doc, image_path):
    path = Path(image_path)
    if not path.exists():
        _body(doc, f"[screenshot missing: {path.name}]", size=B.SIZE_SMALL, colour=B.MUTED, italic=True)
        return

    width = CONTENT_WIDTH_IN
    size = _png_size(path)
    if size:
        px_w, px_h = size
        # Full-page portal captures are tall; scaled to content width they would
        # run off the page, so height is the binding constraint.
        if px_w and (px_h / px_w) * width > MAX_IMAGE_HEIGHT_IN:
            width = MAX_IMAGE_HEIGHT_IN * (px_w / px_h)

    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(4)
    p.paragraph_format.space_after = Pt(2)
    p.add_run().add_picture(str(path), width=Inches(width))

    caption = doc.add_paragraph()
    caption.alignment = WD_ALIGN_PARAGRAPH.CENTER
    caption.paragraph_format.space_after = Pt(10)
    run = caption.add_run(f"Screen capture — {path.name}")
    run.font.size = Pt(7.5)
    run.font.color.rgb = B.MUTED
    run.italic = True


# --------------------------------------------------------------------------
# The case document
# --------------------------------------------------------------------------

def build_case_document(case_def, result, run_meta, out_path):
    doc = _base_document()
    _header_footer(doc, result["id"], case_def.get("title") or result.get("title", ""))
    _cover(doc, case_def, result, run_meta)

    if case_def.get("narrative"):
        _heading(doc, "Purpose", space_before=0)
        for line in case_def["narrative"]:
            _body(doc, line)

    if case_def.get("precondition"):
        _heading(doc, "Preconditions")
        for line in case_def["precondition"]:
            _body(doc, line, bullet=True)

    # Expected first, then what happened — the order a reviewer reads in, and it
    # stops the actual result framing the expectation after the fact.
    _heading(doc, "Expected result")
    expected = result.get("expected") or case_def.get("expected") or ["Not recorded."]
    for line in expected:
        _body(doc, line, bullet=True)

    _heading(doc, "Steps executed")
    steps = result.get("steps") or []
    if not steps:
        for line in case_def.get("steps", []) or ["Not recorded."]:
            _body(doc, line, bullet=True)
    else:
        for step in steps:
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(6)
            p.paragraph_format.space_after = Pt(2)
            p.paragraph_format.keep_with_next = True
            n = p.add_run(f"Step {step['n']}   ")
            n.bold = True
            n.font.color.rgb = B.BLUE
            n.font.size = B.SIZE_H2
            t = p.add_run(clean(step["text"]))
            t.font.size = B.SIZE_BODY
            for shot in step.get("screenshots", []):
                _add_screenshot(doc, shot)

    _heading(doc, "Actual result")
    for line in result.get("actual") or ["Not recorded."]:
        _body(doc, line, bullet=True)

    if result.get("records"):
        _heading(doc, "Record evidence")
        _body(
            doc,
            "Read directly from the ServiceNow Table API during execution. This is the evidence that "
            "determines the verdict; a screen capture shows what was displayed, not what was stored.",
            size=Pt(9), colour=B.MUTED, italic=True, space_after=8,
        )
        for dump in result["records"]:
            _record_table(doc, dump)

    if result.get("observations"):
        _heading(doc, "Observations")
        for line in result["observations"]:
            _body(doc, line, bullet=True)

    # Supporting commentary from the specification — why the case exists, what
    # the fix is, where a defect came from. Rendered under its own labels because
    # that is how it was written and how it reads.
    extras = case_def.get("extras") or {}
    if extras:
        _heading(doc, "From the specification")
        for label, lines in extras.items():
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(6)
            p.paragraph_format.space_after = Pt(1)
            p.paragraph_format.keep_with_next = True
            run = p.add_run(clean(label))
            run.bold = True
            run.font.size = B.SIZE_H2
            run.font.color.rgb = B.BLUE
            for line in lines:
                _body(doc, line, size=Pt(10))

    if case_def.get("verify"):
        _heading(doc, "How to verify by hand")
        for line in case_def["verify"]:
            p = _body(doc, line, size=Pt(9))
            p.runs[0].font.name = B.MONO_FONT

    if case_def.get("note"):
        _heading(doc, "Notes from the specification")
        for line in case_def["note"]:
            _body(doc, line, bullet=True)

    _heading(doc, "Verdict")
    verdict = result.get("verdict", "NOT RUN")
    table = doc.add_table(rows=1, cols=1)
    cell = table.rows[0].cells[0]
    _shade(cell, B.VERDICT_FILL.get(verdict, "EEF0F3"))
    _cell_text(cell, verdict, bold=True, size=Pt(12), colour=B.VERDICT_COLOURS.get(verdict, B.MUTED))
    if result.get("verdictReason"):
        _body(doc, result["verdictReason"], space_after=10)

    _rule(doc, space_after=4)
    _body(doc, B.CONFIDENTIALITY, size=Pt(7.5), colour=B.MUTED, italic=True)

    doc.save(out_path)
    return out_path


# --------------------------------------------------------------------------
# The run summary
# --------------------------------------------------------------------------

def build_summary_document(cases, results, run_meta, out_path):
    doc = _base_document()
    _header_footer(doc, "RUN SUMMARY", f"{B.PRODUCT} — test execution")

    _wordmark(doc)

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(4)
    run = p.add_run("Test Execution Summary")
    run.bold = True
    run.font.size = B.SIZE_TITLE
    run.font.color.rgb = B.DEEP

    _body(doc, f"{B.PRODUCT} — Service Portal widgets", size=Pt(13), space_after=18)

    counts = {}
    for r in results:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1

    facts = [
        ("Environment", run_meta.get("instance", "—")),
        ("Executed by", run_meta.get("executedBy", "—")),
        ("Execution method", run_meta.get("executedVia", "—")),
        ("Cases executed", str(len(results))),
        ("Passed", str(counts.get("PASS", 0))),
        ("Failed", str(counts.get("FAIL", 0))),
        ("Blocked", str(counts.get("BLOCKED", 0))),
    ]
    table = doc.add_table(rows=0, cols=2)
    table.style = "Table Grid"
    for label, value in facts:
        row = table.add_row()
        _shade(row.cells[0], B.LABEL_FILL)
        _cell_text(row.cells[0], label, bold=True, colour=B.DEEP)
        colour = B.VERDICT_COLOURS["FAIL"] if label == "Failed" and value != "0" else B.INK
        _cell_text(row.cells[1], value, colour=colour, bold=(label == "Failed" and value != "0"))
    table.columns[0].width = Inches(1.9)
    table.columns[1].width = Inches(4.5)

    _heading(doc, "Results")
    grid = doc.add_table(rows=1, cols=4)
    grid.style = "Table Grid"
    for i, head in enumerate(["Case", "Title", "Priority", "Result"]):
        _shade(grid.rows[0].cells[i], B.HEADER_FILL)
        _cell_text(grid.rows[0].cells[i], head, bold=True, size=Pt(9), colour=WHITE)

    for r in sorted(results, key=lambda x: x["id"]):
        definition = cases.get(r["id"], {})
        cells = grid.add_row().cells
        _cell_text(cells[0], r["id"], bold=True, size=Pt(9), colour=B.BLUE)
        title = definition.get("title") or r.get("title", "")
        if definition.get("warning"):
            title += "  (introduced defect)"
        _cell_text(cells[1], title, size=Pt(9))
        _cell_text(cells[2], definition.get("priority", "—"), size=Pt(9))
        _shade(cells[3], B.VERDICT_FILL.get(r["verdict"], "EEF0F3"))
        _cell_text(cells[3], r["verdict"], bold=True, size=Pt(9),
                   colour=B.VERDICT_COLOURS.get(r["verdict"], B.MUTED))
    grid.columns[0].width = Inches(1.0)
    grid.columns[1].width = Inches(3.5)
    grid.columns[2].width = Inches(0.7)
    grid.columns[3].width = Inches(1.0)

    failures = [r for r in results if r["verdict"] == "FAIL"]
    if failures:
        _heading(doc, "Failures requiring attention")
        for r in failures:
            definition = cases.get(r["id"], {})
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(8)
            p.paragraph_format.space_after = Pt(2)
            run = p.add_run(clean(f"{r['id']} — {definition.get('title') or r.get('title', '')}"))
            run.bold = True
            run.font.color.rgb = B.VERDICT_COLOURS["FAIL"]
            run.font.size = B.SIZE_H2
            if definition.get("warning"):
                note = _body(doc, f"⚠ {definition['warning']}", size=Pt(9), colour=B.ORANGE, space_after=3)
                note.runs[0].bold = True
            if r.get("verdictReason"):
                _body(doc, r["verdictReason"], space_after=3)
            for obs in r.get("observations", []):
                _body(doc, obs, size=Pt(9.5), bullet=True, space_after=2)

    _rule(doc, space_after=4)
    _body(doc, B.CONFIDENTIALITY, size=Pt(7.5), colour=B.MUTED, italic=True)

    doc.save(out_path)
    return out_path


# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--results", default=str(DEFAULT_RESULTS), help="directory of per-case run JSON")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="output directory for the .docx pack")
    ap.add_argument(
        "--only",
        action="append",
        metavar="TC-SP-003",
        help="build just this case (repeatable). Suppresses the run summary, which would "
             "otherwise report one case as though it were the whole pack.",
    )
    args = ap.parse_args()

    results_dir = Path(args.results)
    if not results_dir.exists():
        sys.exit(f"No run results at {results_dir}. Run the Playwright cases first.")

    cases = parse_cases(*CASE_FILES)
    print(f"Parsed {len(cases)} case definition(s) from the specification.")

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    wanted = {c.upper() for c in (args.only or [])}
    results, run_meta = [], {}
    for jf in sorted(results_dir.glob("*.json")):
        payload = json.loads(jf.read_text(encoding="utf-8"))
        run_meta = payload.get("run", run_meta)
        case = payload["case"]
        if wanted and case["id"].upper() not in wanted:
            continue
        results.append(case)

    if not results:
        sys.exit(
            f"No case results found in {results_dir}"
            + (f" matching {', '.join(sorted(wanted))}." if wanted else ".")
        )

    locked = []

    def write(build, path, label):
        """
        Build a document, tolerating the one it is replacing being open in Word.

        A reviewer reading last run's pack holds a lock on that file. Aborting the
        whole build for it would be the wrong trade — the other documents are
        fine, and the skipped one is named at the end.
        """
        try:
            build(path)
            print(f"  [ok] {path.name}  {label}")
        except PermissionError:
            locked.append(path.name)
            print(f"  [locked] {path.name} is open in another program — not regenerated")

    for result in results:
        definition = cases.get(result["id"], {"id": result["id"], "title": result.get("title", "")})
        if result["id"] not in cases:
            print(f"  [!] {result['id']} has no definition in the specification — using the run's own title.")
        write(
            lambda p, d=definition, r=result: build_case_document(d, r, run_meta, p),
            out_dir / f"{result['id']}.docx",
            f"[{result['verdict']}]",
        )

    # A summary built from a single case would read as "1 case executed, 1
    # failed", which is true of the run and misleading about the pack.
    if not wanted:
        write(
            lambda p: build_summary_document(cases, results, run_meta, p),
            out_dir / "00-RUN-SUMMARY.docx",
            "",
        )

    if locked:
        print(f"\n  Close these in Word and re-run to refresh them: {', '.join(locked)}")

    if not B.logo_path():
        print("\n  Note: no logo found at evidence-generator/assets/ft-logo.png —")
        print("  the cover uses a typographic wordmark. Drop a PNG there and re-run to brand it.")

    print(f"\n{len(results)} evidence record(s) written to {out_dir}")


if __name__ == "__main__":
    main()
