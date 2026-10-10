#!/usr/bin/env python3
"""Record how long every script took, so "is this fast?" stops being a guess.

## Why this exists

`AGENTS.md` section 1 says a check whose duration is **not known** runs in the background. That rule
is only usable if the duration *is* knowable, and until now it was not: every timing came from
wrapping a command in `time` by hand, and that number died with the terminal. The result was a
guess per run —— and one guessed wrong (a theme matrix that took two minutes was started in the
foreground, twice).

This module writes one line per script run to `.logs/script-usage.log`, and `--report` turns that
file into the answer: which scripts are seconds and which are minutes, per script, with the slowest
run included.

## Usage in a script

    import script_log

    def main() -> int:
        ...

    if __name__ == "__main__":
        with script_log.track("verify-css-scope"):
            sys.exit(main())

`track` logs on the way out whatever happened: a normal return, `sys.exit(N)`, an uncaught
exception, and a run that was **killed**. It never swallows anything: the exit code and the
exception travel on unchanged.

What it can and cannot see —— the honest version:

  * normal end / `sys.exit(N)` / exception: recorded with its outcome;
  * `SIGTERM` / `SIGINT` / `SIGHUP`: recorded as `interrupted`, because a handler is installed
    (only when nothing else already owned that signal, and the previous handler still runs);
  * **`SIGKILL` (`kill -9`) and a power loss leave nothing behind.** No hook can run. If a script
    seems to have no log line at all, that is the explanation, not a bug in the log.

Read the log with:

    python3 scripts/script_log.py --report      # per script: runs, median, max, last outcome
    python3 scripts/script_log.py --last 20     # the most recent runs, newest last

## Exit code

0 for a successful report; 1 when the log is missing or unreadable.
"""

import argparse
import atexit
import contextlib
import json
import os
import signal
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
LOG_DIR = REPO_ROOT / ".logs"
LOG_FILE = LOG_DIR / "script-usage.log"

#: Set `SCRIPT_LOG_DISABLE=1` to keep a run out of the log (useful when the log itself is under test).
DISABLE_ENV = "SCRIPT_LOG_DISABLE"


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _append(record: dict) -> None:
    if os.environ.get(DISABLE_ENV):
        return
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError as exc:  # never let bookkeeping break the thing it measures
        print(f"script_log: could not write {LOG_FILE}: {exc}", file=sys.stderr)


@contextlib.contextmanager
def track(name: str, argv=None):
    """Time one script run and append its outcome to the usage log.

    ★ The block is transparent: the exit code, the `SystemExit` and any exception pass through
    untouched, and no exception is ever suppressed here.
    """
    started = time.monotonic()
    started_at = _now_iso()
    # `argv[1:]` only: the interpreter and the script path are the same every time.
    recorded_argv = list(sys.argv[1:] if argv is None else argv)
    logged = False

    def record(outcome: str, detail: str = "") -> None:
        nonlocal logged
        if logged:
            return
        logged = True
        _append(
            {
                "script": name,
                "started": started_at,
                "seconds": round(time.monotonic() - started, 3),
                "outcome": outcome,
                "detail": detail,
                "argv": recorded_argv,
                "pid": os.getpid(),
            }
        )

    # If the process unwinds without the block's end being reached, still leave a trace.
    atexit.register(lambda: record("interrupted", "the block never finished"))

    # ★ `atexit` does NOT run when a signal kills the process, so a killed run used to leave no
    #   trace at all -- exactly the case worth measuring (these are the background jobs that get
    #   cancelled). Record first, then let the signal finish the job it was going to finish.
    previous = {}
    def on_signal(signum, _frame):
        record("interrupted", f"signal {signum}")
        owner = previous.get(signum, signal.SIG_DFL)
        if callable(owner):
            owner(signum, _frame)
            return
        signal.signal(signum, signal.SIG_DFL)
        os.kill(os.getpid(), signum)

    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        try:
            current = signal.getsignal(signum)
            if current is signal.SIG_DFL:  # never steal a signal someone else owns
                previous[signum] = current
                signal.signal(signum, on_signal)
        except (ValueError, OSError):
            pass  # not the main thread; the atexit net still applies

    try:
        yield
    except SystemExit as exit_request:
        code = exit_request.code
        record("ok" if code in (0, None) else "failed", f"exit {code}")
        raise
    except BaseException as error:
        record("error", f"{type(error).__name__}: {error}")
        raise
    else:
        record("ok")


# ---------------------------------------------------------------- reporting


def read_log() -> list:
    if not LOG_FILE.is_file():
        raise FileNotFoundError(LOG_FILE)
    records = []
    for number, line in enumerate(LOG_FILE.read_text(encoding="utf-8").splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            print(f"script_log: skipping unreadable line {number}", file=sys.stderr)
    return records


def report(records: list) -> None:
    by_script: dict = {}
    for record in records:
        by_script.setdefault(record["script"], []).append(record)

    width = max((len(name) for name in by_script), default=10)
    print(f"{'script'.ljust(width)}  runs  median   max      last")
    for name, runs in sorted(by_script.items(), key=lambda item: -statistics.median(r["seconds"] for r in item[1])):
        seconds = [run["seconds"] for run in runs]
        last = runs[-1]
        print(
            f"{name.ljust(width)}  {len(runs):>4}  {statistics.median(seconds):>5.1f}s  "
            f"{max(seconds):>5.1f}s  {last['outcome']} ({last['seconds']:.1f}s, {last['started']})"
        )
    print(f"\n{len(records)} runs from {LOG_FILE.relative_to(REPO_ROOT)}")
    print("reminder: anything whose median is above a few seconds belongs in the background (AGENTS.md 1)")


def main() -> int:
    parser = argparse.ArgumentParser(description="Report how long the repository's scripts take.")
    parser.add_argument("--report", action="store_true", help="per-script summary (default)")
    parser.add_argument("--last", type=int, metavar="N", help="print the N most recent runs instead")
    args = parser.parse_args()

    try:
        records = read_log()
    except FileNotFoundError:
        print(f"no usage log yet at {LOG_FILE} —— it appears the first time a script runs", file=sys.stderr)
        return 1

    if not records:
        print(f"{LOG_FILE} is empty", file=sys.stderr)
        return 1

    if args.last:
        for record in records[-args.last :]:
            print(f"{record['started']}  {record['script']:<28} {record['seconds']:>6.1f}s  {record['outcome']}  {record['detail']}")
        return 0

    report(records)
    return 0


if __name__ == "__main__":
    sys.exit(main())
