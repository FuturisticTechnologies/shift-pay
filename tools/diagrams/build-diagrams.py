"""
Generate the ShiftPay technical document diagrams as SVG.

    python tools/diagrams/build-diagrams.py

Writes tools/diagrams/svg/*.svg. Render them to PNG with render.mjs, which
drives the Chromium the test pack already has installed:

    node tools/diagrams/render.mjs

Why SVG-then-Chromium rather than a drawing library: the diagrams need real
typography (the document is set in Calibri and the diagrams should not look
imported from somewhere else), proper arrowheads and consistent stroke weights.
A browser gives all three for free, and the intermediate SVG stays diffable.

Palette is the Futuristic Technologies house style from
testing/evidence-generator/branding.py, restated here as hex because SVG wants
strings and branding.py hands out RGBColor objects.
"""

import sys
from pathlib import Path

OUT = Path(__file__).parent / "svg"

# Brand palette — must track branding.py.
BLUE = "#006096"
DEEP = "#003654"
ORANGE = "#F7662D"
INK = "#1A1A1A"
MUTED = "#606676"
RULE = "#D5D9E0"
PANEL = "#F2F6F9"
PAPER = "#FFFFFF"

OK_FILL, OK_LINE, OK_TEXT = "#E6F4EC", "#9CCFB4", "#0B6B3A"
NO_FILL, NO_LINE, NO_TEXT = "#FBE9EF", "#E4A0B5", "#A81845"
WARN_FILL, WARN_LINE, WARN_TEXT = "#FDF1E0", "#E8C48A", "#B26A00"
NEUTRAL_FILL = "#EEF1F4"

FONT = "'Segoe UI','Calibri','Helvetica Neue',Arial,sans-serif"
MONO = "'Consolas','Cascadia Mono','Courier New',monospace"


# --------------------------------------------------------------------------
# Primitives
# --------------------------------------------------------------------------

def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def head(w, h):
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}"
     viewBox="0 0 {w} {h}" font-family="{FONT}">
<defs>
  <marker id="a" viewBox="0 0 10 10" refX="9.2" refY="5"
          markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0,0 L10,5 L0,10 z" fill="{MUTED}"/>
  </marker>
  <marker id="ao" viewBox="0 0 10 10" refX="9.2" refY="5"
          markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0,0 L10,5 L0,10 z" fill="{ORANGE}"/>
  </marker>
  <marker id="an" viewBox="0 0 10 10" refX="9.2" refY="5"
          markerWidth="7" markerHeight="7" orient="auto-start-reverse">
    <path d="M0,0 L10,5 L0,10 z" fill="{NO_TEXT}"/>
  </marker>
</defs>
<rect width="{w}" height="{h}" fill="{PAPER}"/>
"""


def tail():
    return "</svg>\n"


def text(x, y, s, *, size=13, fill=INK, anchor="start", weight="400",
         mono=False, italic=False, spacing=None):
    fam = f' font-family="{MONO}"' if mono else ""
    it = ' font-style="italic"' if italic else ""
    ls = f' letter-spacing="{spacing}"' if spacing else ""
    return (f'<text x="{x}" y="{y}" font-size="{size}" fill="{fill}" '
            f'text-anchor="{anchor}" font-weight="{weight}"{fam}{it}{ls}>'
            f'{esc(s)}</text>\n')


def rect(x, y, w, h, *, fill=PAPER, stroke=RULE, rx=7, sw=1.3, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>\n')


def line(x1, y1, x2, y2, *, stroke=RULE, sw=1.3, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{stroke}" '
            f'stroke-width="{sw}"{d}/>\n')


def path(points, *, stroke=MUTED, sw=1.4, marker="a", dash=None):
    d = "M " + " L ".join(f"{x},{y}" for x, y in points)
    da = f' stroke-dasharray="{dash}"' if dash else ""
    mk = f' marker-end="url(#{marker})"' if marker else ""
    return (f'<path d="{d}" fill="none" stroke="{stroke}" stroke-width="{sw}" '
            f'stroke-linejoin="round"{da}{mk}/>\n')


def label(x, y, s, *, size=11, fill=MUTED, anchor="middle", pad=5, bg=PAPER,
          italic=False):
    """Arrow label with a paper-coloured plate so it can sit on top of a line."""
    w = len(s) * size * 0.53 + pad * 2
    x0 = {"middle": x - w / 2, "start": x - pad, "end": x - w + pad}[anchor]
    out = f'<rect x="{x0}" y="{y - size + 1}" width="{w}" height="{size + 6}" fill="{bg}"/>\n'
    return out + text(x, y, s, size=size, fill=fill, anchor=anchor, italic=italic)


def box(x, y, w, h, title, body=(), *, fill=PAPER, stroke=RULE, tcol=DEEP,
        bcol=MUTED, tsize=13.5, bsize=11.5, mono_title=False, centre=True,
        rx=7, sw=1.3, pad=15, badge=None, badge_col=ORANGE):
    """A titled box. `body` lines are laid out under the title."""
    out = rect(x, y, w, h, fill=fill, stroke=stroke, rx=rx, sw=sw)
    ax = x + w / 2 if centre else x + pad
    anc = "middle" if centre else "start"

    ty = y + (pad + tsize - 2)
    if badge is not None:
        out += (f'<circle cx="{x + pad + 8}" cy="{ty - 5}" r="10.5" '
                f'fill="{badge_col}"/>\n')
        out += text(x + pad + 8, ty - 1, badge, size=11.5, fill=PAPER,
                    anchor="middle", weight="700")
        if not centre:
            ax = x + pad + 27
    out += text(ax, ty, title, size=tsize, fill=tcol, anchor=anc,
                weight="600", mono=mono_title)

    by = ty + bsize + 6
    for ln in body:
        if ln == "":
            by += 5
            continue
        it = ln.startswith("_")
        out += text(ax, by, ln.lstrip("_"), size=bsize, fill=bcol, anchor=anc,
                    italic=it)
        by += bsize + 4.5
    return out


def diamond(cx, cy, w, h, lines, *, fill=PANEL, stroke=BLUE, tcol=DEEP,
            size=11.8):
    pts = f"{cx},{cy - h / 2} {cx + w / 2},{cy} {cx},{cy + h / 2} {cx - w / 2},{cy}"
    out = (f'<polygon points="{pts}" fill="{fill}" stroke="{stroke}" '
           f'stroke-width="1.3"/>\n')
    y = cy - (len(lines) - 1) * (size + 3) / 2 + size / 2 - 1
    for ln in lines:
        out += text(cx, y, ln, size=size, fill=tcol, anchor="middle",
                    weight="600")
        y += size + 3
    return out


def pill(cx, cy, w, h, s, *, fill=DEEP, tcol=PAPER, size=13):
    out = rect(cx - w / 2, cy - h / 2, w, h, fill=fill, stroke=fill, rx=h / 2)
    out += text(cx, cy + size / 2 - 1.5, s, size=size, fill=tcol,
                anchor="middle", weight="600")
    return out


def caption(w, y, n, s):
    out = text(0, y, f"Figure {n}", size=11, fill=ORANGE, weight="700",
               spacing="0.6")
    out += text(58, y, s, size=11, fill=MUTED)
    return out


# --------------------------------------------------------------------------
# 1 — Component map and data flow
# --------------------------------------------------------------------------

def d1_component_map():
    W, H = 960, 600
    s = head(W, H)

    s += box(330, 14, 300, 56, "ShiftPay Home", ["three destination cards"],
             fill=DEEP, stroke=DEEP, tcol=PAPER, bcol="#B9CEDC")

    cols = [
        (10, "My Shift Submissions", "employee",
         ["log a day", "clear a day", "bulk apply", "submit the month"]),
        (340, "Team Timesheet Approvals", "manager",
         ["approve", "reject", "bulk action", "correct a day"]),
        (670, "ShiftPay Reporting", "analytics",
         ["five dashboard tabs", "read only", "_no write path"]),
    ]
    for x, title, who, items in cols:
        s += rect(x, 132, 280, 140, fill=PAPER, stroke=RULE)
        s += rect(x, 132, 280, 34, fill=PANEL, stroke=RULE)
        s += text(x + 14, 154, title, size=13, fill=DEEP, weight="600")
        s += text(x + 266, 154, who, size=10.5, fill=MUTED, anchor="end")
        y = 190
        for it in items:
            it_i = it.startswith("_")
            s += f'<circle cx="{x + 20}" cy="{y - 4}" r="2.6" fill="{ORANGE}"/>\n'
            s += text(x + 32, y, it.lstrip("_"), size=11.8, fill=INK,
                      italic=it_i)
            y += 21

    for cx in (150, 480, 810):
        s += path([(480, 70), (480, 104), (cx, 104), (cx, 130)])

    s += path([(150, 272), (150, 356)])
    s += label(150, 318, "writes")
    s += path([(480, 272), (480, 356)])
    s += label(480, 318, "writes")
    s += path([(810, 356), (810, 272)])
    s += label(810, 318, "reads")

    s += rect(10, 358, 940, 122, fill=PANEL, stroke=BLUE, dash="5 4")
    s += text(30, 382, "SHARED BUSINESS LOGIC", size=11, fill=BLUE,
              weight="700", spacing="1")
    s += text(930, 382, "each parameterised by user — no rule implemented twice",
              size=10.5, fill=MUTED, anchor="end", italic=True)
    mods = [
        (28, "ShiftPayCalendarRules", "what may be logged, and when"),
        (334, "ShiftPayEntitlements", "the compensatory-off lifecycle"),
        (640, "ShiftPayAggregator", "pay aggregation and rate snapshot"),
    ]
    for x, name, sub in mods:
        s += rect(x, 396, 292, 66, fill=PAPER, stroke=RULE)
        s += text(x + 16, 419, name, size=12, fill=DEEP, weight="600",
                  mono=True)
        s += text(x + 16, 440, sub, size=11, fill=MUTED)

    s += path([(480, 480), (480, 508)])

    s += rect(10, 510, 940, 58, fill=PAPER, stroke=DEEP, sw=1.6)
    s += text(30, 534, "SIX TABLES", size=11, fill=DEEP, weight="700",
              spacing="1")
    s += text(30, 554, "shift_type · u_shift_submission · monthly_timesheet · "
                       "shift_co_entitlement · shift_submission_summary · shift_day_change",
              size=10.8, fill=MUTED, mono=True)

    s += caption(W, 590, 1, "Component map — the four interface components, "
                            "the shared rule modules and the tables beneath them")
    return s + tail()


# --------------------------------------------------------------------------
# 2 — Entity relationships
# --------------------------------------------------------------------------

def d2_entities():
    W, H = 960, 548
    s = head(W, H)

    s += box(350, 14, 260, 104, "shift_type",
             ["the catalogue", "rate · currency · colour",
              "oc_role · allow_* · day_category"],
             fill=DEEP, stroke=DEEP, tcol=PAPER, bcol="#B9CEDC",
             mono_title=True)

    s += path([(480, 118), (480, 146)], marker=None)
    s += line(150, 146, 810, 146, stroke=MUTED, sw=1.4)
    s += label(480, 142, "referenced by", size=10.5)
    for cx in (150, 480, 810):
        s += path([(cx, 146), (cx, 186)])

    facts = [
        (15, "u_shift_submission", "ONE ROW PER USER PER DAY",
         ["the transactional record", "one shift, one optional comment"]),
        (345, "shift_submission_summary", "ONE ROW PER USER, PERIOD, TYPE",
         ["weekly and monthly aggregates", "_every money figure lives here"]),
        (675, "shift_day_change", "ONE ROW PER CORRECTION",
         ["append-only audit trail", "never updated"]),
    ]
    for x, name, grain, body in facts:
        s += rect(x, 188, 270, 128, fill=PAPER, stroke=RULE)
        s += rect(x, 188, 270, 30, fill=PANEL, stroke=RULE)
        s += text(x + 14, 208, name, size=12, fill=DEEP, weight="600",
                  mono=True)
        s += text(x + 14, 240, grain, size=9.8, fill=ORANGE, weight="700",
                  spacing="0.5")
        y = 266
        for ln in body:
            s += text(x + 14, y, ln.lstrip("_"), size=11.3, fill=MUTED,
                      italic=ln.startswith("_"))
            y += 20

    s += path([(150, 316), (150, 358)])
    s += label(150, 342, "referenced by", size=10.5)

    s += rect(15, 360, 270, 132, fill=PAPER, stroke=RULE)
    s += rect(15, 360, 270, 30, fill=PANEL, stroke=RULE)
    s += text(29, 380, "shift_co_entitlement", size=12, fill=DEEP,
              weight="600", mono=True)
    s += text(29, 412, "ONE ROW PER EARNED CO", size=9.8, fill=ORANGE,
              weight="700", spacing="0.5")
    s += text(29, 438, "links the granting entry", size=11.3, fill=MUTED)
    s += text(29, 458, "to the entry that consumed it", size=11.3, fill=MUTED)
    s += text(29, 480, "oc_date · window_end · co_date", size=10.5, fill=MUTED,
              mono=True)

    s += rect(675, 360, 270, 132, fill=PAPER, stroke=RULE)
    s += rect(675, 360, 270, 30, fill=PANEL, stroke=RULE)
    s += text(689, 380, "monthly_timesheet", size=12, fill=DEEP, weight="600",
              mono=True)
    s += text(689, 412, "ONE ROW PER USER PER MONTH", size=9.8, fill=ORANGE,
              weight="700", spacing="0.5")
    s += text(689, 438, "submission lock and approval", size=11.3, fill=MUTED)
    s += text(689, 458, "state on the same row", size=11.3, fill=MUTED)
    s += text(689, 480, "no separate approval table", size=10.5, fill=BLUE,
              italic=True)

    s += caption(W, 534, 2, "Data model — six tables, with the grain of each "
                            "stated rather than implied")
    return s + tail()


# --------------------------------------------------------------------------
# 3 — Availability resolution
# --------------------------------------------------------------------------

def d3_availability():
    W, H = 960, 700
    s = head(W, H)

    s += pill(480, 38, 260, 46, "A date, and a user")
    s += path([(480, 61), (480, 84)])

    s += diamond(480, 132, 300, 92,
                 ["Is it a weekend, or a date in", "the holiday schedule?"])

    s += path([(330, 132), (215, 132), (215, 202)])
    s += label(268, 126, "no", size=11.5, fill=DEEP)
    s += path([(630, 132), (815, 132), (815, 202)])
    s += label(722, 126, "yes", size=11.5, fill=DEEP)

    s += box(90, 204, 250, 64, "allow_weekday = true",
             ["the weekday shift types"], fill=PANEL, stroke=BLUE,
             mono_title=True, tsize=12)
    s += box(690, 204, 250, 64, "allow_weekend_holiday = true",
             ["the weekend and holiday types"], fill=PANEL, stroke=BLUE,
             mono_title=True, tsize=11.5)

    s += path([(215, 268), (215, 316)])
    s += diamond(215, 366, 300, 96,
                 ["Does that list include", "a consumes_co type?"])

    # No consumes_co type in the list means there is nothing to check — the
    # branch leaves to the left and rejoins the bus untouched.
    s += path([(65, 366), (32, 366), (32, 600)], marker=None)
    s += label(48, 360, "no", size=11.5, fill=DEEP)

    s += path([(215, 414), (215, 462)])
    s += label(215, 442, "yes", size=11.5, fill=DEEP)
    s += diamond(215, 512, 320, 100,
                 ["Does an unconsumed entitlement", "window cover this date?"])

    s += box(455, 482, 210, 62, "Remove the CO", ["it has not been earned"],
             fill=NO_FILL, stroke=NO_LINE, tcol=NO_TEXT, bcol=NO_TEXT,
             tsize=12.5)
    s += path([(375, 513), (455, 513)], stroke=NO_TEXT, marker="an")
    s += label(415, 507, "no", size=11.5, fill=NO_TEXT)
    s += path([(560, 544), (560, 600)], marker=None)

    s += path([(215, 562), (215, 600)], marker=None)
    s += label(288, 584, "yes — keep it", size=11, fill=OK_TEXT)
    s += path([(815, 268), (815, 600)], marker=None)

    s += line(32, 600, 815, 600, stroke=MUTED, sw=1.4)
    s += path([(480, 600), (480, 611)])

    s += pill(480, 636, 400, 46, "The allowed shift list for that date",
              fill=BLUE)

    s += caption(W, 690, 3, "Shift availability — resolved per date, per user, "
                            "and re-checked server-side on every write")
    return s + tail()


# --------------------------------------------------------------------------
# 4 — The day-save sequence
# --------------------------------------------------------------------------

def d4_day_save():
    W, H = 960, 724
    s = head(W, H)
    CX, BX, BW = 350, 110, 480

    s += pill(CX, 32, 420, 46, "Employee picks a shift for a date")
    s += path([(CX, 55), (CX, 84)])

    s += box(BX, 86, BW, 74, "Guard",
             ["Is the month locked?",
              "Is this shift allowed on this date, for this user?"],
             fill=WARN_FILL, stroke=WARN_LINE, tcol=WARN_TEXT, bcol=INK,
             centre=False)

    s += box(BX, 194, BW, 96, "Release the previous shift",
             ["Did the old shift grant a CO?  Delete the entitlement —",
              "unless a CO already claimed it, which refuses the change.",
              "Was the old shift the CO?  Release what it consumed."],
             badge="1", centre=False)

    s += box(BX, 324, BW, 80, "Reserve for the new shift",
             ["Is the new shift the CO?  Claim the earliest unconsumed",
              "entitlement whose window covers this date."],
             badge="2", centre=False)

    s += box(BX, 438, BW, 52, "Write the day row", fill=BLUE, stroke=BLUE,
             tcol=PAPER, tsize=14.5, centre=True, pad=19)

    s += box(BX, 524, BW, 80, "Commit for the new shift",
             ["Grants a CO?  Insert an entitlement, window = 7 weekdays.",
              "Is the CO?  Mark the reserved entitlement consumed."],
             badge="3", centre=False)

    s += box(BX, 638, BW, 50, "Recompute the weekly and monthly aggregates",
             fill=PANEL, stroke=RULE, tsize=13, centre=True, pad=18)

    for y0, y1 in ((160, 192), (290, 322), (404, 436), (490, 522), (604, 636)):
        s += path([(CX, y0), (CX, y1)])

    refusals = [
        (123, 62, "Refused", ["locked, or not allowed on this date"]),
        (242, 74, "Refused", ["a CO on a later date", "already depends on this entry"]),
        (364, 74, "Refused", ["no entitlement window", "covers this date"]),
    ]
    for cy, h, t, body in refusals:
        s += box(700, cy - h / 2, 250, h, t, body, fill=NO_FILL,
                 stroke=NO_LINE, tcol=NO_TEXT, bcol=NO_TEXT, tsize=12.5,
                 bsize=10.8, centre=False)
        s += path([(590, cy), (700, cy)], stroke=NO_TEXT, marker="an")

    s += caption(W, 716, 4, "The three-phase day change — the entitlement "
                            "decision brackets the write, because it must be "
                            "made before the row exists and recorded after")
    return s + tail()


# --------------------------------------------------------------------------
# 5 — The CO window
# --------------------------------------------------------------------------

def d5_co_window():
    W, H = 960, 350
    s = head(W, H)

    days = [("Sat", 1, True), ("Sun", 2, True), ("Mon", 3, False),
            ("Tue", 4, False), ("Wed", 5, False), ("Thu", 6, False),
            ("Fri", 7, False), ("Sat", 8, True), ("Sun", 9, True),
            ("Mon", 10, False), ("Tue", 11, False), ("Wed", 12, False)]
    x0, step, axis = 62, 72, 226

    for i, (nm, num, we) in enumerate(days):
        x = x0 + i * step
        if we:
            s += rect(x - 30, 96, 60, 130, fill=NEUTRAL_FILL, stroke="none",
                      rx=4, sw=0)
        s += line(x, 220, x, 232, stroke=MUTED, sw=1.3)
        s += text(x, 250, nm, size=11.5, fill=MUTED if we else INK,
                  anchor="middle", weight="600" if not we else "400")
        s += text(x, 267, str(num), size=11, fill=MUTED, anchor="middle")
        if we:
            s += text(x, 286, "weekend", size=9.3, fill=MUTED, anchor="middle",
                      italic=True)

    s += line(34, 226, 926, 226, stroke=MUTED, sw=1.6)

    ocx = x0
    s += rect(ocx - 34, 44, 210, 44, fill=ORANGE, stroke=ORANGE, rx=6)
    s += text(ocx - 22, 71, "OC + CO worked", size=12.5, fill=PAPER,
              weight="700")
    s += path([(ocx, 88), (ocx, 216)], stroke=ORANGE, marker="ao")
    s += f'<circle cx="{ocx}" cy="226" r="6" fill="{ORANGE}"/>\n'
    s += text(ocx + 186, 71, "entitlement created", size=11.5, fill=MUTED,
              italic=True)

    wx0, wx1 = x0 + 2 * step, x0 + 10 * step
    s += rect(wx0 - 30, 118, (wx1 - wx0) + 60, 40, fill="#E3EEF4",
              stroke=BLUE, rx=6)
    s += text((wx0 + wx1) / 2, 143, "the CO may be taken on any of these seven weekdays",
              size=12, fill=DEEP, anchor="middle", weight="600")

    counted = [2, 3, 4, 5, 6, 9, 10]
    for n, i in enumerate(counted, start=1):
        x = x0 + i * step
        s += f'<circle cx="{x}" cy="184" r="12" fill="{PAPER}" stroke="{BLUE}" stroke-width="1.4"/>\n'
        s += text(x, 188, str(n), size=11.5, fill=DEEP, anchor="middle",
                  weight="700")

    ex = x0 + 10 * step
    s += line(ex, 200, ex, 226, stroke=BLUE, sw=1.4, dash="4 3")
    s += text(ex, 312, "window_end", size=11, fill=BLUE, anchor="middle",
              weight="700", mono=True)

    fx = x0 + 11 * step
    s += f'<circle cx="{fx}" cy="184" r="12" fill="{NO_FILL}" stroke="{NO_LINE}" stroke-width="1.4"/>\n'
    s += line(fx - 5, 179, fx + 5, 189, stroke=NO_TEXT, sw=1.8)
    s += line(fx + 5, 179, fx - 5, 189, stroke=NO_TEXT, sw=1.8)
    s += text(fx, 312, "expired", size=11, fill=NO_TEXT, anchor="middle",
              weight="700")

    s += text(34, 22, "Counting skips Saturday and Sunday only — declared "
                      "holidays are not excluded from the window arithmetic.",
              size=11, fill=MUTED, italic=True)

    s += caption(W, 342, 5, "The entitlement window — seven weekdays, valid "
                            "strictly after the on-call day and up to and "
                            "including the deadline")
    return s + tail()


# --------------------------------------------------------------------------
# 6 — Entitlement record lifecycle
# --------------------------------------------------------------------------

def d6_entitlement_states():
    W, H = 960, 420
    s = head(W, H)

    s += f'<circle cx="480" cy="40" r="9" fill="{DEEP}"/>\n'
    s += text(504, 45, "employee logs a shift whose oc_role is grants_co",
              size=11.5, fill=MUTED, italic=True)
    s += path([(480, 49), (480, 92)])

    s += box(340, 94, 280, 96, "UNCONSUMED",
             ["oc_date · window_end  set", "co_date · co_entry  null"],
             fill=PANEL, stroke=BLUE, tcol=DEEP, tsize=14, bsize=11,
             mono_title=False)
    s += box(710, 94, 230, 96, "CONSUMED",
             ["co_date · co_entry  set", "_the day off has been taken"],
             fill=OK_FILL, stroke=OK_LINE, tcol=OK_TEXT, bcol=OK_TEXT,
             tsize=14, bsize=11)
    s += box(20, 94, 230, 96, "DELETED",
             ["no CO had claimed it", "_the right is given back"],
             fill=NEUTRAL_FILL, stroke=RULE, tcol=MUTED, bcol=MUTED,
             tsize=14, bsize=11)

    s += path([(340, 128), (250, 128)])
    s += label(295, 112, "granting shift", size=10.5)
    s += label(295, 124, "cleared", size=10.5)

    s += path([(620, 128), (710, 128)])
    s += label(665, 112, "CO logged", size=10.5)
    s += label(665, 124, "in window", size=10.5)

    s += path([(825, 190), (825, 232), (480, 232), (480, 192)])
    s += label(652, 228, "CO cleared — entitlement released", size=11, fill=BLUE)

    s += box(560, 286, 380, 74, "Refused while consumed",
             ["Removing the granting shift is blocked for as long as",
              "a CO depends on it: “a CO on <date> depends on this entry”."],
             fill=NO_FILL, stroke=NO_LINE, tcol=NO_TEXT, bcol=NO_TEXT,
             tsize=12.5, bsize=11, centre=False)
    s += path([(825, 190), (825, 284)], stroke=NO_TEXT, marker="an",
              dash="4 3")

    s += box(20, 286, 500, 74, "The two refusals in plain terms",
             ["An employee cannot delete the on-call shift that justified a day",
              "off already taken, nor take a day off that was never earned."],
             fill=PAPER, stroke=RULE, tcol=DEEP, bcol=MUTED, tsize=12.5,
             bsize=11, centre=False)

    s += caption(W, 406, 6, "Entitlement record lifecycle — one row per earned "
                            "compensatory day, consumed at most once")
    return s + tail()


# --------------------------------------------------------------------------
# 7 — Monthly timesheet state machine
# --------------------------------------------------------------------------

def d7_timesheet_states():
    W, H = 960, 440
    s = head(W, H)

    s += box(20, 150, 200, 96, "OPEN",
             ["no timesheet row", "_editable"],
             fill=PANEL, stroke=RULE, tcol=DEEP, bcol=MUTED, tsize=15)
    s += box(320, 150, 230, 96, "SUBMITTED",
             ["awaiting a decision", "_locked for the employee"],
             fill=PANEL, stroke=BLUE, tcol=DEEP, bcol=MUTED, tsize=15)
    s += box(700, 34, 240, 92, "APPROVED",
             ["_locked — final"],
             fill=OK_FILL, stroke=OK_LINE, tcol=OK_TEXT, bcol=OK_TEXT,
             tsize=15)
    s += box(700, 268, 240, 92, "REJECTED",
             ["_unlocked — back with", "_the employee"],
             fill=NO_FILL, stroke=NO_LINE, tcol=NO_TEXT, bcol=NO_TEXT,
             tsize=15)

    s += path([(220, 198), (320, 198)])
    s += label(270, 180, "submit", size=11, fill=DEEP)
    s += text(313, 232, "every weekday logged,", size=10.2, fill=MUTED,
              anchor="end")
    s += text(313, 245, "inside the window", size=10.2, fill=MUTED,
              anchor="end")

    s += path([(550, 180), (640, 180), (640, 80), (700, 80)], stroke=OK_TEXT,
              marker=None)
    s += f'<path d="M 700,80 L 690,75 L 690,85 z" fill="{OK_TEXT}"/>\n'
    s += label(640, 132, "approve", size=11, fill=OK_TEXT)

    s += path([(550, 216), (640, 216), (640, 314), (700, 314)], stroke=NO_TEXT,
              marker=None)
    s += f'<path d="M 700,314 L 690,309 L 690,319 z" fill="{NO_TEXT}"/>\n'
    s += label(640, 262, "reject", size=11, fill=NO_TEXT)
    s += text(640, 356, "comment mandatory", size=10.2, fill=MUTED,
              anchor="middle")

    s += path([(820, 360), (820, 402), (435, 402), (435, 248)], stroke=BLUE)
    s += label(628, 398, "resubmit — same row, decision cleared", size=11, fill=BLUE)

    s += box(20, 296, 260, 76, "The lock is conditional",
             ["A month is locked when a row exists", "and its status is not rejected."],
             fill=WARN_FILL, stroke=WARN_LINE, tcol=WARN_TEXT, bcol=INK,
             tsize=12.5, bsize=11, centre=False)

    s += caption(W, 426, 7, "Monthly timesheet states — rejection is not "
                            "terminal, it is the mechanism that returns the "
                            "month to the employee")
    return s + tail()


# --------------------------------------------------------------------------
# 8 — Aggregation
# --------------------------------------------------------------------------

def d8_aggregation():
    W, H = 960, 312
    s = head(W, H)

    s += pill(480, 34, 520, 46,
              "Any day change — save, clear, bulk apply or manager correction")
    s += path([(480, 57), (480, 92)])
    s += line(120, 92, 840, 92, stroke=MUTED, sw=1.4)

    steps = [
        (20, "1", "Identify the periods",
         ["the month containing", "the date, and its", "ISO week"]),
        (255, "2", "Delete",
         ["every summary row", "for those periods"]),
        (490, "3", "Count",
         ["day rows, grouped", "by shift type"]),
        (725, "4", "Insert",
         ["one row per shift type", "per period"]),
    ]
    for x, n, title, body in steps:
        s += path([(x + 107, 92), (x + 107, 118)])
        s += box(x, 120, 215, 104, title, body, badge=n, centre=False,
                 tsize=13.5, bsize=11.3)

    s += rect(725, 236, 215, 46, fill=PANEL, stroke=BLUE)
    s += text(736, 254, "u_rate_snapshot", size=10.8, fill=DEEP, mono=True,
              weight="600")
    s += text(736, 272, "= the rate at this moment", size=10.5, fill=MUTED)
    s += path([(832, 224), (832, 234)], marker=None)

    s += box(20, 236, 680, 46,
             "No running total exists anywhere, so nothing can drift out of "
             "step with the day records it summarises.",
             fill=PAPER, stroke=RULE, tcol=INK, tsize=11.8, centre=False,
             pad=13)

    s += caption(W, 302, 8, "Pay aggregation — recomputed after every day "
                            "change, never incremented")
    return s + tail()


# --------------------------------------------------------------------------
# 9 — The three-layer component contract
# --------------------------------------------------------------------------

def d9_contract():
    W, H = 960, 452
    s = head(W, H)
    X, BW = 130, 590

    layers = [
        (20, "SERVER VIEW MODEL", DEEP,
         ["Builds a plain data object — rows, maps, labels, flags, colours.",
          "No markup, and no formatting decisions."]),
        (160, "ANGULARJS CONTROLLER  ( c )", BLUE,
         ["Copies what it needs at bootstrap, derives view state — grid cells,",
          "groups, counts, styles — and owns all interaction state."]),
        (300, "TEMPLATE", MUTED,
         ["Renders the controller. No business logic, and no arithmetic",
          "beyond display."]),
    ]
    for y, title, col, body in layers:
        s += rect(X, y, BW, 96, fill=PAPER, stroke=RULE)
        s += rect(X, y, 7, 96, fill=col, stroke=col, rx=3)
        s += text(X + 26, y + 32, title, size=13, fill=col, weight="700",
                  spacing="0.8")
        yy = y + 58
        for ln in body:
            s += text(X + 26, yy, ln, size=11.6, fill=MUTED)
            yy += 19

    s += path([(425, 116), (425, 156)])
    s += label(425, 141, "data", size=11.5, fill=DEEP)
    s += path([(425, 256), (425, 296)])
    s += label(425, 281, "c.*", size=11.5, fill=DEEP)

    s += path([(720, 396), (788, 396), (788, 68), (720, 68)], stroke=ORANGE,
              marker="ao")
    s += text(802, 216, "every write re-runs", size=11, fill=ORANGE,
              weight="600")
    s += text(802, 232, "the whole server view", size=11, fill=ORANGE)
    s += text(802, 248, "model, and the client", size=11, fill=ORANGE)
    s += text(802, 264, "re-seeds from it", size=11, fill=ORANGE)

    s += text(130, 424, "The same contract in all four components — learn one, "
                        "and you have learned them all.",
              size=11.5, fill=MUTED, italic=True)

    s += caption(W, 444, 9, "The three-layer component contract")
    return s + tail()


# --------------------------------------------------------------------------

DIAGRAMS = {
    "01-component-map": d1_component_map,
    "02-data-model": d2_entities,
    "03-shift-availability": d3_availability,
    "04-day-save-sequence": d4_day_save,
    "05-co-window": d5_co_window,
    "06-entitlement-states": d6_entitlement_states,
    "07-timesheet-states": d7_timesheet_states,
    "08-aggregation": d8_aggregation,
    "09-component-contract": d9_contract,
}


def build():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, fn in DIAGRAMS.items():
        (OUT / f"{name}.svg").write_text(fn(), encoding="utf-8")
        print(f"  {name}.svg")
    return len(DIAGRAMS)


if __name__ == "__main__":
    n = build()
    print(f"wrote {n} diagrams to {OUT}")
