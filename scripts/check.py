#!/usr/bin/env python3
"""Every fast gate in one command, with the verdict and the cost of each one.

## Why this exists

Checking "am I green?" used to be four commands typed from memory (`npx tsc --noEmit`,
`scripts/run-tests.py`, `scripts/check-docs-index.py`, `scripts/verify-css-scope.py`). Remembered
procedures get skipped —— and one of those four reported its verdict as a printed word while always
exiting 0, so even running it proved nothing. This entry point runs the gates, prints a table with
each gate's duration, and exits non-zero if any gate failed.

## What is deliberately NOT here

Anything that needs a browser, a build, or a kernel: `npm run build`, `npm run test:e2e`,
`npm run verify`, `npm run verify:android`. This script is the **foreground** layer, so it may only
contain gates that finish in seconds. A slow gate belongs in the background with a log under
`.logs/` (AGENTS.md section 1), and `scripts/script_log.py --report` is where you check a gate's
real cost before adding it here.

## Usage

    python3 scripts/check.py                # every gate that can run right now
    python3 scripts/check.py --list         # show the gates, run nothing
    python3 scripts/check.py --only unit,typecheck
    python3 scripts/check.py --verbose      # stream each gate's full output

## Exit code

0 when every gate that ran passed; 1 when any gate failed. A gate that is skipped prints **why**
(for example: no build output yet) —— a skip is an explicit absence, never a silent pass.
"""

import argparse
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import script_log  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent

GATES = [
    {
        "name": "typecheck",
        "command": "npx tsc --noEmit",
        "why": "the TypeScript compiler is the only authority on types",
    },
    {
        "name": "unit",
        "command": "python3 scripts/run-tests.py",
        "why": "offline unit tests, no SiYuan needed",
    },
    {
        # ★ The defect that cost three features and a fourth field: a model field with a control, a renderer
        #   and no read path, so the value was gone on reload and nothing could say so. See the module
        #   docstring for why fold state is reported but not failed.
        "name": "unsaved-fields",
        "command": "python3 scripts/check-unsaved-fields.py",
        "why": "every node model field is either restored by a reader or named by the runtime",
        "requires": lambda: (REPO_ROOT / "scripts" / "check-unsaved-fields.py").is_file(),
    },
    {
        # ★ A doc citing a test that no longer exists advertises coverage nothing provides (three entries
        #   pointed at a deleted file), and a test that imports nothing cannot go red. The first fails, the
        #   second prints -- see the module docstring for why it is a lower bound.
        "name": "vacuous-tests",
        # --hollow-advisory is explicit and says what it defers: citations that name a test which reaches
        # nothing are queued work (docs/AUDIT-FINDINGS.md, `test-suite`), and the tool still fails on
        # them by default. Everything else this gate checks still fails.
        "command": "python3 scripts/check-vacuous-tests.py --hollow-advisory",
        "why": "every test a doc cites exists, and the tests that cannot go red are named",
        "requires": lambda: (REPO_ROOT / "scripts" / "check-vacuous-tests.py").is_file(),
    },
    {
        "name": "docs-index",
        "command": "python3 scripts/check-docs-index.py",
        "why": "every entry docs/PITFALLS.md advertises really exists",
    },
    {
        "name": "language",
        "command": "python3 scripts/audit-language.py",
        "why": "the section 2 language policy, over every file type at once",
        "requires": lambda: (REPO_ROOT / "scripts" / "audit-language.py").is_file(),
    },
    {
        # ★ The auditor's own self-test. It was red — its source carried a Chinese example its own
        #   scanner flags — and no gate ran it, so nothing noticed for as long as it had been that way.
        #   A tool whose failure path nothing exercises is a tool that reports whatever it likes.
        "name": "language-selftest",
        "command": "python3 scripts/audit-language.py --selftest",
        "why": "the language auditor still decides each category the way its cases pin down",
        "requires": lambda: (REPO_ROOT / "scripts" / "audit-language.py").is_file(),
    },
    {
        # ★ Chinese fixture text is a function label, never content. A fixture is renamed to fit the
        #   vocabulary, never the other way round.
        "name": "fixture-text",
        "command": "python3 scripts/check-fixture-text.py",
        "why": "every Chinese fixture is spelled with function words, and no vocabulary entry is unused",
        "requires": lambda: (REPO_ROOT / "scripts" / "fixture-vocabulary.txt").is_file(),
    },
    {
        "name": "i18n-keys",
        # UI text has exactly one home (the catalogues) since the fallback arguments were removed, so
        # "a key that does not exist" is now the failure mode that used to be papered over.
        "command": "python3 scripts/check-i18n-keys.py",
        "why": "every `t('<key>')` exists in both catalogues, and no entry is dead text",
    },
    {
        "name": "dead-props",
        # A component that invokes a callback prop no call site supplies is an affordance that looks wired
        # and is not (measured: the mind map's to-do checkbox). Optional, so nothing complains.
        "command": "npx tsx scripts/check-dead-props.ts",
        "why": "every optional callback prop a component invokes is supplied by a call site",
    },
    {
        "name": "privacy",
        "command": "python3 scripts/audit-privacy.py",
        "why": "no id-shaped literal and no credential literal in the source",
    },
    {
        "name": "dead-css",
        # Node, not Python: the stylesheet is parsed with postcss and the selectors with
        # postcss-selector-parser (the parsers the build already uses), because a selector is not a
        # string and a regex over CSS is wrong exactly where it matters.
        "command": "node scripts/check-dead-css.mjs",
        "why": "every `om-` / `mm-` class in src/styles.css can actually be put on an element",
    },
    {
        "name": "verify-live-selftest",
        # The live check needs a desktop and CDP, so its criteria cannot run here —— but they can be judged
        # on recorded measurements, and one of them was `'"host" in result`: satisfied by the JSON whatever
        # the widths were, so the regression it named could not fail it.
        "command": "python3 scripts/verify-live.py --selftest",
        "why": "the live checks' criteria still decide the cases they were written for",
        "requires": lambda: (REPO_ROOT / "scripts" / "verify-live.py").is_file(),
    },
    {
        "name": "css-scope",
        "command": "python3 scripts/verify-css-scope.py",
        "why": "no unscoped bare selector survived the build",
        "requires": lambda: (REPO_ROOT / "dist-plugin" / "index.css").is_file(),
    },
]

SKIP_REASON = {
    "language": "scripts/audit-language.py does not exist yet",
    "css-scope": "no dist-plugin/index.css —— run `npm run build` first; the gate reads build output",
}


def tail(text: str, lines: int = 12) -> str:
    rows = [row for row in text.strip().splitlines() if row.strip()]
    return "\n".join(rows[-lines:])


def run_gate(gate: dict, verbose: bool) -> tuple:
    """Run one gate. Returns (name, verdict, seconds, note)."""
    if verbose:
        print(f"\n$ {gate['command']}")
    started = time.monotonic()
    done = subprocess.run(gate["command"], shell=True, cwd=REPO_ROOT, capture_output=True, text=True)
    seconds = time.monotonic() - started
    output = (done.stdout or "") + (done.stderr or "")

    if verbose or done.returncode != 0:
        print(tail(output, 40 if verbose else 12))
    else:
        last = tail(output, 1)
        if last:
            print(f"      {last}")

    return gate["name"], ("ok" if done.returncode == 0 else f"FAILED (exit {done.returncode})"), seconds, ""


def main() -> int:
    parser = argparse.ArgumentParser(description="Run every fast gate and report a verdict per gate.")
    parser.add_argument("--list", action="store_true", help="list the gates and exit")
    parser.add_argument("--only", help="comma-separated gate names to run")
    parser.add_argument("--verbose", action="store_true", help="stream each gate's full output")
    args = parser.parse_args()

    if args.list:
        for gate in GATES:
            ready = "" if "requires" not in gate or gate["requires"]() else "  [its prerequisite is missing]"
            print(f"{gate['name']:<12} {gate['command']}{ready}\n{'':<12} {gate['why']}")
        return 0

    # `is not None`, not truthiness: `--only ""` is an explicit empty selection, not "all gates".
    if args.only is None:
        wanted = None
    else:
        wanted = [name.strip() for name in args.only.split(",") if name.strip()]
        if not wanted:
            print("--only was given but names no gate (see --list)", file=sys.stderr)
            return 1
    unknown = [name for name in wanted or [] if name not in {gate["name"] for gate in GATES}]
    if unknown:
        print(f"unknown gate(s): {', '.join(unknown)} (see --list)", file=sys.stderr)
        return 1

    selected = [gate for gate in GATES if wanted is None or gate["name"] in wanted]
    print(f"fast gates ({len(selected)})\n")

    results = []
    for gate in selected:
        # ★ `requires` must return a bool: a Path is always truthy, so a lambda that returned one made
        #   this branch dead and the gate ran against a missing file instead of being skipped with a reason.
        if "requires" in gate and not gate["requires"]():
            print(f"[skip] {gate['name']}: {SKIP_REASON.get(gate['name'], 'a required file is missing')}")
            results.append((gate["name"], "skipped", 0.0, SKIP_REASON.get(gate["name"], "")))
            continue
        name, verdict, seconds, note = run_gate(gate, args.verbose)
        if gate.get("report_only") and verdict != "ok":
            print(f"[rept] {name:<12} {seconds:>6.2f}s  {verdict}  (report only, does not fail this run)")
            results.append((name, "report-only", seconds, gate["why"]))
            continue
        print(f"[{'ok  ' if verdict == 'ok' else 'FAIL'}] {name:<12} {seconds:>6.2f}s  {verdict}")
        results.append((name, verdict, seconds, note))

    slowest = max((item[2] for item in results), default=0.0)
    failed = [item for item in results if item[1].startswith("FAILED")]
    print(f"\ntotal {sum(item[2] for item in results):.2f}s   slowest gate {slowest:.2f}s")

    if failed:
        print(f"{len(failed)} gate(s) failed: {', '.join(item[0] for item in failed)}")
        return 1

    skipped = [item[0] for item in results if item[1] == "skipped"]
    reporting = [item[0] for item in results if item[1] == "report-only"]
    tail = []
    if skipped:
        tail.append(f"skipped: {', '.join(skipped)}")
    if reporting:
        tail.append(f"report only: {', '.join(reporting)}")
    print("all gates passed" + (f" ({'; '.join(tail)})" if tail else ""))
    return 0


if __name__ == "__main__":
    with script_log.track("check"):
        sys.exit(main())
