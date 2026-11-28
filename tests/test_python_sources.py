"""SP-100: every Python script in the repo must compile.

The repo's Python is build and evidence tooling (document builders, the
evidence generator, the Power BI template builder). It has no import-level
test suite, so this is the check the CI pytest step runs: each .py file must
be valid Python 3 syntax. A script that does not compile fails here before
anyone runs it to build a deliverable.
"""
import pathlib

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]


def _python_sources():
    files = []
    for path in ROOT.rglob("*.py"):
        rel = path.relative_to(ROOT).parts
        # Skip a nested clone of this repo, if one sits in the working tree.
        if rel[0] == "shift-pay" or ".git" in rel:
            continue
        files.append(path)
    return sorted(files)


SOURCES = _python_sources()


def test_sources_were_found():
    assert SOURCES, "no Python sources found; the check would pass on nothing"


@pytest.mark.parametrize("path", SOURCES, ids=lambda p: str(p.relative_to(ROOT)))
def test_compiles(path):
    # Compile in memory: nothing is written into the working tree.
    compile(path.read_bytes(), str(path), "exec")
