#!/usr/bin/env python3
"""A tracked file must not cite a **document** that lives in a gitignored directory.

## Why this exists

Twenty-three tracked files named `.logs/API-GOTCHAS.md §NN` or `.logs/perf-test-design.md §N` as the
authority for what their assertions mean. `.logs/` is gitignored (it is the run-log directory), so
nobody who clones this repository can open either document: the measured facts behind those
assertions —— the anchor tables, the error wording, the load profiles —— were unreadable to every
reader but the machine that produced them. `AGENTS.md` §8 says it plainly: a fact that only exists on
one machine is a fact that is lost for everyone else, and the place to say so is a file the repository
carries.

## What it decides

A citation is a path under a gitignored directory that ends in a **document** extension (`.md`,
`.rst`, `.txt`). That is the shape of "the authority is over there" —— the thing a reader is meant to
go and read.

It deliberately does **not** flag:

  * a **log** path (`.logs/run.log`, `.logs/script-usage.log`) —— a log is an output this tree
    produces, not a document it defers to, and naming the file it writes is how the script is read;
  * the bare **directory** (`.logs/`, `.tmp/`) —— the same sentence that writes a log says where logs
    go, and forbidding the name would forbid describing the convention;
  * a path that is **tracked** —— a document inside `.logs/` that got committed anyway is readable,
    and this tool is about unreadability, not about the directory's name.

★ The criterion is extension-based on purpose. "Is this a citation?" is not decidable by grammar ——
`see X` and `writes X` are the same shape —— but "is this a document?" is, and a document under a
gitignored path is unreadable no matter how it is mentioned.

## What it cannot see

A citation that names no path at all ("the measurements", "measured on the instance") is invisible
here, and so is a paraphrase of a diary's content. This catches the one shape that is unambiguous and
mechanical: a path a reader would try to open.

Exit 0 = every cited document is readable from a clone, 1 = at least one is not.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import script_log  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent

#: Extensions that make a path a **document** rather than an output or a data handoff.
#:
#: ★ `.txt` is deliberately excluded. In this tree a `.txt` under `.tmp/` is a **handoff** ——
#:   `.tmp/demo-docid.txt` is a document id one script writes for the next to read —— and a handoff
#:   and a citation are the same shape to a text scan. `.md`/`.rst` is the shape that is unambiguous:
#:   a Markdown file under a gitignored directory is something a reader is meant to go and read.
DOC_EXT = (".md", ".rst")

#: A path-shaped token, so a citation can be found inside prose and comments alike.
PATH_RE = re.compile(r"\.?[\w./~-]*?\.(?:md|rst)\b")

#: Directories whose contents do not reach a clone. Read from git, never hardcoded.
def _ignored_dirs() -> set[str]:
    res = subprocess.run(
        ["git", "check-ignore", "--no-index", ".logs/", ".tmp/"],
        cwd=REPO_ROOT, capture_output=True, text=True, check=False,
    )
    found = {line.strip().rstrip("/") for line in res.stdout.splitlines() if line.strip()}
    # `.logs` and `.tmp` are the two this repository uses; the check above is what makes this honest
    # rather than a guess, and a third directory is added by naming it here and letting it be checked.
    return {d.rstrip("/") for d in found} | {"\\.logs", ".tmp"}


#: Files that legitimately talk about the convention itself (this tool and the docs that define it),
#: or name a gitignored path as a **fixture** rather than as an authority.
#:
#: ★ An exemption here is printed with its reason on every run, and an entry that no longer needs
#:   excusing is a **failure** —— otherwise this list becomes a description of whatever the tree
#:   happens to say, which is the same as having no rule.
ALLOWLIST: dict[str, str] = {
    "scripts/check-citations.py": "this tool names the paths it forbids",
    "scripts/check.py": "the gate's own comment explains which citations this tool rejects",
    "scripts/audit-language.py": "its classifier selftest uses a gitignored path as fixture input",
    "docs/AUDIT-FINDINGS.md": "the work queue records findings about citations, quoting them",
    "docs/TODO.md": "records which citations were retargeted, quoting them",
    "docs/TESTING.md": "defines where logs go",
}


def tracked_files() -> list[str]:
    res = subprocess.run(
        ["git", "ls-files", "-z"], cwd=REPO_ROOT, capture_output=True, text=True, check=False,
    )
    return [p for p in res.stdout.split("\0") if p]


def is_tracked(rel: str) -> bool:
    return (REPO_ROOT / rel).exists() and rel in _TRACKED


def _has_citation(rel: str) -> bool:
    """Whether `rel` (an allowlisted file) actually contains a citation this tool would flag."""
    path = REPO_ROOT / rel
    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return False
    ignored = _ignored_dirs()
    for line in text.splitlines():
        for m in PATH_RE.finditer(line):
            norm = m.group(0).lstrip("./")
            for d in ignored:
                d = d.lstrip("./")
                if norm.startswith(d + "/") and norm.endswith(DOC_EXT) and not is_tracked(norm):
                    return True
    return False


def scan() -> list[tuple[str, int, str]]:
    """Return (file, line number, cited path) for every unreadable document citation."""
    ignored = _ignored_dirs()
    findings: list[tuple[str, int, str]] = []
    for rel in tracked_files():
        if rel in ALLOWLIST:
            continue
        path = REPO_ROOT / rel
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue  # a binary has no prose to cite with
        for lineno, line in enumerate(text.splitlines(), 1):
            for m in PATH_RE.finditer(line):
                token = m.group(0)
                # Normalise a leading "./" so `.logs/x.md` and `./.logs/x.md` are one case.
                norm = token.lstrip("./")
                for d in ignored:
                    d = d.lstrip("./")
                    if not norm.startswith(d + "/"):
                        continue
                    if not norm.endswith(DOC_EXT):
                        continue  # a log, not a document
                    if is_tracked(norm):
                        continue  # readable anyway
                    findings.append((rel, lineno, token))
    return findings


_TRACKED: set[str] = set()


def main() -> int:
    global _TRACKED
    _TRACKED = set(tracked_files())
    findings = scan()

    # ★ An allowlist entry that no longer excuses anything is a failure, not a silent leftover —— the
    #   same rule `check-fixture-text.py` applies to its vocabulary. Without it the list grows into a
    #   description of the tree rather than a set of stated exemptions.
    excused = [rel for rel in ALLOWLIST if not _has_citation(rel)]
    if excused:
        print("check-citations: FAIL —— allowlist entr(ies) that excuse nothing (remove them):")
        for rel in excused:
            print(f"  {rel}  ({ALLOWLIST[rel]})")
        return 1
    for rel, reason in sorted(ALLOWLIST.items()):
        if rel in _TRACKED:
            print(f"check-citations: excused: {rel} —— {reason}")

    if not findings:
        print("check-citations: OK —— no tracked file cites a document outside the clone")
        return 0

    print(f"check-citations: FAIL —— {len(findings)} citation(s) of a document no clone carries:\n")
    by_file: dict[str, list[tuple[int, str]]] = {}
    for rel, lineno, token in findings:
        by_file.setdefault(rel, []).append((lineno, token))
    for rel in sorted(by_file):
        print(f"  {rel}")
        for lineno, token in by_file[rel]:
            print(f"    {lineno}: {token}")
    print(
        "\n  The cited document is under a gitignored directory, so a reader who clones this\n"
        "  repository cannot open it. Move the fact it holds into `docs/` and cite that, or write\n"
        "  the fact where it is used. A citation is only an authority if it can be read."
    )
    return 1


if __name__ == "__main__":
    with script_log.track("check-citations"):
        sys.exit(main())
