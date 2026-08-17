"""
Futuristic Technologies house style for the ShiftPay evidence packs.

Kept apart from the document logic so the palette, the confidentiality wording
and the logo can change without touching how a case is laid out — and so a
second client's branding is a new module rather than a fork of the generator.

Palette sampled from the company wordmark at futuristictechnologies.co.uk:
blue #006096 and orange #F7662D.
"""

from pathlib import Path
from docx.shared import Pt, RGBColor, Inches

# Brand palette.
BLUE = RGBColor(0x00, 0x60, 0x96)      # the wordmark's blue — headings, rules
DEEP = RGBColor(0x00, 0x36, 0x54)      # a darker blue for titles, for contrast in print
ORANGE = RGBColor(0xF7, 0x66, 0x2D)    # the wordmark's orange — accents only
INK = RGBColor(0x1A, 0x1A, 0x1A)
MUTED = RGBColor(0x60, 0x66, 0x76)
RULE = RGBColor(0xD5, 0xD9, 0xE0)

# Verdict colours. Deliberately not the traffic-light green/red of a marketing
# deck — these documents get printed and photocopied, so they need to separate at
# greyscale as well as in colour.
VERDICT_COLOURS = {
    "PASS": RGBColor(0x0B, 0x6B, 0x3A),
    "FAIL": RGBColor(0xA8, 0x18, 0x45),
    "BLOCKED": RGBColor(0xB2, 0x6A, 0x00),
    "NOT RUN": MUTED,
}

# Hex equivalents, for the XML-level cell shading python-docx has no API for.
VERDICT_FILL = {
    "PASS": "E6F4EC",
    "FAIL": "FBE9EF",
    "BLOCKED": "FDF1E0",
    "NOT RUN": "EEF0F3",
}

# Table furniture.
HEADER_FILL = "006096"      # must match BLUE
LABEL_FILL = "F2F6F9"

BODY_FONT = "Calibri"
MONO_FONT = "Consolas"

SIZE_TITLE = Pt(26)
SIZE_H1 = Pt(15)
SIZE_H2 = Pt(11.5)
SIZE_BODY = Pt(10.5)
SIZE_SMALL = Pt(9)
SIZE_MONO = Pt(8)

PAGE_MARGIN = Inches(0.85)

COMPANY = "Futuristic Technologies"
TAGLINE = "Decode the future"
PRODUCT = "Shift Pay Management"
SCOPE = "scope x_1995110_shift_0"
DOC_KIND = "Test Evidence Record"

CONFIDENTIALITY = (
    "Confidential. Prepared by Futuristic Technologies. "
    "Contains system test evidence and must not be redistributed without written consent."
)

ASSETS = Path(__file__).parent / "assets"


def logo_path():
    """
    The cover logo, if one has been supplied.

    Optional by design: the pack must build on a machine that has never had the
    brand assets dropped in, falling back to a typographic wordmark rather than
    failing to produce a document.
    """
    for name in ("ft-logo.png", "ft-logo.jpg", "logo.png", "logo.jpg"):
        candidate = ASSETS / name
        if candidate.exists():
            return candidate
    return None
