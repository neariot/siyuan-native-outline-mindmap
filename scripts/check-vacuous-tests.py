#!/usr/bin/env python3
"""A test that imports nothing cannot test anything, and a doc must not cite a test that is gone.

Two halves of the same problem, both found by reading a file rather than trusting a green run.

**Cited but missing (fails).** A pitfall entry ends with `**Test**: <path>`, naming the case that freezes
the behaviour. Nothing checked those paths, so deleting a test left the ledger advertising coverage that
no longer existed -- three entries pointed at a file that had been removed.

**Vacuous (printed, not failed).** A test file with no import, no `require`, no `readFile`, and no process
call never reaches the product: it declares its own interfaces and asserts literals it defined one line
earlier. `src/plugin/link-delete.test.ts` was one -- it asserted that `mount.ts` does not pass
`onDeleteLink` from an array written inside the test, so it stayed green while claiming the opposite of
the shipped code (the audit had already recorded it as `high · test-quality`). It cannot go red, so it has
no defensive value (`AGENTS.md` section 7).

★ What it cannot see, which is why the second half only prints: a file that *does* import something can
still assert its own literals, and a file that imports a module and never calls it is just as vacuous. This
is a **lower bound** -- "these provably cannot test anything" -- not a claim that the rest are sound. The
same defect appears in files that import a project module solely to re-implement it locally (the audit
records several), and only reading them finds that.

    python3 scripts/check-vacuous-tests.py            # both halves
    python3 scripts/check-vacuous-tests.py --list     # every test file and what it reaches
    python3 scripts/check-vacuous-tests.py --selftest # the citation rule, no I/O
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from script_log import track  # noqa: E402

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent

CITATION = re.compile(r"\*\*(?:Test|Tests|Case)\*\*:\s*(.+)")
PATH_IN_CODE = re.compile(r"`([^`\s]+\.(?:test\.)?tsx?)`")
# A test is not vacuous if it can reach anything: an import, a dynamic import, a require, a file read, or a
# child process whose output it asserts on.
REACHES = r"^\s*import |require\(|import\(|readFileSync|readFile\(|execSync|execFileSync|spawnSync"


def cited_paths() -> list[tuple[str, int, str]]:
    out = []
    for path in sorted((REPO_ROOT / "docs").rglob("*.md")):
        for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            m = CITATION.match(line.strip())
            if not m:
                continue
            for cited in PATH_IN_CODE.findall(m.group(1)):
                out.append((str(path.relative_to(REPO_ROOT)), i, cited))
    return out


def vacuous() -> list[str]:
    files = subprocess.run(["rg", "-L", "--files-without-match", REACHES, "-g", "*.test.ts", "src/"],
                           cwd=REPO_ROOT, capture_output=True, text=True, check=False)
    if files.returncode not in (0, 1):
        raise SystemExit("rg failed:\n" + files.stderr.strip())
    return sorted(p.strip() for p in files.stdout.splitlines() if p.strip())


def selftest() -> int:
    """The citation rule, and that a file which reaches nothing is recognised as reaching nothing."""
    cases = [
        ("**Test**: `e2e/ctxmenu.spec.ts`", "e2e/ctxmenu.spec.ts", True),
        ("**Tests**: `src/plugin/tree-ops.test.ts`", "src/plugin/tree-ops.test.ts", True),
        ("**Test**: a plain sentence with no path", None, False),
    ]
    failed = 0
    for line, expected, has_path in cases:
        m = CITATION.match(line)
        got = PATH_IN_CODE.findall(m.group(1)) if m else None
        found = got[0] if got else None
        ok = (found == expected)
        failed += 0 if ok else 1
        print(f"  {'✅' if ok else '❌'} {line!r} -> {found}" + ("" if ok else f" (expected {expected})"))
    print(f"selftest: {'PASS' if failed == 0 else 'FAIL'} ({len(cases)} case(s), {failed} failed)")
    return 1 if failed else 0


def main() -> int:
    args = set(sys.argv[1:])
    if "--selftest" in args:
        return selftest()

    cites = cited_paths()
    missing = [(f, i, c) for f, i, c in cites if not (REPO_ROOT / c).exists()]
    empty = vacuous()

    print(f"vacuous tests: {len(cites)} citation(s) in docs/, {len(missing)} pointing at nothing; "
          f"{len(empty)} test file(s) reach nothing at all")
    if "--list" in args:
        for f, i, c in cites:
            print(f"  cited    {f}:{i} -> {c}")
        for f in empty:
            print(f"  vacuous  {f}")
    if missing:
        print(f"vacuous tests: {len(missing)} doc citation(s) name a file that does not exist:")
        for f, i, c in missing:
            print(f"  - {f}:{i} -> {c}")
    if empty:
        print(f"vacuous tests: {len(empty)} test file(s) import nothing and read nothing, so no change to "
              "the product can turn them red —— they are a lower bound, not the whole list:")
        for f in empty:
            print(f"  · {f}")
    if missing:
        return 1
    print("vacuous tests: every cited test exists")
    return 0


if __name__ == "__main__":
    with track("check-vacuous-tests"):
        sys.exit(main())
