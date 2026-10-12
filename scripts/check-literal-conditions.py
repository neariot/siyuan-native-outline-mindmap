#!/usr/bin/env python3
"""A `check()` whose condition is a literal —— it cannot vary, so it cannot go red.

★ Why this exists. Two were found by reading, one per round:

  · `core/map.test.ts` had `check('★ no blank line → the paragraph boundary is lost …', true, '')`. The name
    described a measured kernel behaviour and the condition asserted nothing; it was counted in the suite
    total for as long as it existed.
  · `core/empty-span.test.ts` had a "reverse check" that hand-built a `legacy` function and asserted **it**
    leaked `<span></span>`, never calling `htmlToSiyuanDom` —— a condition that *looks* like a call, which is
    why no syntax rule catches it (see "what it cannot see" below).

★ What it catches, and what it deliberately does not.

  It finds `check(...)` calls whose **condition is a literal keyword** (`true` / `false`), across line breaks,
  and separates the two meanings:

    1. **A hard failure on purpose** —— `check('…', false, 'why')` inside a `catch`, or when a required
       fixture is missing ("fail loudly instead of passing silently"). Legitimate: the condition *can*
       vary, because the branch may not run at all.
    2. **A dead assertion** —— a literal condition in a scope with no such reason. That is the defect.

  The two are told apart by **where the literal sits**: a failure guard is either inside a `catch`, or in the
  `else` of an `if` that checks a precondition ("if we cannot find the root, fail" / "if there is no fixture,
  fail loudly"). Measured —— the first version of this tool looked only for `catch` and reported the two `else`
  guards below as defects, which would have made it a tool that cries wolf on the pattern it is meant to
  protect.

  Only the second is reported as a finding; the guards are counted and shown, so the report stays trustworthy.
  This is why the tool parses the call rather than grepping a line: the condition sits on its own line in
  every real case, and `check` has more than one signature in this repository (`check(name, tree, mapped,
  want)` in `map-coverage-guard.test.ts`), so a "second argument is a literal" rule without arity awareness
  reports eleven legitimate cases as defects. That false positive was measured before this tool was written.

★ What it cannot see, and cannot be made to see by a syntax rule: a condition that is a real expression
  built **only from locals and literals** (the `leaked.includes(...)` shape). It parses as a call and depends
  on a data-flow fact —— that the value never derives from the product —— which is not in the syntax. Those
  are found by reading the check and asking "can this go red?", which is a judgement, not a pattern.

Exit status is 0 when no dead assertion is found, 1 when one is.
"""
from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCAN_DIRS = [ROOT / "src", ROOT / "e2e"]

CALL_RE = re.compile(r"\bcheck\s*\(")


def _strip_comments(text: str) -> str:
    """Remove `//` comments so a literal inside prose is not read as code.

    Block comments are left alone: this repository's test files use `//`, and stripping `/* */` naively
    breaks on a `*/` inside a string (the same trap `check-source-text-tests.py` documents).
    """
    return re.sub(r"//[^\n]*", "", text)


def _args(text: str, start: int) -> list[str]:
    """Top-level comma split of the call whose `(` is at `start`."""
    i = start
    depth = 1
    while i < len(text) and depth:
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
        i += 1
    body = text[start:i - 1]
    parts: list[str] = []
    depth = 0
    cur = ""
    for ch in body:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)
    return parts


def _is_failure_guard(text_before: str) -> tuple[bool, str]:
    """Is this literal condition a deliberate hard failure rather than a dead assertion?

    Three shapes are legitimate, and all three exist in this repository (each was found by this tool
    reporting a case that a reader then judged correct —— which is why they are enumerated here rather than
    guessed):

      · inside a `catch` —— "the layout threw, so fail" (three in `core/layout.test.ts`);
      · in the `else` of a precondition check —— "if we cannot find the root, fail" (one in
        `core/layout.test.ts`);
      · in the **body** of an `if` with no `else` —— "if there is no fixture, fail loudly instead of passing
        silently" (one in `hotkey-collision.test.ts`). The `if` body *is* the failure path, so a literal there
        is a deliberate hard stop, and the comment beside it says so.

    In both, the condition *can* vary: the branch may not run, and if it does, failing is the point. A dead
    assertion has no such reason —— nothing would ever make it true.

    Approximated by position: the nearest `catch` or `else` that is still open (no `}` since). Exact enough
    for the shapes here; the report names which shape it found so a misclassification is visible.
    """
    last_catch = text_before.rfind("catch")
    if last_catch >= 0 and text_before.rfind("}") < last_catch:
        return True, "in a catch"
    # The `else`/`if` and the `check(` can be separated by comments (measured: `hotkey-collision.test.ts`
    # explains *why* it fails loudly in two comment lines), so this compares brace positions rather than
    # looking for adjacency.
    for keyword, label in (("else", "in the else of a precondition check"),
                           ("if", "in the body of a precondition guard")):
        pos = text_before.rfind(keyword)
        if pos < 0:
            continue
        open_brace = text_before.find("{", pos)
        if open_brace >= 0 and text_before.rfind("}") < open_brace:
            return True, label
    return False, ""


def main(argv: list[str]) -> int:
    del argv
    findings: list[str] = []
    deliberate: list[str] = []
    scanned = 0

    for d in SCAN_DIRS:
        if not d.is_dir():
            continue
        for p in sorted(list(d.rglob("*.test.ts")) + list(d.rglob("*.test.tsx"))):
            clean = _strip_comments(p.read_text(encoding="utf-8", errors="replace"))
            rel = p.relative_to(ROOT)
            for m in CALL_RE.finditer(clean):
                scanned += 1
                parts = _args(clean, m.end())
                if len(parts) < 2:
                    continue
                cond = parts[1].strip()
                if cond not in ("true", "false"):
                    continue
                line = clean[: m.start()].count("\n") + 1
                where = f"{rel}:{line}"
                guarded, why = _is_failure_guard(clean[: m.start()])
                if guarded:
                    deliberate.append(f"  · {where}  ({why} —— a deliberate hard failure)")
                else:
                    findings.append(f"  · {where}  condition is literally `{cond}`")

    print(f"literal-condition checks: {scanned} check() call(s) scanned over {len(SCAN_DIRS)} dir(s)")
    if deliberate:
        print(f"\n{len(deliberate)} literal condition(s) that are deliberate failure guards —— not findings:")
        for d in deliberate:
            print(d)

    if findings:
        print(f"\n{len(findings)} check(s) whose condition is a literal and has no such reason:")
        for f in findings:
            print(f)
        print("\nA condition that is a literal cannot vary, so the check cannot go red: it inflates the suite")
        print("total while asserting nothing. Either assert the claim (against the shipped code) or delete it.")
        print("★ What this cannot see: a condition built only from locals and literals —— it parses as a call,")
        print("  and detecting it needs data flow, not syntax. Those are found by reading the check.")
        return 1

    print("\nliteral-condition checks: no dead assertion found")
    print("★ It sees only literal keywords. A condition like `leaked.includes(x)` where `leaked` is built")
    print("  entirely from locals is vacuous too, and looks like a call —— those need a reader.")
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
    try:
        from script_log import track
    except ImportError:
        sys.exit(main(sys.argv[1:]))
    with track("check-literal-conditions"):
        sys.exit(main(sys.argv[1:]))
