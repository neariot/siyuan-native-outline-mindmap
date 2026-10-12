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
        # ★ Dead code is not neutral: `SiYuanStore.saveNodes` writes documents as kramdown, and kramdown is
        #   the only path that can carry a heading level — while the live path writes DOM and cannot. So a
        #   reader that refuses list lines, a live writer that cannot carry a level, and a **dead** writer
        #   that can, added up to a toolbar (H1/H2/H3) and a documented shortcut (`# ` + space) that
        #   silently do nothing. Nothing failed; the dead method made the feature look implemented.
        #   The whole list is printed for a reader. Strict, with no advisory flag: the heading decision is
        #   made and `saveNodes` —— the one method that claimed a capability while nothing called it —— is
        #   deleted, so a new claim fails the build immediately rather than being queued. (While it was being
        #   worked through this ran advisory and printed loudly instead: a gate that cannot fail is a gate
        #   that is not there.)
        "name": "dead-methods",
        "command": "python3 scripts/check-dead-methods.py --strict",
        "why": "every uncalled store method is accounted for, and none still claims a capability",
        "requires": lambda: (REPO_ROOT / "scripts" / "check-dead-methods.py").is_file(),
    },
    {
        # ★ The release procedure was a rule held in someone's head: bump the version, remember which files
        #   carry it, write the note. Three files carry it (`package.json`, `src/plugin/plugin.json`, and
        #   `package-lock.json`, which npm generates from the first), and the bazaar reads the Release while
        #   SiYuan reads `plugin.json` —— so a half-bumped version ships a plugin reporting a version
        #   different from the one it was released as, with nothing going red.
        #   The check is deliberately narrow: it compares the two **authored** sources and asks for the release
        #   note, and it says in its own output that it does not verify the tag or the Release, because those
        #   are created outside the repository and need the user's consent (section 4) —— a gate must not
        #   imply it verified something it cannot see.
        "name": "versions",
        "command": "python3 scripts/check-versions.py",
        "why": "the versioned sources agree, and the current version has release notes",
        "requires": lambda: (REPO_ROOT / "scripts" / "check-versions.py").is_file(),
    },
    {
        # ★ Two dead assertions were found by reading, one per round: a `check(..., true, '')` in
        #   `core/map.test.ts` whose name described a measured kernel behaviour while the condition asserted
        #   nothing, and a "reverse check" in `core/empty-span.test.ts` that asserted a locally built strawman
        #   rather than the shipped function. This catches the first class mechanically.
        #   Five of the six literal conditions in the tree are **correct** —— a hard failure inside a `catch`,
        #   or in a precondition guard ("if there is no fixture, fail loudly instead of passing silently"),
        #   where the condition *can* vary because the branch may not run. The tool tells them apart by
        #   position and prints which shape it classified, so a misclassification is visible rather than
        #   silent; only an unexplained literal fails.
        "name": "literal-conditions",
        "command": "python3 scripts/check-literal-conditions.py",
        "why": "no check() asserts on a literal condition it can never vary from",
        "requires": lambda: (REPO_ROOT / "scripts" / "check-literal-conditions.py").is_file(),
    },
    {
        # ★ `listFolders` had `const t = Date.now()` in a module that imports the i18n function as `t` and
        #   calls it in 20-odd places. Harmless there by luck —— that one method translates nothing —— and a
        #   confusing compile error the moment it does ("Type 'number' has no call signatures", pointing at
        #   the call, not at the declaration). There is no ESLint in this repository, so `no-shadow` cannot be
        #   switched on; the rule would otherwise rest on remembering to look.
        #   Reports a shortlist rather than failing: shadowing is legal TypeScript with no diagnostic, so the
        #   scan is textual and says so when it prints.
        "name": "i18n-shadow",
        "command": "python3 scripts/check-i18n-shadow.py",
        "why": "no local binding shadows the i18n `t` in a module that translates",
        "requires": lambda: (REPO_ROOT / "scripts" / "check-i18n-shadow.py").is_file(),
    },
    {
        # ★ A doc citing a test that no longer exists advertises coverage nothing provides (three entries
        #   pointed at a deleted file), and a test that imports nothing cannot go red. The first fails, the
        #   second prints -- see the module docstring for why it is a lower bound.
        "name": "vacuous-tests",
        # ★ Strict, with no advisory flag: the sixteen citations that named a hollow test are all fixed, so
        #   a new one fails the build immediately rather than being queued. (While they were being worked
        #   through, `--hollow-advisory` printed them loudly instead: a gate that cannot fail is a gate that
        #   is not there.)
        "command": "python3 scripts/check-vacuous-tests.py",
        "why": "every cited test exists, and every cited test can reach the product",
        "requires": lambda: (REPO_ROOT / "scripts" / "check-vacuous-tests.py").is_file(),
    },
    {
        # ★ The same defect as `vacuous-tests`, one level down and **inside** a file that does reach the
        #   product: the file imports the real thing, its first checks can fail, and a check added later sits
        #   below the line that reports and exits. It runs never, so it can never fail the run, and the file
        #   reads as though the case is covered. Hit for real while adding the chain-descent checks.
        "name": "check-order",
        "command": "python3 scripts/check-check-order.py",
        "why": "every check in a test file runs before the run ends",
        "requires": lambda: (REPO_ROOT / "scripts" / "check-check-order.py").is_file(),
    },
    {
        # ★ A command in prose is never executed by anything, so nothing noticed that the Chinese README
        #   told users to run a flag the build does not have, or that two scripts served workflows that no
        #   longer exist. This checks the part a script can decide: that every command a document names
        #   resolves, and that every script is either documented or an explicit allowlist decision.
        "name": "documented-commands",
        "command": "python3 scripts/check-documented-commands.py",
        "why": "every `npm run X` a document names exists, and every script is documented or allowlisted",
        "requires": lambda: (REPO_ROOT / "scripts" / "check-documented-commands.py").is_file(),
    },
    {
        "name": "docs-index",
        "command": "python3 scripts/check-docs-index.py",
        "why": "every entry docs/PITFALLS.md advertises really exists",
    },
    {
        # ★ The audit queue's citations rot silently: a file moves, a defect is fixed, and the entry keeps
        #   reading like a live one. Measured before this gate existed: 6 entries pointed at a file that was
        #   deleted or a line past the end of its file, one of them by 61 lines.
        #   It fails only on `stale-file` / `stale-line` —— the two states with no judgement in them (the
        #   defect was fixed, or the code moved). `drifted` and `cannot-judge` are printed, not failed:
        #   deciding whether a defect is fixed needs a person, and a gate that guessed would train people
        #   to silence it.
        "name": "audit-findings",
        "command": "python3 scripts/check-audit-findings.py",
        "why": "every finding in the audit queue still cites a place that exists",
        "requires": lambda: (REPO_ROOT / "scripts" / "check-audit-findings.py").is_file(),
    },
    {
        # ★ A tool whose failure path nothing exercises reports whatever it likes. This one's first
        #   criterion (any word of 7+ characters) called 60 entries `drifted` for a reason that meant
        #   nothing, so the case that pins it is a gate rather than a memory.
        "name": "audit-findings-selftest",
        "command": "python3 scripts/check-audit-findings.py --selftest",
        "why": "the audit-queue checker still decides prose vs identifier, and each state, as its cases pin",
        "requires": lambda: (REPO_ROOT / "scripts" / "check-audit-findings.py").is_file(),
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
        # Section 1's "never hardcode machine absolute paths". It was a rule enforced by remembering to look,
        # which is why an audit entry once claimed `.env.example` held a machine path and nothing could check
        # it either way. The tool prints how many lines it skipped as its own literal cases, and says what it
        # cannot see (binaries, paths assembled at runtime, gitignored files).
        "name": "hardcoded-paths",
        "command": "python3 scripts/check-hardcoded-paths.py",
        "why": "no literal path that belongs to one machine in a tracked file",
        "requires": lambda: (REPO_ROOT / "scripts" / "check-hardcoded-paths.py").is_file(),
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
    {
        # ★ Is the release artifact the tree it claims to be? A version bump and a source fix both landed
        #   after `package.zip` had been built, so the zip carried the new number and none of the fix, and
        #   every external label agreed. "Remember to rebuild the package" is a rule with no tool behind it,
        #   which is how it got forgotten; this is the tool.
        "name": "package-fresh",
        "command": "python3 scripts/verify-pkg.py",
        "why": "package.zip is the build beside it, not an older one wearing the same version",
        "requires": lambda: (REPO_ROOT / "package.zip").is_file()
        and (REPO_ROOT / "dist-plugin" / "index.js").is_file(),
    },
]

SKIP_REASON = {
    "language": "scripts/audit-language.py does not exist yet",
    "css-scope": "no dist-plugin/index.css —— run `npm run build` first; the gate reads build output",
    "package-fresh": "no package.zip / dist-plugin —— run `npm run build` then `npm run package`",
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
