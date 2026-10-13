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
import re
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
    _refuse_if_another_run_is_active()
    _sweep_stale_traces()   # note: this also removes any stale lock, so write ours after it
    _write_run_lock()
    try:
        code = subprocess.run(cmd, cwd=ROOT, env=env).returncode
    finally:
        # The lock goes with the artifacts: a run that leaves it behind would block the next one forever.
        try:
            os.remove(_lock_path())
        except OSError:
            pass
    _sweep_traces(code)
    _report_leftover_documents()
    return code



def _temp_doc_prefix():
    """`TEMP_DOC_TITLE_PREFIX` from `e2e/testdoc.ts`, or None when it cannot be read.

    Returning None rather than a default is deliberate (section 5.1): a guessed prefix would make the
    leftover check report "nothing left behind" for the wrong reason, which is worse than saying it could
    not check.
    """
    path = os.path.join(ROOT, "e2e", "testdoc.ts")
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return None
    m = re.search(r"export const TEMP_DOC_TITLE_PREFIX\s*=\s*'([^']*)'", text)
    return m.group(1) if m else None



# ★ How long to wait before confirming a candidate is really a leftover. Long enough for an in-flight
#   `removeDocByID` to land (deletion is visible to a read immediately, unlike creation), short enough that a
#   suite does not notice it. Only paid when the index lists something.
_LEFTOVER_SETTLE_SECONDS = 2.0


def _document_still_exists(call, doc_id):
    """True when the kernel still serves this document. A read, so it has no index lag.

    ★ Deliberately **not** `query/sql` again: the index is what listed the candidate, and the index is what
    lags (1~3 s after a creation, `docs/kernel-api.md` 7.3). Reading the block itself answers the question the
    report is really asking —— "is this document still there?" —— with no window (measured: `getBlockDOM`
    returns `code: 0` while alive and `block not found` at every moment after a deletion).
    """
    if not doc_id:
        return False
    try:
        return call("/api/block/getBlockKramdown", {"id": doc_id}).get("code") == 0
    except Exception:  # noqa: BLE001 —— a failure to check is not evidence of a leftover
        return False


def _report_leftover_documents():
    """Warn about temp documents a run left behind on the isolated instance.

    ★ Why this exists. `e2e/testdoc.ts` says every test that writes runs against its own temp document and
    deletes it in `afterEach` —— a rule enforced by remembering. A probe that opened the plugin's **tab**
    entry point (`openTab`) made SiYuan create a temporary document of its own, which nothing deleted: two
    leftovers stayed on the instance, and later probes wrote into one of them, so every "delete then write"
    probe looked successful **for the wrong reason** —— the panel was writing to a live document that was not
    the one under test. That cost most of a round, and is exactly the "a rule with no tool is a rule that
    gets forgotten" shape (section 8).

    It **reports** rather than failing: a leftover is not by itself a product defect, and a run that ends red
    for an unrelated reason should not also be blamed for this. The point is that nobody has to wonder.

    ★ Measured lag, so the next person does not have to guess: the SQL index shows a new document within
    **~2 s** (`t=0` absent, `t=2 s` present, and it stays). Inside that window this query cannot see the
    document at all, so the check can *under-report* —— quiet, which is the safe direction.

    ★★ The other direction bit once and is handled below: a green 118-case run reported **one** temp document
    that was already gone when inspected (`getBlockKramdown` → `code: -1`) —— the index had listed a document
    whose deletion was still in flight, i.e. the run was clean and the check said otherwise. A report that
    cries wolf gets ignored, so each candidate is now **confirmed with a read** before it is reported: reads
    have no such window (`docs/kernel-api.md` 7.3).

    ★ A trap worth recording, because it cost a cycle while verifying this: `createDocWithMd` takes the
    document **title from the path**, not from a `# heading` in the markdown. A verification document created
    with a heading and a plain path therefore had a title that does not start with the temp prefix, and the
    check correctly ignored it —— which looked like the check failing to detect a leftover it should have
    found. `createTempDocTitled` passes the title in the path for this reason.

    It asks the isolated instance only, never the workspace the user works in (section 5.1 #4).
    """
    try:
        import env as env_mod
        cfg = env_mod.Config()
        base, token = cfg.siyuan_test, cfg.test_token()
        notebook = cfg.test_notebook
    except Exception as e:  # noqa: BLE001 —— a missing instance is not this check's problem
        print(f"  · leftover-document check skipped: {e}")
        return
    import json
    import urllib.request

    def call(endpoint, body):
        req = urllib.request.Request(
            base + endpoint,
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "Authorization": "Token " + token},
        )
        return json.load(urllib.request.urlopen(req, timeout=10))

    try:
        rows = call(
            "/api/query/sql",
            {"stmt": "SELECT id, content FROM blocks WHERE box='%s' AND type='d' LIMIT 200" % notebook},
        ).get("data", [])
    except Exception as e:  # noqa: BLE001
        print(f"  · leftover-document check skipped: {e}")
        return

    # ★ The prefix is **read from the test helper**, not spelled again here.
    #
    #   It was duplicated, and two copies of one string drift: a leftover check looking for a prefix the
    #   tests no longer use reports nothing and stays quiet —— the failure mode this whole script is about.
    #   `TEMP_DOC_TITLE_PREFIX` is exported by `e2e/testdoc.ts` for exactly this.
    prefix = _temp_doc_prefix()
    if prefix is None:
        print("  · leftover-document check skipped: could not read TEMP_DOC_TITLE_PREFIX from e2e/testdoc.ts")
        return
    candidates = [r for r in rows if str(r.get("content", "")).startswith(prefix)]
    if not candidates:
        print("  ✓ no temp documents left behind on the test instance")
        return

    # ★★ Confirm each candidate is really a leftover, rather than reporting what the index happens to hold.
    #
    #   Measured: a green 118-case run reported one temp document, and by the time it was inspected it was
    #   already gone (`getBlockKramdown` → `code: -1`) —— the SQL index had listed a document whose deletion
    #   was still in flight. A check that cries wolf on a race gets ignored, and an ignored check is worse than
    #   none, so this re-reads each candidate after a short settle and reports only the ones that survive.
    #
    #   The settle is bounded and only runs when there is something to confirm, so the common case (nothing
    #   left behind) still costs exactly one query.
    import time

    time.sleep(_LEFTOVER_SETTLE_SECONDS)
    leftovers = [r for r in candidates if _document_still_exists(call, str(r.get("id", "")))]
    if not leftovers:
        print(
            "  ✓ no temp documents left behind on the test instance (%d transient one(s) seen and gone)"
            % len(candidates)
        )
        return
    print(f"  ⚠ {len(leftovers)} temp document(s) left on the test instance —— a case or probe did not clean up:")
    for r in leftovers[:5]:
        print(f"      {r.get('id')}  {r.get('content')!r}")
    if len(leftovers) > 5:
        print(f"      … and {len(leftovers) - 5} more")
    print("    A leftover is not a product defect, but later runs may write into it and pass for the wrong")
    print("    reason. Delete it, and make the case that created it clean up after itself.")
    print("    (To clear the instance: python3 scripts/clean-test-instance.py --delete)")


def _refuse_if_another_run_is_active():
    """Refuse to start when another suite is already running against this checkout.

    ★ Two suites cannot share `test-results/`. `_sweep_stale_traces` deletes it at the start and
    `_sweep_traces` deletes it at the end, so a second run wipes the first run's artifact directory while
    Playwright is still writing into it. What that produces is not a crash but a **false failure**: the
    case really passes, and the report says

        Error: browserContext.close: ENOENT: no such file or directory, open
        'test-results/.playwright-artifacts-0/traces/<id>-recording2.network'

    Measured: a full run reported `1 failed, 114 passed`, and both "failures" passed in isolation in 10~17 s
    on the identical build. Playwright then prints a trace `Usage:` line for a zip that was deleted under
    it, which reads like a tooling error and is really a collision. The two runs also compete for the same
    browser and the same test documents, so the machine-load failures pile on top.

    Costs nothing and prevents a whole class of misleading output, which is the point: the alternative is
    remembering not to start a second run, and that is exactly the kind of rule section 8 says to encode.
    """
    lock = _lock_path()
    if not os.path.exists(lock):
        return
    try:
        with open(lock, encoding="utf-8") as fh:
            pid = int((fh.read() or "0").strip() or 0)
    except (OSError, ValueError):
        return  # unreadable lock: do not block a run over a stale file
    if pid and pid != os.getpid() and os.path.exists(f"/proc/{pid}"):
        raise SystemExit(
            f"  another E2E run is already going (pid {pid}) and owns test-results/.\n"
            "  Two suites cannot share it: the second wipes the first's artifact directory, and the\n"
            "  first then reports ENOENT on its own trace file as a test failure. Wait for it, or stop\n"
            f"  it with: kill {pid}"
        )


def _lock_path():
    """Where the single-run lock lives.

    ★ **Not** inside `test-results/`: Playwright owns that directory by default and clears it when it starts,
    so a lock written there is deleted moments after it is created —— measured, a run in progress had no
    lock at all, which is how this was found. `.logs/` is ours and nothing else writes to it.
    """
    return os.path.join(ROOT, ".logs", ".run-e2e.lock")


def _write_run_lock():
    """Claim the suite for this run (see `_refuse_if_another_run_is_active`)."""
    os.makedirs(os.path.join(ROOT, ".logs"), exist_ok=True)
    with open(_lock_path(), "w", encoding="utf-8") as fh:
        fh.write(str(os.getpid()))


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
