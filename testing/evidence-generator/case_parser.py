"""
Read test case definitions out of the markdown case file.

The markdown is the single source of truth for what a case *is* — its priority,
what it exercises, what it expects. The Playwright run supplies what actually
happened. Keeping the definition in one place is the whole point: an evidence
pack whose "expected result" was retyped by hand certifies the typist, not the
system.

The case file is hard-wrapped prose, so everything here works on reflowed blocks
rather than raw lines. Reading line by line splits sentences mid-clause and
produces documents full of fragments like "every** weekday is logged".
"""

import re
from pathlib import Path

CASE_HEADING = re.compile(r"^###\s+(TC-[A-Z]+-\d+)\s+[—-]\s+(.+?)\s*$", re.MULTILINE)
META_ROW = re.compile(r"^\|\s*\*\*(.+?)\*\*\s*\|\s*(.*?)\s*\|\s*$", re.MULTILINE)

# A section label is short, has no sentence punctuation in it, and is the whole
# of its bold run — "Steps", "Expected", "Why it matters". A long bold phrase
# opening a sentence is emphasis, not a label, and must stay with its paragraph:
# treating "**This falsifies the claim in README §3** — ..." as a heading tears
# the sentence in half.
LABELLED = re.compile(r"^\*\*([A-Z⚠][^*.,;:]{0,28})\*\*\s*(?:[—-]\s*)?(.*)$", re.DOTALL)
SKIP_PREFIX = ("|", "#", "---", "```", ">")
LIST_ITEM = re.compile(r"^(?:[-*]\s+|\d+\.\s+)")

# The structural sections the document lays out itself. Everything else labelled
# in a case is supporting commentary and is carried through as "extras".
STANDARD_SECTIONS = {"Steps", "Expected", "Verify", "Precondition", "Note", "Notes"}


def _strip_md(text: str) -> str:
    """Flatten inline markdown to something that reads correctly in Word."""
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)      # links → label
    text = re.sub(r"`([^`]+)`", r"\1", text)                  # code spans
    text = re.sub(r"\*\*([^*]*)\*\*", r"\1", text)            # bold
    text = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"\1", text)   # italics
    text = text.replace("**", "")                             # any unpaired marker
    return re.sub(r"\s+", " ", text).strip()


def _blocks(body: str):
    """
    Split a case body into logical blocks.

    A block is a run of consecutive non-blank lines, with list items kept as
    blocks of their own so a bulleted expectation does not merge into the
    sentence above it.
    """
    out, current = [], []

    def flush():
        if current:
            out.append(" ".join(current).strip())
            current.clear()

    for raw in body.splitlines():
        line = raw.strip()
        if not line or line.startswith(SKIP_PREFIX):
            flush()
            continue
        if LIST_ITEM.match(line):
            flush()
            out.append(LIST_ITEM.sub("", line))
            continue
        # A genuine section label starts a new block even without a blank line
        # before it. Inline bold at the start of a sentence must not — that is
        # ordinary prose and belongs with the lines around it.
        if current and LABELLED.match(line):
            flush()
        current.append(line)

    flush()
    return [b for b in out if b]


def _split_sections(body: str):
    """
    Return (labelled_sections, narrative_blocks).

    Labelled sections are the **Steps** / **Expected** / **Verify** blocks;
    narrative is everything else — the rationale a tester needs in order to
    understand why the case exists at all.
    """
    sections, narrative = {}, []
    current_label = None

    for block in _blocks(body):
        match = LABELLED.match(block)
        if match:
            label, rest = match.group(1).strip(), match.group(2).strip()
            current_label = label
            sections.setdefault(label, [])
            if rest:
                sections[label].append(_strip_md(rest))
            continue

        if current_label:
            sections[current_label].append(_strip_md(block))
        else:
            narrative.append(_strip_md(block))

    return sections, [n for n in narrative if n]


def parse_cases(*markdown_files) -> dict:
    """Return {case_id: {...definition...}} across every supplied case file."""
    cases = {}

    for path in markdown_files:
        path = Path(path)
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")

        matches = list(CASE_HEADING.finditer(text))
        for i, m in enumerate(matches):
            case_id, title = m.group(1), _strip_md(m.group(2))
            start = m.end()
            end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
            body = text[start:end]

            meta = {k.strip(): _strip_md(v) for k, v in META_ROW.findall(body)}
            sections, narrative = _split_sections(body)

            # Anything labelled but not structural — "Why it matters", "Root
            # cause", "Fix", "Provenance". These carry the reasoning a reader
            # actually needs, so they are kept under their own headings rather
            # than flattened into prose or dropped.
            extras = {
                label: lines
                for label, lines in sections.items()
                if label not in STANDARD_SECTIONS and lines
            }

            cases[case_id] = {
                "id": case_id,
                "title": title,
                "priority": meta.get("Priority", ""),
                "type": meta.get("Type", ""),
                "component": meta.get("Component", ""),
                "evidence": meta.get("Evidence", ""),
                "status": meta.get("Status", ""),
                # The ⚠ row marks a deliberately introduced defect. Rendered as a
                # banner on the cover so a reader cannot mistake a demonstration
                # prop for a genuine finding.
                "warning": meta.get("⚠", ""),
                "steps": sections.get("Steps", []),
                "expected": sections.get("Expected", []),
                "verify": sections.get("Verify", []),
                "precondition": sections.get("Precondition", []),
                "note": sections.get("Note", []) + sections.get("Notes", []),
                "extras": extras,
                # A handful of blocks is context; the whole case body would just
                # duplicate the specification inside every evidence record.
                "narrative": narrative[:5],
                "source": path.name,
            }

    return cases
