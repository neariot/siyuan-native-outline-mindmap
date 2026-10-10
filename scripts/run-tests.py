#!/usr/bin/env python3
"""Run all TypeScript unit tests (offline, no browser / no SiYuan needed).

## Why `tsx` + `node --test`

This is how SiYuan's own frontend tests are run (see `app/package.json`):

    node --import tsx --test "src/**/*.test.ts"

The benefit is not having to take the detour of "compile with tsc into a temp directory, then run the output with node" ——
`tsx` executes TS directly, saving a whole round of compilation and also the fragility of "guess the output path with find".

## Why not jest / vitest

The project is a SiYuan plugin bundled with rsbuild. The tests are all pure functions + string/structural assertions,
and `node --test` ships its own runner, assertions and concurrency control, so adding `tsx` as one devDependency is enough.
Bringing in jest/vitest would drag along a whole set of transform + runtime dependencies for zero gain.

## Why **not** a browser (CDP)

Starting a headless browser takes 3.8 seconds at the very least, loading a SiYuan page another 30 seconds, and touch/gesture
behaviour of this kind cannot necessarily be triggered for real in CDP —— measured: synthesized touch events never reached SiYuan's
gesture logic at all, so the test "passed" while being a **false positive** (the control group likewise did not move, proving the method invalid).

SiYuan's own `sidebarSwipe.test.ts` does not open a browser either:
it tests gesture logic with a **hand-written DOM stub + a `node:vm` context**, reaching a conclusion in tens of milliseconds.
This repository follows the same approach —— when a stub will do, do not open a browser.

## Usage

    python3 scripts/run-tests.py            # run everything
    python3 scripts/run-tests.py richtext   # only those whose file name contains richtext
    python3 scripts/run-tests.py --watch    # rerun on every change

## Exit code

Any suite failing → non-zero, directly usable in CI.
"""

import os
import re
import script_log
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TSX = os.path.join(ROOT, "node_modules", ".bin", "tsx")


def find_tests(filt):
    """Collect the *.test.ts(x) under src/."""
    found = []
    for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, "src")):
        dirnames[:] = [d for d in dirnames if d != "node_modules"]
        for fn in sorted(filenames):
            if not re.search(r"\.test\.tsx?$", fn):
                continue
            rel = os.path.relpath(os.path.join(dirpath, fn), ROOT)
            if filt and filt not in rel:
                continue
            found.append(rel)
    return sorted(found)


def main():
    args = list(sys.argv[1:])
    watch = "--watch" in args
    args = [a for a in args if not a.startswith("--")]
    filt = args[0] if args else ""

    tests = find_tests(filt)
    if not tests:
        print(f"No test files found{' (filter: ' + filt + ')' if filt else ''}")
        return 1

    if not os.path.exists(TSX):
        print("tsx is missing, run npm install first")
        return 1

    # --test-concurrency=1: the tests share paths such as .tmp, so serial is more stable
    cmd = [TSX, "--test", "--test-concurrency=1"] + tests
    if watch:
        cmd = [TSX, "watch", "--test"] + tests

    print(f"Running {len(tests)} test suites" + (" (watch)" if watch else "") + "\n")
    return subprocess.run(cmd, cwd=ROOT).returncode


if __name__ == "__main__":
    with script_log.track("run-tests"):
        sys.exit(main())
