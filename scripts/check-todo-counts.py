#!/usr/bin/env python3
"""A document that states a file's **line count** must state the right one.

## Why this exists

Prose keeps acquiring numbers that nothing re-derives, and a number in prose has no way to go red. This
repository hit the same class three times in one pass:

  * `docs/TODO.md` said `Outliner.tsx` 4,686 / `store.ts` 2,982 / `mount.ts` 2,352 lines while the files
    held 4,642 / 3,255 / 2,353 —— and `store.ts` had grown by 273 lines without the sentence noticing;
  * `docs/TESTING.md` carried **four contradictory copies** of the language-allowlist size (391 tokens,
    "186 fixture / 164 i18n / 41 kernel", 12 tokens, and a set of excused-by-kind figures), none of which
    matched the file;
  * `docs/SHORTUTS.md` said the undo merge window was 1.5s where the constant is 1.2s.

The first two are mechanical: `path/to/file.ts N,NNN lines` names the file *and* the number, so both can
be checked. That is the shape this tool covers, and only that shape —— it does not try to read a bare
number out of a sentence, because "which file does this `2,982` describe?" is not decidable and a tool
that guesses would report the wrong line.

## The shape it matches

    `store.ts` 3,255 lines
    `src/plugin/outline/Outliner.tsx` 4,642 lines

The path is resolved by **suffix**: a document may write the full path or just the file name, and a name
that matches exactly one tracked file is unambiguous. A name that matches several, or none, is reported
—— an unresolvable citation is not a pass.

★ The count is compared against the file **as it is now**. A document that intentionally records a
historical measurement (a release note describing what a file used to be) would fail here; that is the
intended trade, because the alternative is the drift above. Record the measurement's date in the sentence
if it must stay.

## What it cannot see

A size stated in prose ("about 3,000 lines"), a count for something that is not a file (a function, a
table row), and any number whose subject is not on the same line. It says so rather than implying the
documents are otherwise number-free.

Exit 0 = every stated line count matches, 1 = at least one does not.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import script_log  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent

#: `path/to/file.ext N,NNN lines` —— a backticked path, a count, the word "lines".
CLAIM = re.compile(r"`([\w./@-]+\.[A-Za-z]{1,5})`\s+([\d,]{2,})\s+lines\b")

#: A line that lists several files with counts and says "lines" once, e.g.
#:   `Outliner.tsx` 4,642 lines, `store.ts` 3,255, `mount.ts` 2,353
#: The first file is caught by `CLAIM`; these catch the rest, which have no "lines" of their own.
#: ★ Restricted to lines that already contain the word "lines" —— without that anchor `path 123`
#:   would match unrelated prose (`…/api.ts 200` meaning a line inside the file, a port number, a count
#:   of call sites). The anchor is what makes the subject decidable.
CLAIM_LIST = re.compile(r"`([\w./@-]+\.[A-Za-z]{1,5})`\s+([\d,]{2,})\b")

#: Files whose prose is about a snapshot in time rather than the current tree.
ALLOWLIST: dict[str, str] = {
    "docs/AUDIT-FINDINGS.md": "the work queue quotes findings verbatim, including their counts",
}


def tracked_files() -> list[str]:
    res = subprocess.run(
        ["git", "ls-files", "-z"], cwd=REPO_ROOT, capture_output=True, text=True, check=False,
    )
    return [p for p in res.stdout.split("\0") if p]


def resolve(name: str, tracked: list[str]) -> tuple[str | None, str]:
    """Return (path, why-not). A bare file name is resolved by suffix, and ambiguity is an error."""
    if (REPO_ROOT / name).is_file():
        return name, ""
    hits = [t for t in tracked if t == name or t.endswith("/" + name)]
    if len(hits) == 1:
        return hits[0], ""
    if not hits:
        return None, "no tracked file has this name"
    return None, f"ambiguous: {', '.join(hits[:4])}"


def main() -> int:
    tracked = tracked_files()
    findings: list[str] = []
    checked = 0

    for rel in tracked:
        if not rel.endswith((".md", ".rst")):
            continue
        if rel in ALLOWLIST:
            continue
        try:
            text = (REPO_ROOT / rel).read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            claims: list[tuple[str, int]] = []
            for m in CLAIM.finditer(line):
                claims.append((m.group(1), int(m.group(2).replace(",", ""))))
            if "lines" in line:
                # The "lines" anchor is on the line, so the whole list belongs to it.
                for m in CLAIM_LIST.finditer(line):
                    name, want = m.group(1), int(m.group(2).replace(",", ""))
                    if (name, want) not in claims:
                        claims.append((name, want))
            for name, want in claims:
                path, why = resolve(name, tracked)
                if path is None:
                    findings.append(f"{rel}:{lineno}  `{name}` {want:,} lines —— {why}")
                    continue
                got = len((REPO_ROOT / path).read_text(encoding="utf-8").splitlines())
                checked += 1
                if got != want:
                    findings.append(
                        f"{rel}:{lineno}  `{name}` says {want:,} lines, {path} has {got:,}"
                    )

    if not findings:
        print(f"check-todo-counts: OK —— {checked} stated line count(s) all match")
        return 0

    print(f"check-todo-counts: FAIL —— {len(findings)} stated line count(s) do not match:\n")
    for f in findings:
        print(f"  {f}")
    print(
        "\n  Re-derive the number, or drop it —— a count in prose has no way to go red, which is how\n"
        "  four contradictory copies of one figure survived in docs/TESTING.md."
    )
    return 1


if __name__ == "__main__":
    with script_log.track("check-todo-counts"):
        sys.exit(main())
