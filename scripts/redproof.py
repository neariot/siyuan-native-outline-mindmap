#!/usr/bin/env python3
"""Show that a check can actually go red, by mutating the tree on purpose and putting it back.

## Why this exists

`AGENTS.md` section 7 says "a new test must be shown to fail", and every round that rule was
followed it was done **by hand**: edit a file, run the suite, look, edit it back. Three sessions in
a row the hand-made mutation was ineffective and the suite stayed green for a reason that had
nothing to do with the check:

  * the replacement hit a **comment** quoting the bad shape instead of a rule (the lint strips
    comments, so nothing was mutated as far as the check was concerned);
  * it broke one selector of a **comma-separated rule list** whose sibling still matched, so the
    rule stayed live;
  * it broke a selector that **another rule** covered.

Each round was then re-run from scratch (build, deploy, whole suite) to find out. That is a process
defect, not bad luck: a mutation has to be verified **as a mutation** before a test run is spent on
it. This script does exactly that, and refuses to claim a red proof it did not see.

## What it does

    1. checks the "from" text occurs the expected number of times (default 1) —— before running
       anything, so a mutation that lands nowhere costs nothing;
    2. backs the file up, mutates it, and verifies the bytes really changed;
    3. runs the check command and requires a **non-zero** exit —— a check that stays green here is
       reported as a failure of the red proof, not as a success;
    4. restores the file **always** (including on SIGINT/SIGTERM) and verifies it is byte-identical;
    5. with `--verify-green`, re-runs the check after restoring, so "red then green" is one command.

## Usage

    python3 scripts/redproof.py --file src/styles.css \
        --from "html[data-theme-mode='dark'] .om-x {" --to "[data-theme='dark'] .om-x {" \
        --run "npm test"

    python3 scripts/redproof.py --file src/x.ts --from 'a' --to 'b' --run "npm test" --verify-green
    python3 scripts/redproof.py --file src/x.ts --from 'a' --to 'b' --dry-run    # occurrences + lines only

    # a check that needs the plugin running (E2E): the deploy stays inside the test instance
    python3 scripts/redproof.py --file src/styles.css --deploy \
        --from "html[data-theme-mode='dark'] .a," --to ".b {" --run "npm run test:e2e theme"

`--deploy` is for checks that need the build output (E2E, `verify`): it rebuilds and deploys with
the target **narrowed to the isolated test instance**, restores the source, then deploys again
—— because `npm run deploy` otherwise writes to *every* path in `PLUGIN_DIRS`, including the
workspace the user is working in, and a red proof is by definition a broken build. Do not run a
mutating check any other way.

`--run` may be any shell command; it runs from the repository root. Because the check may be slow
(E2E, a build), run the **whole script** in the background and read its log —— it writes one to
`.logs/redproof-<file>.log` and prints the path.

## Exit code

0 only when the mutation was verified, the check went red, and the file was restored.
1 when the mutation could not be applied, the check stayed green, or `--verify-green` came back red.
"""

import argparse
import atexit
import io
import os
import re
import script_log
import signal
import subprocess
import sys
from datetime import datetime
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
BACKUP_DIR = REPO_ROOT / ".tmp" / "redproof"
LOG_DIR = REPO_ROOT / ".logs"


def tail(text, lines=15):
    rows = [row for row in text.strip().splitlines() if row.strip()]
    return "\n".join(rows[-lines:])


def slug(text):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-")[:60] or "mutation"


class RedProof:
    """One mutation, one check run, one guaranteed restore."""

    #: How many line numbers to print; a mutation matching thousands of lines is a broken mutation,
    #: not a list worth reading.
    MAX_LINES = 10

    def __init__(self, args):
        self.args = args
        self.target = (REPO_ROOT / args.file).resolve()
        self.backup = BACKUP_DIR / (slug(args.file) + ".bak")
        self.original = None
        self.restored = False

    # ---------- deploy ----------

    def deploy_targets(self):
        """Every directory a deploy would install into, as `deploy.py --list` reports it.

        ★ The flag is passed through, and it changes the answer: `--list` on its own still reports the
          instance the user works in, so asking without `--test-only` compares two targets against one
          and fails while the narrowing in fact works.
        """
        done = subprocess.run(["python3", "scripts/deploy.py", "--list", "--test-only"], cwd=REPO_ROOT,
                              capture_output=True, text=True)
        output = (done.stdout or "") + (done.stderr or "")
        targets = []
        for line in output.splitlines():
            line = line.strip()
            if line.startswith("\u00b7"):
                # "\u00b7 <path>", optionally followed by an annotation. Only an absolute path is a
                # target: --list also prints a note line beginning the same way, and reading that as a
                # directory makes this guard report a target that is not one.
                path = line[1:].split("\u2190")[0].strip()
                if path.startswith("/"):
                    targets.append(path)
        return targets

    def deploy(self, when):
        """Build and sync the plugin into the isolated test instance **only**.

        ★ Narrowing is the whole point: by default `npm run deploy` installs into every plugin
        directory, the instance the user works in included, so a red proof would hand them a broken
        plugin for the length of the run. `--test-only` is what actually narrows it.

        ★ `--test-only` is the only narrowing, and that is measured, not assumed: pointing
          `PLUGIN_DIRS` at the test instance leaves **both** targets in place (`deploy.py` always adds
          the instance the user works in), so a mutation still reaches their editor. AGENTS.md
          section 7 used to recommend `PLUGIN_DIRS` here; it no longer does.
        """
        sys.path.insert(0, str(REPO_ROOT / "scripts"))
        from env import cfg  # noqa: PLC0415  (imported here so a dry run needs no config)

        target = cfg.test_instance_plugin_dir
        # ★ Read the target list **before** installing anything. Checking it afterwards notices too late:
        #   the mutated build is already in the editor the user works in, which is the whole damage this
        #   guard exists to prevent.
        listed = self.deploy_targets()
        if listed != [target]:
            self.fail(
                f"--test-only must narrow the deploy to exactly [{target}], deploy.py --list reports "
                f"{len(listed)}: {listed} ({when})"
            )
        print(f"\ndeploying to the isolated instance only ({when}):\n  {target}", flush=True)
        done = subprocess.run("npm run deploy -- --test-only", shell=True, cwd=REPO_ROOT,
                              capture_output=True, text=True)
        output = (done.stdout or "") + (done.stderr or "")
        for line in output.splitlines():
            if "deployed" in line or "checksum" in line:
                print(f"  {line.strip()}")
        if done.returncode != 0:
            print(tail(output))
            detail = (
                "the check would run against a stale plugin"
                if "mutation" in when
                else "the isolated instance still holds the MUTATED build —— deploy again before using it"
            )
            self.fail(f"deploy failed ({when}) —— {detail}")

    # ---------- steps ----------

    def locate(self):
        if not self.target.is_file():
            self.fail(f"no such file: {self.args.file} (looked at {self.target})")
        if self.args.text == self.args.to:
            self.fail("--from and --to are identical, so nothing would change")
        text = self.target.read_text(encoding="utf-8")
        occurrences = text.count(self.args.text)

        if self.args.dry_run:
            lines = [
                str(number)
                for number, line in enumerate(text.splitlines(), start=1)
                if self.args.text in line
            ]
            shown = lines[:self.MAX_LINES]
            more = f" (+{len(lines) - len(shown)} more)" if len(lines) > len(shown) else ""
            print(f"occurrences: {occurrences} (expected {self.args.expected})")
            print(f"lines: {', '.join(shown) or '(none)'}{more}")
            print(f"would replace {self.args.text!r} -> {self.args.to!r}")
            if occurrences != self.args.expected:
                self.fail(
                    f"expected {self.args.expected} occurrence(s), found {occurrences} —— "
                    "the mutation does not land where the check looks, so a test run would prove nothing"
                )
            return False

        if occurrences != self.args.expected:
            self.fail(
                f"expected {self.args.expected} occurrence(s) of {self.args.text!r}, found {occurrences} —— "
                "the mutation does not land where the check looks, so a test run would prove nothing"
            )
        return True

    def mutate(self):
        self.original = self.target.read_text(encoding="utf-8")
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        self.backup.write_text(self.original, encoding="utf-8")
        atexit.register(self.restore)
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, self._on_signal)

        mutated = self.original.replace(self.args.text, self.args.to, self.args.expected)
        if mutated == self.original:
            self.fail("the file did not change —— refusing to claim a red proof from a no-op")
        self.target.write_text(mutated, encoding="utf-8")
        print(f"mutated {self.args.file}: {len(self.original) - len(mutated):+d} bytes")

    def run(self, label, want_red):
        print(f"\n$ {self.args.run}   ({label})", flush=True)
        done = subprocess.run(self.args.run, shell=True, cwd=REPO_ROOT)
        red = done.returncode != 0
        print(f"exit {done.returncode} -> {'red' if red else 'green'}")

        if want_red and not red:
            self.fail(
                "the check stayed GREEN on a real mutation —— it cannot go red for this defect, "
                "so it has no defensive value (AGENTS.md section 7)"
            )
        if not want_red and red:
            if "before" in label:
                self.fail(
                    "the check is already RED before the mutation —— a command that fails on its own "
                    "is not evidence that the mutation caused anything"
                )
            self.fail("after restoring the file the check is still RED —— the tree is not clean")
        return red

    def restore(self, *_):
        if self.original is None or self.restored:
            return
        self.target.write_text(self.original, encoding="utf-8")
        self.restored = True
        if self.backup.exists():
            self.backup.unlink()
        same = self.target.read_text(encoding="utf-8") == self.original
        print(f"\nrestored {self.args.file}: {'byte-identical' if same else 'MISMATCH'}")
        if not same:
            self.fail("restore did not reproduce the original bytes —— check git diff before continuing")

    def _on_signal(self, signum, _frame):
        self.restore()
        print(f"\ninterrupted by signal {signum}; file restored", flush=True)
        sys.exit(130)

    def fail(self, message):
        print(f"\nred proof FAILED: {message}", file=sys.stderr)
        self.restore()
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        description="Mutate the tree on purpose, require the check to go red, then restore it.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--file", required=True, help="file to mutate, relative to the repository root")
    parser.add_argument("--from", dest="text", required=True, help="exact text to replace")
    parser.add_argument("--to", required=True, help="replacement text")
    parser.add_argument("--run", required=True, help="the check command; must exit non-zero while mutated")
    parser.add_argument("--expected", type=int, default=1, help="how many occurrences to replace (default 1)")
    parser.add_argument("--verify-green", action="store_true", help="re-run the check after restoring")
    parser.add_argument(
        "--deploy",
        action="store_true",
        help="rebuild and deploy into the isolated test instance only, before and after the mutation",
    )
    parser.add_argument("--dry-run", action="store_true", help="report occurrences and lines, run nothing")
    args = parser.parse_args()

    if not args.dry_run:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        log = LOG_DIR / f"redproof-{slug(args.file)}.log"
        print(f"log: {log.relative_to(REPO_ROOT)}")

    proof = RedProof(args)
    print(f"red proof for {args.file}   ({datetime.now().strftime('%Y-%m-%d %H:%M:%S')})")
    print(f"  file:    {proof.target.relative_to(REPO_ROOT)}")
    print(f"  command: {args.run}\n")

    if not proof.locate():
        return 0
    # ★ Run the check BEFORE mutating. Without this, any failure -- a typo in --run, a missing
    #   dependency, a flaky environment -- is reported as "the check went red on my mutation", which is
    #   the exact vacuous pass this tool exists to prevent. Only a check that is green untouched, and
    #   red once mutated, has demonstrated anything.
    proof.run("before mutating", want_red=False)
    proof.mutate()
    if args.deploy:
        proof.deploy("with the mutation in place")
    proof.run("mutation in place", want_red=True)
    proof.restore()
    if args.deploy:
        proof.deploy("after restoring the source")
    if args.verify_green:
        proof.run("after restore", want_red=False)

    print("\nred proof PASSED: the check went red on a verified mutation and the file was restored")
    return 0


if __name__ == "__main__":
    with script_log.track("redproof"):
        sys.exit(main())
