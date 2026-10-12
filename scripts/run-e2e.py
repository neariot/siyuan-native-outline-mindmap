#!/usr/bin/env python3
"""E2E entry point: read the configuration from `.env`, then hand over to playwright.

## Why it is needed

Running `playwright test` directly would mean exporting `SIYUAN_URL` / `SIYUAN_TOKEN` yourself,
while npm scripts cannot read `.env`, so the specs each used to fall back to defaults. Now the configuration is injected only from here,
and the target is pinned to the isolated test instance —— E2E really creates and deletes documents, so the target must not be guessed at or fallen back to.

## Usage

    python3 scripts/run-e2e.py                # everything
    python3 scripts/run-e2e.py outline        # only those whose file name contains outline
    python3 scripts/run-e2e.py --ui           # turn on UI mode
    python3 scripts/run-e2e.py -- --reporter=line   # everything after `--` goes to playwright verbatim
"""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import script_log  # noqa: E402
from env import ROOT, cfg  # noqa: E402


def _alive(base):
    """Probe once whether the target is running. Only used to **report an error**, never to pick a target."""
    for path in ("/api/system/version", "/"):
        try:
            with urllib.request.urlopen(base + path, timeout=3) as r:
                if r.status in (200, 302):
                    return True
        except Exception:
            pass
    return False


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("filter", nargs="?", default="",
                    help="only run specs whose file name contains this substring")
    ap.add_argument("--ui", action="store_true", help="playwright --ui")
    ap.add_argument("passthrough", nargs="*",
                    help="passed to playwright verbatim after `--`")
    args, extra = ap.parse_known_args()

    base = cfg.siyuan_test

    if not _alive(base):
        print(f"❌ The isolated test instance is not running on {base}.", file=sys.stderr)
        print("   Start it: python3 scripts/test-instance.py", file=sys.stderr)
        print(f"★ Not falling back to {cfg.siyuan} (the user instance) —— the tests would create and delete documents there.",
              file=sys.stderr)
        return 1

    env = dict(os.environ)
    env["SIYUAN_URL"] = base
    env["SIYUAN_TOKEN"] = cfg.test_token()   # ★ the test instance's own value, from .env
    env["CHROMIUM_PATH"] = cfg.chromium_path   # ★ the browser to launch; no default in the config
    # ★ The notebook the suites may write in, from `.env` (via env.py) like every other machine-specific
    #   value —— it used to be taken from the shell only, which is why nobody set it and the specs fell back
    #   to selecting an open notebook by *name*. Fail here rather than after starting a browser.
    if not cfg.test_notebook:
        print("❌ SIYUAN_TEST_NOTEBOOK is not set, so there is no notebook the tests may write in.", file=sys.stderr)
        print("   The suites create and delete documents. Put the id of a notebook that is free to be", file=sys.stderr)
        print("   modified in .env as SIYUAN_TEST_NOTEBOOK=<id> (a name is deliberately not accepted).", file=sys.stderr)
        return 1
    env["SIYUAN_TEST_NOTEBOOK"] = cfg.test_notebook

    # ★★ Report the machine's load before any case runs.
    #
    #   The suite's helpers use fixed timeouts (45s for "the panel opened", 60s for "the dock registered"),
    #   and under load those stop measuring the product: measured, four unrelated cases failed at
    #   46.7-48.4s in one run while every other case passed in ~5s, and the same cases passed in 8-12s on an
    #   idle machine with the identical build. The failure message blamed the plugin.
    #
    #   This warns rather than refuses. A loaded run still produces trustworthy *passes* —— a case that
    #   finishes in 5s under load would pass anywhere —— so aborting would throw away real signal. What it
    #   cannot do is support a claim that something is broken, and that is what the warning says.
    try:
        load1 = os.getloadavg()[0]
        cores = os.cpu_count() or 1
        if load1 > cores:
            print(f"⚠️  Load average is {load1:.1f} on {cores} core(s) —— this exceeds 1.0 per core.", file=sys.stderr)
            print("   A FAILURE in this run may be the machine, not the plugin: the helpers use fixed", file=sys.stderr)
            print("   timeouts (45s/60s) and under load they stop measuring the product. A PASS is still", file=sys.stderr)
            print("   meaningful. Re-run before reporting a defect. See docs/pitfalls/testing.md.", file=sys.stderr)
            print(f"   (The heaviest processes: `ps -eo pcpu,cmd --sort=-pcpu | head`)", file=sys.stderr)
        else:
            print(f"   load average {load1:.1f} on {cores} core(s) —— fine for this suite")
    except OSError:
        pass  # getloadavg is unavailable on some platforms; not a reason to refuse to run

    cmd = ["npx", "playwright", "test"]
    if args.ui:
        cmd.append("--ui")
    # what follows `--` goes to playwright; what precedes `--` is a file name filter
    cmd += list(extra)
    cmd += list(args.passthrough)

    # ★ The filter is resolved to **spec paths** here rather than handed to playwright as a bare word.
    # Passed as a word it was silently ignored: `run-e2e.py mindmap` and no filter at all both listed
    # "98 tests in 12 files", so a "single suite" cost 19.5 minutes and three failures from other
    # suites got attributed to the one being run. A filter that matches nothing is now an error —
    # running everything because the argument was not understood is the silent-fallback failure mode
    # (AGENTS.md section 5.1) inside the test tooling.
    if args.filter:
        spec_dir = Path(ROOT) / "e2e"
        if args.filter.endswith(".spec.ts") or "/" in args.filter:
            matches = [args.filter] if (Path(ROOT) / args.filter).is_file() else []
        else:
            matches = sorted(
                str(path.relative_to(ROOT)) for path in spec_dir.glob("*%s*.spec.ts" % args.filter)
            )
        if not matches:
            print("❌ No spec file matches %r —— refusing to run the whole suite instead."
                  % args.filter, file=sys.stderr)
            print("   Available: " + ", ".join(
                sorted(p.name for p in spec_dir.glob("*.spec.ts"))), file=sys.stderr)
            return 2
        print("  specs: " + ", ".join(matches))
        cmd += matches

    print(f"  E2E target: {env['SIYUAN_URL']}  (isolated test instance)")
    print(f"  notebook: {env['SIYUAN_TEST_NOTEBOOK']}  (from .env; an id, verified against the instance)")
    print(f"  $ {' '.join(cmd)}")
    _sweep_stale_traces()
    code = subprocess.run(cmd, cwd=ROOT, env=env).returncode
    _sweep_traces(code)
    return code


def _sweep_stale_traces():
    """Delete the previous run's artifacts before starting a new one.

    A failed run keeps its traces so the failure can be read, and that is the right thing for the session
    that saw it —— but they are also live request data sitting in a gitignored directory, and "kept for
    debugging" turns into "kept" once the debugging is over and nobody comes back to delete them. Starting
    a run is the moment the previous one's evidence has stopped being evidence.

    These are the copies `audit-privacy.py --live` finds: it scans the local artifacts (`.logs/`,
    `test-results/`, `.tmp/`) precisely because a committed-file scan would never see them.
    """
    target = os.path.join(ROOT, "test-results")
    if os.path.isdir(target):
        shutil.rmtree(target, ignore_errors=True)
        print("  removed test-results/ from the previous run (it holds live request data)")


def _sweep_traces(code):
    """Delete Playwright's artifacts when the run passed, keep them when it failed.

    A trace records every request the browser made, authorization headers included, so it is a file
    nobody thinks of as sensitive but which holds live request data. It is gitignored, and it accumulates
    on disk at one directory per run.

    Keeping them is only useful to debug a failure, so a green run sweeps them and a red run keeps them
    and says where they are. Doing this by hand would be one more thing to remember (section 8), and the
    copy that gets forgotten is the one that matters.
    """
    target = os.path.join(ROOT, "test-results")
    if not os.path.isdir(target):
        return
    if code == 0:
        shutil.rmtree(target, ignore_errors=True)
        print("  ✓ passing run: removed test-results/ (its traces hold live request data)")
    else:
        print(f"  ✗ failing run: kept {os.path.relpath(target, ROOT)}/ for debugging —— it contains the "
              f"live request headers, so delete it once you are done with it")


if __name__ == "__main__":
    with script_log.track("run-e2e"):
        sys.exit(main())
