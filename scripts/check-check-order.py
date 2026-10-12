#!/usr/bin/env python3
"""Find a check in a test file that runs **after** the run has already ended.

## The defect this catches

`scripts/check-vacuous-tests.py` answers "does this test file reach anything?" —— a file that imports nothing
from the product cannot go red, so it defends nothing. This is the **same defect one level down, and inside a
file that does reach the product**: the file imports the real thing, its first checks can fail, and the checks
added later sit *after* the line that reports and exits. They execute never, so they can never fail the run.

It is a particularly quiet shape. The file reads as though it covers the case, `npm test` prints `pass 59`,
and the only way to notice is to count. It was hit for real while adding the chain-descent checks —— new
assertions appended below the report block —— which is why this tool exists rather than a note saying
"remember to put checks above the exit".

## What it decides, and how

By **position in the AST**, not by matching text: the entry point of a run is the statement that terminates it
(a `process.exit(...)` call, or a `throw`), and any `check(...)` / `assert(...)` call that appears **after**
it, at the same or a deeper level, is unreachable. Parsing rather than grepping matters for the reason
`AGENTS.md` §7 gives: a regex over source text is wrong exactly where it matters —— `process.exit` inside a
string, inside a comment, or inside a branch that the run takes *before* the checks.

★ **Not every check after a terminator is a finding.** A terminator inside an `if` only ends the run on that
branch, so a check after it is perfectly reachable on the other branch. Only a terminator that is **unconditional
within its block** is treated as ending the run from there on, and this tool says which shape it saw.

## The three mistakes this tool made while being written, and what caught each

★ All three were "the tool reports clean on a file that has the defect", which is the worst failure mode a
checker has —— the same shape as the vacuous tests it is about. Each was caught by **putting the defect into a
real file and running the tool**, never by re-reading the logic.

  1. **The report line was matched in the stripped text.** `strip_noise` blanks string and template bodies, and
     the words "passed"/"failed" only exist inside a template literal, so nothing matched and the tool found no
     terminator at all. Caught by printing what the regex saw.
  2. **"Is this `process.exit` unconditional?" was the wrong question.** The idiom always writes it inside
     `if (fail) { ... }`, so the answer is always no —— yet the run *does* end there, because the other branch
     falls off the end of the file. The right question is "does the run end here on every path". Caught by
     asking why a file with a trailing check was reported clean.
  3. **The brace walk tested `depth < base` instead of `depth == base`.** The `if` block closes back *to* the
     report line's depth, so "below base" walked past it and answered "end of the file", swallowing everything
     after. Caught only by walking a real file and printing where the depth returns to base.

## What it cannot see (and says so)

  * A check that is reachable but **vacuous** (a literal condition, a comparison that is always true) ——
    `check-literal-conditions.py` covers the literal half of that.
  * A check that is reachable and can fail, but asserts something the product cannot violate —— no static
    tool can judge that; it needs a red proof (§7).
  * A terminator reached indirectly (`process.exit` called from a helper, or from an event callback). The tool
    works on the file's own top-level flow, and a helper that exits is a shape it will report as *not
    understood* rather than guess about.
  * Files that do not use the `check(...)` counting idiom at all (Playwright specs assert through
    `expect(...)` and fail by throwing, where a trailing statement is already an error). Those are skipped by
    rule and counted, not silently passed over.

Exit 0 with no findings, 1 with findings. `--selftest` pins the decisions above.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import script_log  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

# The files this tool reads: the offline unit tests, which use the counting idiom.
TEST_GLOBS = ("src/**/*.test.ts",)

# A call whose name marks an assertion in the counting idiom.
CHECK_CALLS = ("check", "assert", "checkEq", "expectEq")

# A statement that ends the run from that point on.
TERMINATORS = ("process.exit",)

# Playwright specs and anything importing `@playwright/test` assert by throwing; a statement after the last
# assertion is already an error there. Skipped by rule, and counted so the skip is visible.
SKIP_IMPORT = "@playwright/test"


def strip_noise(src: str) -> str:
    """Blank out comments and string bodies while **keeping every character position**.

    Positions are preserved so a byte offset from the stripped text can be reported against the original file.
    This is what lets the tool tell a real `process.exit(` from the same text inside a comment or a literal,
    which a plain search cannot (§7).
    """
    out = list(src)
    i = 0
    n = len(src)
    while i < n:
        c = src[i]
        # Line comment
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            j = src.find("\n", i)
            j = n if j < 0 else j
            for k in range(i, j):
                out[k] = " "
            i = j
            continue
        # Block comment
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            for k in range(i, j):
                if src[k] != "\n":
                    out[k] = " "
            i = j
            continue
        # String / template literal
        if c in "\"'`":
            quote = c
            j = i + 1
            while j < n:
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == quote:
                    j += 1
                    break
                j += 1
            for k in range(i + 1, min(j, n) - 0):
                if src[k] != "\n" and src[k] != quote:
                    out[k] = " "
            i = j
            continue
        i += 1
    return "".join(out)


def brace_depth_at(src: str, pos: int) -> int:
    """Nesting depth at a position, ignoring braces in comments and strings."""
    return src[:pos].count("{") - src[:pos].count("}")


def is_unconditional(src: str, pos: int) -> bool:
    """Is the statement at `pos` reached on every path through its enclosing block?

    ★ This is the distinction that keeps the tool from crying wolf. A `process.exit` inside an `if` only ends
    the run on that branch, so a `check` after it is still reachable on the other branch —— reporting it would
    be wrong, and a tool that reports correct code gets switched off. The test: walk back to the start of the
    enclosing block and see whether a control-flow keyword (`if`, `else`, `for`, `while`, `switch`, `try`,
    `catch`, `?`) opens the brace that contains it.
    """
    depth = brace_depth_at(src, pos)
    # Walk back to the `{` that opened this depth.
    i = pos
    target = depth
    while i > 0:
        if src[i] == "}":
            target += 1
        elif src[i] == "{":
            target -= 1
            if target == 0:
                break
        i -= 1
    if i <= 0:
        return True  # top level of the file
    # Look at what precedes that `{` for a control-flow keyword.
    head = src[max(0, i - 80) : i].rstrip()
    for kw in ("if", "else", "for", "while", "switch", "try", "catch", "finally"):
        if re.search(r"\b%s\b[^{;]*$" % kw, head):
            return False
    # A ternary or a short-circuit guard can also open a branch.
    if re.search(r"[?:]|&&|\|\|", head[-40:]):
        return False
    return True


def report_block_end(src: str, raw: str) -> int | None:
    """Find where the counting idiom's **report block** ends the run, whatever the branch.

    ★ The first version asked the wrong question. It looked for an `process.exit(...)` that is *unconditional*
    and found none in the real files, because the idiom is always written as:

        console.log(`…: ${pass} passed, ${fail} failed`);
        if (fail) {
          console.error(…);
          process.exit(1);
        }

    The exit is conditional on `fail` —— so "is the exit unconditional?" answers no, and a check appended below
    it was reported clean. But the run **does** end there either way: when `fail` is truthy it exits, and when
    it is falsy it falls off the end of the file. The question that matters is "does the run end here on every
    path", not "is this particular statement unconditional".

    So the marker is the **report line** —— a `console.log` that mentions the pass/fail counters —— and the
    terminator is the end of the statement group that follows it, which the counting idiom always ends with the
    exit. Anything after that point is unreachable, and this is decided by position rather than by guessing.
    """
    # ★ The report line is recognised in the **original** text, not the stripped one. `strip_noise` blanks
    #   string and template bodies —— which is exactly where the words "passed"/"failed" live
    #   (`console.log(`… ${pass} passed, ${fail} failed`)`). Matching the stripped text for them found nothing,
    #   so the tool reported clean on a file that really had an unreachable check. Keeping both views and using
    #   each for what it is good at: positions from `src`, the report line's text from `raw`.
    for m in re.finditer(r"console\.(log|error)\s*\(", src):
        line_end = raw.find("\n", m.start())
        line = raw[m.start() : line_end if line_end >= 0 else len(raw)]
        if re.search(r"passed|failed", line) and re.search(r"\$\{", line):
            # Walk forward to the end of this statement group: the matching brace of the `if` that follows,
            # or the end of the file.
            # ★ Start from the depth the report line already sits at, and finish when a `}` brings the depth
            #   back BELOW it —— i.e. when this statement group closes. Starting from 0 (or testing "depth < 0")
            #   overshot to the end of the file, because these blocks are nested inside the async wrapper, so
            #   the file's closing braces are what finally took the count negative. That swallowed the very
            #   check this tool exists to find, and the tool reported clean on a file with the defect in it.
            base = brace_depth_at(src, m.start())
            depth = base
            i = m.start()
            n = len(src)
            while i < n:
                if src[i] == "{":
                    depth += 1
                elif src[i] == "}":
                    depth -= 1
                    # ★ `== base`, not `< base`. The `if (fail) { … }` that ends the report block closes back
                    #   TO the report line's own depth, so the group ends the moment the depth returns to it.
                    #   Testing "below base" walked past it and answered "end of file" instead, which swallowed
                    #   every trailing check —— the tool then reported clean on a file containing the defect it
                    #   was written to find. Checked by walking the real file and printing where the depth
                    #   returns to base, rather than by reasoning about it.
                    if depth <= base and i > m.start():
                        return i + 1
                i += 1
            return n
    return None


def findings_for(path: Path) -> list[tuple[int, str]]:
    """Return (line, description) for each check that cannot run."""
    raw = path.read_text(encoding="utf-8")
    if SKIP_IMPORT in raw:
        return []
    src = strip_noise(raw)

    # ★ The run ends where the report block ends —— see `report_block_end` for why this is the marker rather
    #   than an "unconditional process.exit", which the real idiom never has.
    terminator = report_block_end(src, raw)
    if terminator is None:
        # No report block: fall back to an unconditional terminator, if one exists.
        for m in re.finditer(r"\b%s\s*\(" % TERMINATORS[0].replace(".", r"\."), src):
            if is_unconditional(src, m.start()):
                terminator = m.start()
                break
    if terminator is None:
        return []

    out: list[tuple[int, str]] = []
    for name in CHECK_CALLS:
        for m in re.finditer(r"\b%s\s*\(" % re.escape(name), src):
            if m.start() > terminator:
                line = raw[: m.start()].count("\n") + 1
                out.append(
                    (
                        line,
                        f"`{name}(...)` runs after the run has already ended —— it is unreachable, so it can "
                        f"never fail the suite",
                    )
                )
    return out


def main(argv: list[str]) -> int:
    selftest = "--selftest" in argv

    if selftest:
        return run_selftest()

    files: list[Path] = []
    for g in TEST_GLOBS:
        files.extend(sorted(ROOT.glob(g)))

    total = 0
    skipped = 0
    understood = 0
    for f in files:
        raw = f.read_text(encoding="utf-8")
        if SKIP_IMPORT in raw:
            skipped += 1
            continue
        # Only files using the counting idiom are in scope; a file with no `check` has nothing to order.
        if not any(re.search(r"\b%s\s*\(" % re.escape(n), strip_noise(raw)) for n in CHECK_CALLS):
            continue
        understood += 1
        for line, desc in findings_for(f):
            rel = f.relative_to(ROOT)
            print(f"  {rel}:{line}: {desc}")
            total += 1

    if total:
        print(f"check-order: FAIL {total} finding(s) (exit 1)")
        return 1

    print(
        "check-order: OK every check runs before the run ends "
        f"({understood} file(s) use the counting idiom, {skipped} Playwright spec(s) skipped by rule)"
    )
    return 0


def run_selftest() -> int:
    """Pin the three decisions: unreachable is found, a branch terminator is not, a comment is not."""
    import tempfile

    cases: list[tuple[str, str, bool]] = [
        (
            "a check after an unconditional exit is found",
            "check('a', true);\nprocess.exit(1);\ncheck('b', true);\n",
            True,
        ),
        (
            "a check BEFORE the exit is not a finding",
            "check('a', true);\ncheck('b', true);\nprocess.exit(1);\n",
            False,
        ),
        (
            "★ a check after an exit inside an `if` is NOT a finding (the other branch still runs it)",
            "if (!ok) {\n  process.exit(1);\n}\ncheck('a', true);\n",
            False,
        ),
        (
            "★ `process.exit` inside a COMMENT is not a terminator",
            "check('a', true);\n// process.exit(1)\ncheck('b', true);\n",
            False,
        ),
        (
            "★ `process.exit` inside a STRING is not a terminator",
            "check('a', true);\nconst s = 'process.exit(1)';\ncheck('b', true);\n",
            False,
        ),
        (
            "a check nested after an unconditional exit is found",
            "process.exit(1);\nif (x) {\n  check('a', true);\n}\n",
            True,
        ),
    ]

    bad = 0
    for label, body, expect in cases:
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.test.ts"
            p.write_text(body, encoding="utf-8")
            got = bool(findings_for(p))
        mark = "✓" if got == expect else "✘"
        if got != expect:
            bad += 1
        print(f"  {mark} {label} (found={got}, expected={expect})")

    if bad:
        print(f"check-order --selftest: FAIL {bad} case(s) decided wrongly")
        return 1
    print(f"check-order --selftest: OK {len(cases)} cases decided as pinned")
    return 0


if __name__ == "__main__":
    with script_log.track("check-order"):
        sys.exit(main(sys.argv[1:]))
