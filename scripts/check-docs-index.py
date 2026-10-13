#!/usr/bin/env python3
"""Check that every entry the pitfall index advertises really exists.

## Why this exists

`docs/PITFALLS.md` is an index: each topic row lists the entries (`6.9b/d`, `4.1–4.7`, ...) that
live in that file. Nothing kept those two in sync, so a row could advertise entries that had been
renamed, merged or deleted —— and the reader would go looking for an entry that is not there.

It used to live in `.tmp/` as a one-off, which meant (a) it was not committed and could vanish, and
(b) **it always exited 0**: the verdict was a printed word a human had to read, so it could never
fail a build. Both are fixed here: the file is committed and the exit code carries the verdict.

## Usage

    python3 scripts/check-docs-index.py          # prints the count and any dangling references

## Exit code

0 when every advertised entry exists, 1 otherwise (naming each missing one).
"""

import io
import re
import script_log
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
INDEX = REPO_ROOT / "docs" / "PITFALLS.md"

# A row looks like:  | [`pitfalls/data.md`](pitfalls/data.md) | ... | `1.1`–`1.10` |
ROW = re.compile(r"^\|\s*\[`(pitfalls/[^`]+)`\]\([^)]+\)\s*\|.*\|\s*(.+?)\s*\|\s*$")
# `6.9b/d` / `6.9f–m` / `1.1–1.10` and plain `4.3`
SHORT_RANGE = re.compile(r"^(\d+\.\d+)([a-z](?:–[a-z])?(?:/[a-z](?:–[a-z])?)*)$")
LONG_RANGE = re.compile(r"^(\d+\.\d+)–(\d+\.\d+)$")
# Suffix ranges over multi-letter suffixes: `6.9aa`–`6.9cc` rejoins to `6.9aa–6.9cc`.
SUFFIX_RANGE = re.compile(r"^(\d+\.\d+)([a-z]+)–\d+\.\d+([a-z]+)$")


def heading_ids(path: Path) -> set:
    """The entry numbers this file really defines (`## 1.3 ...`, `### 6.9b ...`)."""
    found = set()
    for line in io.open(path, encoding="utf-8").read().split("\n"):
        match = re.match(r"^#{2,3}\s+(\d+(?:\.\d+[a-z]*)?)\b", line)
        if match:
            found.add(match.group(1))
    return found


def expand(spec: str) -> set:
    """Turn an index cell (`` `4.1`–`4.7`, `6.9c/e/n` ``) into the numbers it advertises.

    ★ Cells join backtick spans with an en dash (`1.1`–`1.10`): matching per-span tokens alone
    sees only the two endpoints and never verifies the middle. Dash-linked spans are rejoined
    first so LONG_RANGE fires on the real range.
    """
    out = set()
    # Split while keeping spans; a – between two spans links them into one range token.
    parts = re.split(r"(`[^`]+`)", spec)
    tokens: list[str] = []
    acc: str | None = None
    for part in parts:
        if part.startswith("`") and part.endswith("`") and len(part) >= 2:
            inner = part[1:-1]
            acc = inner if acc is None else acc + "–" + inner
        elif acc is not None and part.strip() in ("–", "-"):
            continue  # dash links the spans around it; keep accumulating
        else:
            if acc is not None:
                tokens.append(acc)
                acc = None
    if acc is not None:
        tokens.append(acc)
    for token in tokens:
        for piece in [p.strip() for p in token.split(",") if p.strip()]:
            short = SHORT_RANGE.match(piece)
            if short:
                base, rest = short.groups()
                for segment in rest.split("/"):
                    if "–" in segment:
                        low, high = segment.split("–")
                        for code in range(ord(low), ord(high) + 1):
                            out.add(base + chr(code))
                    else:
                        out.add(base + segment)
                continue
            long = LONG_RANGE.match(piece)
            if long:
                low, high = long.groups()
                prefix = low.split(".")[0]
                for number in range(int(low.split(".")[1]), int(high.split(".")[1]) + 1):
                    out.add("%s.%d" % (prefix, number))
                continue
            suffix = SUFFIX_RANGE.match(piece)
            if suffix:
                stem, low, high = suffix.groups()
                # Letter-suffixes advance as base-26 counters, same length both ends
                # (aa→ab→…→az→ba…; mixed lengths are rejected as malformed).
                if len(low) == len(high):
                    cur = list(low)
                    while True:
                        out.add(stem + "".join(cur))
                        if "".join(cur) == high:
                            break
                        # increment base-26 with carry
                        i = len(cur) - 1
                        while i >= 0:
                            if cur[i] != "z":
                                cur[i] = chr(ord(cur[i]) + 1)
                                break
                            cur[i] = "a"
                            i -= 1
                        if i < 0:
                            break  # overflowed past high; stop rather than loop
                else:
                    out.add(piece)
                continue
            out.add(piece)
    return out


def main() -> int:
    if not INDEX.is_file():
        print(f"no index at {INDEX}", file=sys.stderr)
        return 1

    checked = 0
    dangling = []
    silent = []
    for number, line in enumerate(io.open(INDEX, encoding="utf-8").read().split("\n"), start=1):
        row = ROW.match(line)
        if not row:
            continue
        topic, spec = row.groups()
        advertised = expand(spec)
        # ★ A row that advertises nothing is not "clean", it is a check that stopped working: `expand`
        #   only reads backtick spans, so dropping the backticks (or reshaping the cell) would otherwise
        #   report success over a row that no longer contributes a single reference.
        if not advertised:
            silent.append(f"{INDEX.name}:{number} advertises no entry ({topic})")
            continue
        present = heading_ids(REPO_ROOT / "docs" / topic)
        for entry in sorted(advertised):
            checked += 1
            if entry not in present:
                dangling.append(f"{topic}: {entry}")

    if dangling or silent:
        print(f"docs index: {checked} references checked, {len(dangling)} dangling")
        for item in dangling:
            print(f"  - {item}")
        for item in silent:
            print(f"  - no reference in this row: {item}")
        return 1

    print(f"docs index: {checked} references checked, none dangling")
    return 0


if __name__ == "__main__":
    with script_log.track("check-docs-index"):
        sys.exit(main())
