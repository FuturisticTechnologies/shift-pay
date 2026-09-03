"""Build the four-slide ShiftPay status deck.

Numbers are read from Project Management/shiftpay-jira-import.csv rather than
typed in, so the deck cannot drift from the board it describes. Palette and
fonts follow testing/evidence-generator/branding.py, so the deck matches the
Word evidence records.
"""
import csv
import collections
from pathlib import Path

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE

ROOT = Path(__file__).resolve().parent.parent
BOARD = ROOT / "Project Management" / "shiftpay-jira-import.csv"
OUT = ROOT / "Project Management" / "ShiftPay-Status-Deck.pptx"

# --- house palette (branding.py) -------------------------------------------
BLUE = RGBColor(0x00, 0x60, 0x96)
DEEP = RGBColor(0x00, 0x36, 0x54)
ORANGE = RGBColor(0xF7, 0x66, 0x2D)
INK = RGBColor(0x1A, 0x1A, 0x1A)
MUTED = RGBColor(0x60, 0x66, 0x76)
RULE = RGBColor(0xD5, 0xD9, 0xE0)
TINT = RGBColor(0xF2, 0xF5, 0xF8)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
GREEN = RGBColor(0x0B, 0x6B, 0x3A)
RED = RGBColor(0xA8, 0x18, 0x45)
AMBER = RGBColor(0xB2, 0x6A, 0x00)
FONT = "Calibri"

W, H = Inches(13.333), Inches(7.5)


# --- board facts ------------------------------------------------------------
def load():
    rows = list(csv.DictReader(BOARD.open(encoding="utf-8")))
    f = {
        "total": len(rows),
        "type": collections.Counter(r["Work Type"] for r in rows),
        "status": collections.Counter(r["Status"] for r in rows),
        "done": sum(1 for r in rows if r["Status"] == "Done"),
        "people": sorted({r["Assignee"] for r in rows}),
    }
    return rows, f


TEAM = [
    ("Geetha Nallamada", "Sr Data Analyst", "Requirements, reporting design, sign-off"),
    ("Shashank Shukla", "IT Consultant", "Platform, Script Includes, deployment"),
    ("Rucha Joshi", "UI Developer", "Service Portal widgets"),
    ("Divya Maram", "Data Analyst", "Data model, catalogue semantics, measures"),
    ("Neha Chauhan", "QA Analyst", "Test pack and evidence records"),
    ("Swopneel", "SDET", "Harness, CI and contract tests · 1 May – 25 Aug"),
]

SPRINTS = [
    ("Pre-build", "01–29 May", "Test engineering first: harness, nightly pipeline, contract tests"),
    ("Sprint 1", "08–19 Jun", "Foundations: requirements signed off, landing page, month grid"),
    ("Sprint 2", "22 Jun–03 Jul", "Day writes, bulk apply, data-driven catalogue semantics"),
    ("Sprint 3", "06–17 Jul", "Shared rule layer extracted, month lock, deployment path"),
    ("Sprint 4", "20–31 Jul", "Manager approval queue, calendar rules, test harness"),
    ("Sprint 5", "03–14 Aug", "Day correction with audit, Power BI model, evidence generator"),
    ("Sprint 6", "17–28 Aug", "History tab, money guard, reporting pages, metadata sweep"),
    ("Sprint 7", "31 Aug–11 Sep", "Instance retarget, generated documents, handover"),
]

DELIVERABLES = [
    ("Service Portal widgets", [
        "Employee calendar — log a day, see CO entitlement, submit and lock a month",
        "Manager approvals — queue, bulk actions, day correction with audit, history",
        "Landing page — entry point for both journeys",
    ]),
    ("Shared rule layer", [
        "Aggregator — weekly and monthly pay against a rate snapshot",
        "Entitlements — compensatory-off lifecycle over a seven-weekday window",
        "Calendar rules — catalogue, holidays, which shifts a user may log",
    ]),
    ("Reporting and assurance", [
        "Power BI — read-only, money from the snapshot, never live rates",
        "Test pack — harness and CI from May, 40 cases, 9 automated, Word evidence",
        "Documents — requirements, technical design, test cases, setup runbook",
    ]),
]

ROADMAP = [
    ("Now — in flight", AMBER, [
        "SP-58 weekend catalogue fix, prepared and awaiting a verified re-run",
        "SP-57 P1: server refusals invisible, calendar repaints as success",
        "SP-59 · SP-60 · SP-61 open findings held on the board, not hidden",
    ]),
    ("Next — to 11 Sep", BLUE, [
        "Close the P1 and re-run the pack to confirm the case turns green",
        "SP-76 handover session: widget contract, rule layer, deployment traps",
        "Final document regeneration from source for the handover pack",
    ]),
    ("Later — phase two", MUTED, [
        "Approval audit table so a resubmission cannot erase a rejection",
        "Table ACLs, payroll export, scheduled dataset refresh",
        "Half-day support and responsive calendar — needs a requirements change",
    ]),
]


# --- drawing helpers --------------------------------------------------------
def textbox(slide, x, y, w, h, anchor=MSO_ANCHOR.TOP):
    tb = slide.shapes.add_textbox(x, y, w, h)
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    return tf


def para(tf, text, size, color, bold=False, space_after=4, first=False, align=None):
    p = tf.paragraphs[0] if first else tf.add_paragraph()
    p.text = text
    p.space_after = Pt(space_after)
    if align is not None:
        p.alignment = align
    for r in p.runs:
        r.font.name = FONT
        r.font.size = Pt(size)
        r.font.bold = bold
        r.font.color.rgb = color
    return p


def rect(slide, x, y, w, h, fill, line=None, shape=MSO_SHAPE.RECTANGLE):
    s = slide.shapes.add_shape(shape, x, y, w, h)
    s.fill.solid()
    s.fill.fore_color.rgb = fill
    if line is None:
        s.line.fill.background()
    else:
        s.line.color.rgb = line
        s.line.width = Pt(0.75)
    s.shadow.inherit = False
    return s


def slide_frame(prs, title, kicker):
    """Blank slide with the standing header: deep band, kicker, title, rule."""
    s = prs.slides.add_slide(prs.slide_layouts[6])
    rect(s, 0, 0, W, Inches(0.16), DEEP)
    tf = textbox(s, Inches(0.7), Inches(0.5), Inches(11.9), Inches(0.3))
    para(tf, kicker.upper(), 10.5, ORANGE, bold=True, first=True)
    tf = textbox(s, Inches(0.7), Inches(0.82), Inches(11.9), Inches(0.5))
    para(tf, title, 27, DEEP, bold=True, first=True)
    rect(s, Inches(0.7), Inches(1.42), Inches(1.1), Pt(2.5), ORANGE)
    return s


def stat(slide, x, y, w, value, label, color=BLUE):
    rect(slide, x, y, w, Inches(1.02), TINT)
    tf = textbox(slide, x + Inches(0.22), y + Inches(0.12), w - Inches(0.44), Inches(0.45))
    para(tf, value, 25, color, bold=True, first=True)
    tf = textbox(slide, x + Inches(0.22), y + Inches(0.62), w - Inches(0.44), Inches(0.3))
    para(tf, label, 9.5, MUTED, first=True)


def footer(slide, n):
    tf = textbox(slide, Inches(0.7), Inches(6.95), Inches(9.0), Inches(0.3))
    para(tf, "ShiftPay · ServiceNow scoped application · status as at 3 September 2026",
         9, MUTED, first=True)
    tf = textbox(slide, Inches(11.9), Inches(6.95), Inches(0.73), Inches(0.3))
    para(tf, str(n), 9, MUTED, first=True, align=PP_ALIGN.RIGHT)


# --- slides -----------------------------------------------------------------
def slide_overview(prs, f):
    s = slide_frame(prs, "ShiftPay", "Project overview")
    tf = textbox(s, Inches(0.7), Inches(1.62), Inches(11.9), Inches(0.4))
    para(tf, "Shift logging, compensatory-off entitlement and pay computation, "
             "delivered as a scoped ServiceNow application.", 13.5, MUTED, first=True)

    x, gap, w = Inches(0.7), Inches(0.22), Inches(2.83)
    stat(s, x, Inches(2.25), w, str(f["total"]), "work items on the board")
    stat(s, x + w + gap, Inches(2.25), w, str(f["done"]), "delivered and closed", GREEN)
    stat(s, x + 2 * (w + gap), Inches(2.25), w, "7", "two-week sprints")
    stat(s, x + 3 * (w + gap), Inches(2.25), w, str(len(f["people"])), "people across six disciplines")

    tf = textbox(s, Inches(0.7), Inches(3.62), Inches(6.0), Inches(2.9))
    para(tf, "What it does", 13, DEEP, bold=True, first=True, space_after=7)
    for b in [
        "An employee logs one shift per day, sees what a compound on-call shift "
        "entitles them to, and submits the month for approval.",
        "A manager reviews a reportee's month, corrects a single day with a "
        "recorded reason, and approves or rejects singly or in bulk.",
        "Pay is aggregated weekly and monthly against a rate captured at compute "
        "time, so a later rate change cannot rewrite history.",
        "A read-only Power BI layer reports over the same tables and reimplements "
        "no shift or pay rule.",
    ]:
        para(tf, "— " + b, 11, INK, space_after=8)

    bx = Inches(7.1)
    rect(s, bx, Inches(3.55), Inches(5.53), Inches(2.62), TINT)
    tf = textbox(s, bx + Inches(0.28), Inches(3.75), Inches(5.0), Inches(0.3))
    para(tf, "Team", 12, DEEP, bold=True, first=True, space_after=8)
    for name, role, scope in TEAM:
        p = para(tf, name + "  ·  " + role, 10.5, INK, bold=True, space_after=1)
        para(tf, scope, 9.5, MUTED, space_after=7)
    footer(s, 1)


def slide_plan(prs, f):
    s = slide_frame(prs, "Delivery plan", "How the work was sequenced")
    tf = textbox(s, Inches(0.7), Inches(1.62), Inches(11.9), Inches(0.4))
    para(tf, "A pre-build phase from 1 May, then seven two-week sprints to 11 September 2026. "
             "Scope was fixed at each boundary and nothing was closed to flatter the board.",
         12.5, MUTED, first=True)

    y = Inches(2.24)
    row_h = Inches(0.52)
    for i, (name, dates, focus) in enumerate(SPRINTS):
        done = i < 7
        rect(s, Inches(0.7), y, Inches(11.93), row_h - Inches(0.09),
             TINT if i % 2 == 0 else WHITE)
        rect(s, Inches(0.7), y, Pt(3.5), row_h - Inches(0.09), GREEN if done else ORANGE)
        tf = textbox(s, Inches(0.95), y + Inches(0.12), Inches(1.3), Inches(0.3))
        para(tf, name, 11.5, DEEP, bold=True, first=True)
        tf = textbox(s, Inches(2.25), y + Inches(0.13), Inches(1.7), Inches(0.3))
        para(tf, dates, 10.5, MUTED, first=True)
        tf = textbox(s, Inches(4.05), y + Inches(0.13), Inches(7.0), Inches(0.3))
        para(tf, focus, 10.5, INK, first=True)
        tf = textbox(s, Inches(11.2), y + Inches(0.13), Inches(1.25), Inches(0.3))
        para(tf, "Complete" if done else "In progress", 10, GREEN if done else AMBER,
             bold=True, first=True, align=PP_ALIGN.RIGHT)
        y += row_h

    tf = textbox(s, Inches(0.7), Inches(6.5), Inches(11.9), Inches(0.35))
    para(tf, "Pre-build and six sprints complete · sprint 7 closes 11 September with the handover session",
         10.5, MUTED, first=True)
    footer(s, 2)


def slide_deliverables(prs, f):
    s = slide_frame(prs, "Deliverables", "What has been built")
    tf = textbox(s, Inches(0.7), Inches(1.62), Inches(11.9), Inches(0.4))
    para(tf, "Three widgets over one shared rule layer, with a reporting layer and a "
             "test pack that both read the same data and reimplement none of the rules.",
         12.5, MUTED, first=True)

    x, w, gap = Inches(0.7), Inches(3.9), Inches(0.22)
    for i, (head, items) in enumerate(DELIVERABLES):
        cx = x + i * (w + gap)
        rect(s, cx, Inches(2.3), w, Inches(3.55), TINT)
        rect(s, cx, Inches(2.3), w, Pt(3.5), ORANGE)
        tf = textbox(s, cx + Inches(0.28), Inches(2.55), w - Inches(0.56), Inches(0.35))
        para(tf, head, 13, DEEP, bold=True, first=True, space_after=11)
        for it in items:
            para(tf, "— " + it, 10.5, INK, space_after=11)

    rect(s, Inches(0.7), Inches(6.05), Inches(11.93), Inches(0.72), WHITE, line=RULE)
    tf = textbox(s, Inches(0.95), Inches(6.2), Inches(11.4), Inches(0.5))
    para(tf, "Two rules the delivery holds to", 10.5, DEEP, bold=True, first=True, space_after=3)
    para(tf, "Money is read from the summary snapshot and never from live catalogue rates  ·  "
             "shift meaning lives in catalogue columns keyed by sys_id, so renaming a shift "
             "type changes no behaviour", 10.5, MUTED)
    footer(s, 3)


def slide_roadmap(prs, f):
    s = slide_frame(prs, "Roadmap", "What remains")
    open_bugs = f["status"].get("Open", 0)
    tf = textbox(s, Inches(0.7), Inches(1.62), Inches(11.9), Inches(0.4))
    para(tf, f"{f['done']} of {f['total']} items closed. "
             f"{open_bugs} defects stay open deliberately — the test pack is expected to fail "
             "on them, and a fully green run would mean the assertions had broken.",
         12.5, MUTED, first=True)

    x, w, gap = Inches(0.7), Inches(3.9), Inches(0.22)
    for i, (head, colour, items) in enumerate(ROADMAP):
        cx = x + i * (w + gap)
        rect(s, cx, Inches(2.35), w, Inches(3.35), WHITE, line=RULE)
        rect(s, cx, Inches(2.35), w, Inches(0.5), colour)
        tf = textbox(s, cx + Inches(0.28), Inches(2.48), w - Inches(0.56), Inches(0.3))
        para(tf, head, 12, WHITE, bold=True, first=True)
        tf = textbox(s, cx + Inches(0.28), Inches(3.08), w - Inches(0.56), Inches(2.5))
        for j, it in enumerate(items):
            para(tf, "— " + it, 10.5, INK, space_after=12, first=(j == 0))

    rect(s, Inches(0.7), Inches(5.92), Inches(11.93), Inches(0.85), TINT)
    tf = textbox(s, Inches(0.95), Inches(6.08), Inches(11.4), Inches(0.6))
    para(tf, "Decision needed from the sponsor", 10.5, DEEP, bold=True, first=True, space_after=3)
    para(tf, "Table ACLs were scoped out of the proof of concept by agreement. Production use "
             "needs them written, and the widget-level guards that stand in for them today "
             "must stay rigorous either way.", 10.5, MUTED)
    footer(s, 4)


def main():
    rows, f = load()
    prs = Presentation()
    prs.slide_width, prs.slide_height = W, H
    slide_overview(prs, f)
    slide_plan(prs, f)
    slide_deliverables(prs, f)
    slide_roadmap(prs, f)
    prs.save(OUT)
    print(f"wrote {OUT.name}: {len(prs.slides._sldIdLst)} slides")
    print(f"  board: {f['total']} items, {f['done']} done, {dict(f['status'])}")


if __name__ == "__main__":
    main()
