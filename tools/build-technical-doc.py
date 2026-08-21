"""
Build the ShiftPay technical design document.

    python tools/build-technical-doc.py

Reads ShiftPay-Technical-Document.md at the repository root and writes
ShiftPay-Technical-Document.docx beside it.

The markdown is the source of record — edit it and re-run this, rather than
editing the .docx. That is why this is a renderer rather than a script with the
prose inlined: the Power BI builder took the other approach and its content now
lives only in Python, which is fine for a document nobody reviews in markdown
first, and wrong for this one.

Branding comes from testing/evidence-generator/branding.py — the same module the
test evidence packs and the Power BI document use, so all three document families
stay visually identical and a rebrand is still one file.

Supported markdown subset (everything the source document actually uses):
    # Part N — Title      part divider, starts a new page
    ## N. Title           numbered section heading
    ## Appendix X — T     unnumbered section heading
    ### N.N Title         subsection heading
    ``` fenced ```        monospaced block (the ASCII diagrams)
    | a | b |             table with a header row
    > quoted text         called-out note
    - bullet
    1. ordered item
    **bold**  `code`  *italic*   inline, anywhere above

Requires python-docx, which the test pack already depends on.
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

SOURCE = REPO / "ShiftPay-Technical-Document.md"
TARGET = REPO / "ShiftPay-Technical-Document.docx"

DOC_KIND = "Technical Design Document"
DOC_TITLE = "ShiftPay"
VERSION = "1.0"

CODE_FILL = "F4F6F8"
NOTE_FILL = "FDF1E0"
WHITE = RGBColor(0xFF, 0xFF, 0xFF)

CONFIDENTIALITY = (
    "Confidential. Prepared by Futuristic Technologies. "
    "Contains system design detail and must not be redistributed without written consent."
)

CONTENT_WIDTH = 6.4          # inches, inside the page margins
MONO_SIZE = Pt(7.5)          # the widest diagram is 77 characters


# --------------------------------------------------------------------------
# Layout helpers. A local copy rather than an import of the Power BI builder's
# functions — branding is the shared seam, the furniture is not.
# --------------------------------------------------------------------------

def shade(cell, fill_hex):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill_hex)
    tc_pr.append(shd)


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


# --------------------------------------------------------------------------
# Inline formatting
# --------------------------------------------------------------------------

# Bold is matched non-greedily rather than as "no asterisks inside", so a
# span like **No `x_shiftpay.*` property exists** still closes correctly.
INLINE = re.compile(r"(\*\*.+?\*\*|`[^`]+`|(?<!\*)\*(?!\*)[^*]+\*(?!\*))")


def add_runs(paragraph, text, *, size=B.SIZE_BODY, colour=B.INK,
             bold=False, italic=False):
    """
    Render one line of markdown inline formatting into a paragraph.

    Recursive, because the source nests: `**`$timeout` sequencing**` is a bold
    span containing a code span. A single non-recursive pass swallows the inner
    backticks and prints them literally.
    """
    for token in INLINE.split(text):
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
    p.paragraph_format.space_before = Pt(90)
    p.paragraph_format.space_after = Pt(4)
    label, _, title = text.partition("—")
    run = p.add_run(label.strip().upper())
    run.bold = True
    run.font.size = Pt(11)
    run.font.color.rgb = B.ORANGE
    rPr = run._r.get_or_add_rPr()
    spacing = OxmlElement("w:spacing")
    spacing.set(qn("w:val"), "60")
    rPr.append(spacing)

    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(10)
    run = p.add_run(title.strip() or label.strip())
    run.bold = True
    run.font.size = Pt(30)
    run.font.color.rgb = B.DEEP
    rule(doc, space_after=10)


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
    add_runs(p, text, size=B.SIZE_H2, colour=B.BLUE, bold=True)
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
    """A monospaced block in a shaded single-cell table, so it survives a reflow."""
    t = doc.add_table(rows=1, cols=1)
    t.alignment = WD_TABLE_ALIGNMENT.LEFT
    t.columns[0].width = Inches(CONTENT_WIDTH)
    cell = t.rows[0].cells[0]
    shade(cell, CODE_FILL)
    cell.text = ""
    p = cell.paragraphs[0]
    p.paragraph_format.space_before = Pt(4)
    p.paragraph_format.space_after = Pt(4)
    p.paragraph_format.line_spacing = 1.0
    for i, line in enumerate(lines):
        if i:
            p.add_run().add_break()
        run = p.add_run(line)
        run.font.name = B.MONO_FONT
        run.font.size = MONO_SIZE
        run.font.color.rgb = B.INK
    doc.add_paragraph().paragraph_format.space_after = Pt(4)
    return t


def note(doc, text):
    """A called-out paragraph for something that will bite if ignored."""
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

    # Column widths proportional to the longest cell in each column, so a
    # table of short codes does not get the same real estate as one of prose.
    weights = []
    for i in range(len(headers)):
        longest = max([len(headers[i])] + [len(r[i]) for r in rows if i < len(r)])
        weights.append(max(longest, 8))
    total = float(sum(weights))
    for i, w in enumerate(weights):
        width = Inches(max(0.65, CONTENT_WIDTH * w / total))
        for row in t.rows:
            row.cells[i].width = width
    doc.add_paragraph().paragraph_format.space_after = Pt(6)
    return t


# --------------------------------------------------------------------------
# Cover, header and footer
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
        "Shift logging, compensatory-off entitlement, approval workflow and "
        "pay computation \u2014 and the four interface components that expose them."
    )
    run.font.size = Pt(13)
    run.font.color.rgb = B.INK

    facts = [
        ("Document", f"{DOC_KIND} v{VERSION}"),
        ("Application", f"{B.PRODUCT} \u2014 {B.SCOPE}"),
        ("Interface", "4 components \u2014 6,222 lines of template, controller and stylesheet"),
        ("Business logic", "3 shared modules \u2014 availability, entitlement, aggregation"),
        ("Data model", "6 tables"),
        ("Quality", "40 documented cases, 9 automated"),
    ]
    t = doc.add_table(rows=0, cols=2)
    t.style = "Table Grid"
    for label, value in facts:
        row = t.add_row()
        shade(row.cells[0], B.LABEL_FILL)
        cell_rich(row.cells[0], label, bold=True, colour=B.DEEP)
        cell_rich(row.cells[1], value)
    t.columns[0].width = Inches(1.5)
    t.columns[1].width = Inches(4.9)

    doc.add_paragraph().paragraph_format.space_after = Pt(14)
    p = doc.add_paragraph()
    add_runs(
        p,
        "Part I records what the application does and the rules it enforces. "
        "Part II records how those rules are presented \u2014 the component "
        "contract, the AngularJS controllers, the SCSS architecture and the "
        "data visualisation layer. Part III covers configuration, quality "
        "assurance and conventions.",
        size=Pt(10),
        colour=B.MUTED,
    )
    p.paragraph_format.space_after = Pt(6)

    p = doc.add_paragraph()
    add_runs(p, B.TAGLINE, size=Pt(10), colour=B.ORANGE)

    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


# --------------------------------------------------------------------------
# The markdown reader
# --------------------------------------------------------------------------

SECTION_NUMBER = re.compile(r"^(\d+)\.\s+(.*)$")
TABLE_DIVIDER = re.compile(r"^\|[\s:\-|]+\|$")
ORDERED = re.compile(r"^(\d+)\.\s+(.*)$")
IMAGE = re.compile(r"^!\[([^\]]*)\]\(([^)]+)\)$")


def figure(doc, path_str, alt):
    """
    Place a rendered diagram at the full content width.

    The figure number and caption are drawn into the image itself, so the two
    can never drift apart the way a separately-typed caption would.
    """
    src = (REPO / path_str).resolve()
    if not src.exists():
        raise SystemExit(
            f"missing diagram: {path_str}\n"
            "run: python tools/diagrams/build-diagrams.py && node tools/diagrams/render.mjs"
        )
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(8)
    p.paragraph_format.space_after = Pt(12)
    p.add_run().add_picture(str(src), width=Inches(CONTENT_WIDTH))
    return p


def split_row(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def render(doc, lines):
    i = 0
    in_contents = False

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        # ---- figure ------------------------------------------------------
        m = IMAGE.match(stripped)
        if m:
            figure(doc, m.group(2), m.group(1))
            i += 1
            continue

        # ---- fenced code -------------------------------------------------
        if stripped.startswith("```"):
            i += 1
            block = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                block.append(lines[i].rstrip("\n"))
                i += 1
            i += 1
            while block and not block[0].strip():
                block.pop(0)
            while block and not block[-1].strip():
                block.pop()
            code(doc, block)
            continue

        # ---- table -------------------------------------------------------
        if stripped.startswith("|") and i + 1 < len(lines) and TABLE_DIVIDER.match(lines[i + 1].strip()):
            headers = split_row(stripped)
            i += 2
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(split_row(lines[i].strip()))
                i += 1
            grid(doc, headers, rows)
            continue

        # ---- blockquote --------------------------------------------------
        if stripped.startswith(">"):
            block = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                block.append(lines[i].strip().lstrip(">").strip())
                i += 1
            note(doc, " ".join(t for t in block if t))
            continue

        # ---- headings ----------------------------------------------------
        if stripped.startswith("# "):
            title = stripped[2:].strip()
            if title.lower().startswith("part "):
                part_divider(doc, title)
                in_contents = False
            i += 1
            continue

        if stripped.startswith("## "):
            title = stripped[3:].strip()
            if title.lower() == "contents":
                in_contents = True
                h1(doc, "Contents")
                i += 1
                continue
            in_contents = False
            m = SECTION_NUMBER.match(title)
            if m:
                h1(doc, m.group(2), m.group(1))
            else:
                h1(doc, title)
            i += 1
            continue

        if stripped.startswith("### "):
            h2(doc, stripped[4:].strip())
            i += 1
            continue

        # ---- horizontal rule ---------------------------------------------
        if stripped == "---":
            i += 1
            continue

        # ---- lists -------------------------------------------------------
        if stripped.startswith("- "):
            bullet(doc, stripped[2:].strip())
            i += 1
            continue

        m = ORDERED.match(stripped)
        if m:
            if in_contents:
                paragraph(doc, f"{m.group(1)}.  {m.group(2)}", indent=0.25)
            else:
                paragraph(doc, f"{m.group(1)}.  {m.group(2)}", indent=0.25)
            i += 1
            continue

        # ---- blank -------------------------------------------------------
        if not stripped:
            i += 1
            continue

        # ---- paragraph ---------------------------------------------------
        paragraph(doc, stripped, indent=0.25 if in_contents else 0.0)
        i += 1


def strip_front_matter(text):
    """
    Drop the title and the metadata block the cover page already carries.

    Everything up to and including the first horizontal rule is cover material;
    the document body starts at the Contents heading.
    """
    lines = text.split("\n")
    for idx, line in enumerate(lines):
        if line.strip() == "---":
            return lines[idx + 1:]
    return lines


def build():
    if not SOURCE.exists():
        raise SystemExit(f"source not found: {SOURCE}")

    doc = base_document()
    header_footer(doc)
    cover(doc)
    render(doc, strip_front_matter(SOURCE.read_text(encoding="utf-8")))
    doc.save(TARGET)
    return TARGET


if __name__ == "__main__":
    out = build()
    print(f"wrote {out}")
