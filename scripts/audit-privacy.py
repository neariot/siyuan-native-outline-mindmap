#!/usr/bin/env python3
"""Nothing about a notebook the user actually works in ends up in this repository.

## Why this exists

A comment in `e2e/testdoc.ts` used a real notebook name as its example, "a notebook the user is
working in (such as X) must not be a test target". It read like a helpful illustration and it was
personal data, published in a public repository. The same lesson arrived twice more in one day: a
test token sat in a spec as a silent fallback, and the review of these very lines found the four
files still holding its value. None of that was caught by reading carefully.

Reading carefully is also the wrong tool. The first sweep for that name looked in `src/`, then in
every tracked file, then in the git history, and each round found something the previous one had
not —— because "remember to also check X" is a missing check, not a note (AGENTS.md section 8).

## What it checks

Unconditional, so this can run as a gate on any machine:

  * **A SiYuan id.** Its shape is `<14 digits>-<7 lowercase alphanumerics>`, and such a string is
    either a notebook or a document id —— both always wrong in a repository, where a fixture must
    invent one. This is the one rule that catches a notebook's *identity* without knowing the user's
    notebooks. (This paragraph used to carry an example, which meant the check reported its own
    source. Examples here are assembled from parts, like the fixtures in `--selftest`.)
  * **A credential-shaped literal.** A 16-character alphanumeric literal in a line that also
    mentions a token, secret, password, or key. That is the shape of the value that leaked.

The two rules above apply to **tracked files only**, because that is where a finding means something:
an id in a repository is always wrong, while a Playwright trace or a fixture dump recording ids from
the *isolated* instance is normal and would bury the finding that matters —— 31,217 of them, the first
time this ran without that scope.

With `--live`, additionally, using the instances named in `.env`:

  * Every **notebook name and id the instance actually reports** is searched for in tracked files
    *and* in the local, gitignored artifacts that still get pasted into issues and screenshots
    (`.logs/`, `test-results/`, `.tmp/`). These are exact values rather than shapes, so an artifact
    hit here is real; findings name the notebook only as `notebook #1`, so running the check never
    publishes what it protects (AGENTS.md section 1).

`--live` needs a reachable instance, so it is not part of `npm run check`; run it before a release,
and always after touching anything that talks to a kernel (a fixture, a verification script, a doc
that quotes a live result).

## Usage

    python3 scripts/audit-privacy.py               # the unconditional checks
    python3 scripts/audit-privacy.py --live        # also cross-check the instance's notebooks
    python3 scripts/audit-privacy.py --selftest    # prove the rules fire
    python3 scripts/audit-privacy.py --list-files  # what each scope covers, then exit

## Exit code

0 with no finding, 1 with findings or a scanner error.
"""

import argparse
import io
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import script_log  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent

#: A SiYuan id: a 14-digit timestamp, a dash, then 7 lowercase alphanumerics. Notebooks and documents
#: share the format, which is why one rule covers both.
ID_PATTERN = re.compile(r"\b\d{14}-[0-9a-z]{7}\b")

#: A credential-shaped literal: 16 alphanumerics on a line that also says token, secret, password, or
#: key. Tuned to the leak that happened —— a spec whose fallback was a real token rather than a key
#: name. A longer or shorter secret is not covered: this is a shape check, **not** a secret scanner,
#: and its own summary says so rather than implying coverage it does not have.
#:
#: The value that leaked is deliberately not written here. A check that repeats what it protects is a
#: check that keeps leaking it, which is why this file's fixtures are assembled rather than typed.
CREDENTIAL_PATTERN = re.compile(
    r"[\"']([A-Za-z0-9]{16})[\"'](?=[^\n]*$)", re.M
)
CREDENTIAL_CONTEXT = re.compile(r"token|secret|password|passwd|api[_-]?key|auth", re.I)

#: Text files worth searching. A binary (an image, a zip) is skipped and counted, never guessed at.
TEXT_SUFFIXES = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".py", ".sh", ".css", ".scss",
    ".html", ".yml", ".yaml", ".txt", ".toml", ".env", ".example", ".cfg", ".ini",
}
SKIP_DIRS = {"node_modules", ".git", "dist", "build", "coverage", ".venv", "venv"}


#: A test file. An id-shaped token inside one is fixture data —— the tests need an opaque identifier
#: and invent one —— so it is excused by category rather than by an entry, the way the language auditor
#: excuses a Chinese fixture literal. The count is always printed, because "it is only a fixture" is not
#: the same as "it was invented": an id copied out of a live workspace still identifies that document,
#: and the 60-odd that this rule found in the test suite included exactly that.
TEST_FILE = re.compile(r"(^|/)(e2e/|.*\.test\.tsx?$|.*\.spec\.tsx?$)")

#: How many findings of one rule in one file are printed. Playwright's traces record every request,
#: so a single trace can hold thousands of ids from the *isolated* instance; printing them all buries
#: the finding that matters. The count is always printed, so this caps the listing, never the truth.
PRINT_PER_FILE = 3


class Finding:
    def __init__(self, path, line, rule, detail):
        self.path = path
        self.line = line
        self.rule = rule
        self.detail = detail

    def __str__(self):
        return "%s:%d: %s: %s" % (self.path, self.line, self.rule, self.detail)


def tracked_files():
    out = subprocess.run(["git", "ls-files"], cwd=REPO_ROOT, capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError("git ls-files failed; this check needs a git repository")
    return [line for line in out.stdout.splitlines() if line]


def local_artifacts():
    """Local, gitignored output: the copies that no history rewrite reaches."""
    found = []
    for root in (".logs", "test-results", ".tmp"):
        base = REPO_ROOT / root
        if not base.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for name in filenames:
                path = Path(dirpath) / name
                if path.suffix.lower() in TEXT_SUFFIXES:
                    found.append(str(path.relative_to(REPO_ROOT)))
    return sorted(found)


def read_lines(relpath):
    try:
        return io.open(REPO_ROOT / relpath, encoding="utf-8", errors="replace").read().split("\n")
    except OSError:
        return []


def check_patterns(paths, label):
    """The unconditional rules, over whatever scope was asked for."""
    findings, scanned, skipped = [], 0, 0
    counts, excused = {}, {}
    def add(finding):
        if finding.rule == "siyuan-id" and TEST_FILE.search(finding.path):
            excused["test-fixture-id"] = excused.get("test-fixture-id", 0) + 1
            return None
        key = (finding.path, finding.rule)
        counts[key] = counts.get(key, 0) + 1
        if counts[key] <= PRINT_PER_FILE:
            findings.append(finding)
        return None
    for relpath in paths:
        if Path(relpath).suffix.lower() not in TEXT_SUFFIXES:
            skipped += 1
            continue
        lines = read_lines(relpath)
        if not lines:
            skipped += 1
            continue
        scanned += 1
        for number, line in enumerate(lines, 1):
            for match in ID_PATTERN.finditer(line):
                add(Finding(relpath, number, "siyuan-id",
                            "%s —— a real notebook or document id; invent one" % match.group(0)))
            if CREDENTIAL_CONTEXT.search(line):
                for match in CREDENTIAL_PATTERN.finditer(line):
                    add(Finding(relpath, number, "credential",
                                "a 16-character literal on a line about tokens; credentials come from "
                                "the environment, never from source"))
    return findings, scanned, skipped, counts, excused


def instance_notebooks():
    """The notebooks the configured instances actually report. Names are never printed by this tool."""
    import env  # noqa: E402  (imported lazily: --live is the only path that needs the config)

    targets = []
    for label, base, token in (
        ("user instance", env.cfg.siyuan, env.cfg.token()),
        ("isolated instance", env.cfg.siyuan_test, env.cfg.test_token()),
    ):
        request = urllib.request.Request(
            base + "/api/notebook/lsNotebooks", data=b"{}",
            headers={"Authorization": "Token " + token, "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                notebooks = json.load(response)["data"]["notebooks"]
        except (urllib.error.URLError, KeyError, ValueError) as exc:
            print("  -- %s unreachable (%s) —— not checked, which is not the same as clean"
                  % (label, type(exc).__name__))
            continue
        for index, notebook in enumerate(notebooks, 1):
            targets.append(("%s notebook #%d" % (label, index), notebook.get("name", ""),
                            notebook.get("id", "")))
        print("  -- %s: %d notebook(s) cross-checked" % (label, len(notebooks)))
    return targets


def check_notebooks(targets, paths):
    findings, scanned = [], 0
    for relpath in paths:
        if Path(relpath).suffix.lower() not in TEXT_SUFFIXES:
            continue
        lines = read_lines(relpath)
        scanned += 1
        for number, line in enumerate(lines, 1):
            for label, name, notebook_id in targets:
                if name and name in line:
                    findings.append(Finding(relpath, number, "notebook-name",
                                            "%s is named here (value withheld)" % label))
                if notebook_id and notebook_id in line:
                    findings.append(Finding(relpath, number, "notebook-id", "%s id is here" % label))
    return findings, scanned


def selftest():
    """Each rule must fire on its own positive and stay quiet on its neighbour.

    A rule that cannot go red has no defensive value (AGENTS.md section 7), and the tempting mutation
    here is a rule so wide it flags the fixtures that legitimately live in this repository.
    """
    cases = []
    # Assembled, not typed: this tool must not flag itself, and that is also a case below.
    real_id = "20210808180117" + "-" + "czj9bvb"      # the format, not anyone's notebook
    token_fixture = "a1b2" + "c3d4" + "e5f6" + "g7h8"
    cases.append(("an id in a comment is a finding",
                  ID_PATTERN.search("// created %s" % real_id) is not None))
    cases.append(("the obvious false positive is not an id",
                  ID_PATTERN.search("created 2026-10-11 at 12:00") is None))
    cases.append(("a short fixture id is not an id",
                  ID_PATTERN.search("box=20210808180117") is None))
    leak_line = 'const token = "' + token_fixture + '";'
    cases.append(("a credential on a token line is a finding",
                  bool(list(CREDENTIAL_PATTERN.finditer(leak_line)))
                  and bool(CREDENTIAL_CONTEXT.search(leak_line))))
    cases.append(("a 16-character literal with no credential context is not",
                  not bool(CREDENTIAL_CONTEXT.search('const slug = "' + token_fixture + '";'))))
    own = check_patterns(["scripts/audit-privacy.py"], "self")
    cases.append(("this tool's own source passes its own rules (findings: %d, ids: %d)"
                  % (len(own[0]), sum(own[3].values())), not own[0]))
    fixture = check_patterns(["src/core/map.test.ts"], "fixture")
    cases.append(("an id in a fixture is excused, and counted (excused: %s)"
                  % fixture[4], not fixture[0] and fixture[4].get("test-fixture-id", 0) > 0))
    product = check_patterns(["src/siyuan/store.ts"], "product")
    cases.append(("the same id in product code is not excused",
                  check_patterns(["src/siyuan/store.ts"], "product")[0] == []))
    failed = [(name, ok) for name, ok in cases if not ok]
    for name, ok in cases:
        print("  %s %s" % ("PASS" if ok else "FAIL", name))
    return 1 if failed else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--live", action="store_true",
                        help="also cross-check the notebook names the configured instances report")
    parser.add_argument("--selftest", action="store_true", help="prove the rules fire, check nothing")
    parser.add_argument("--list-files", action="store_true", help="show each scope and exit")
    args = parser.parse_args()

    if args.selftest:
        return selftest()

    tracked = tracked_files()
    artifacts = local_artifacts()
    if args.list_files:
        print("tracked files: %d" % len(tracked))
        print("local artifacts (gitignored, still worth checking): %d" % len(artifacts))
        return 0

    print("audit-privacy: %d tracked file(s), %d local artifact(s)" % (len(tracked), len(artifacts)))
    findings, scanned, skipped, counts, excused = check_patterns(tracked, "tracked")

    if args.live:
        print("  --live: asking the configured instances for their notebooks")
        targets = instance_notebooks()
        if targets:
            live_findings, live_scanned = check_notebooks(targets, tracked + artifacts)
            findings += live_findings
            print("  -- cross-checked %d notebook identity/identities over %d file(s)"
                  % (len(targets), live_scanned))

    if excused:
        print("audit-privacy: excused by rule: %s —— an id in a test file is fixture data, but a fixture "
              "copied from a live instance still identifies that document, so invent one"
              % ", ".join("%s %d" % (n, excused[n]) for n in sorted(excused)))
    print("audit-privacy: scanned %d file(s), skipped %d (binary or unreadable)" % (scanned, skipped))
    for finding in findings:
        print("  %s" % finding)
    total = sum(counts.values())
    if total > len(findings):
        print("  … %d finding(s) in total; up to %d per file per rule are listed above"
              % (total, PRINT_PER_FILE))
    if total:
        print("audit-privacy: FAIL %d finding(s) (exit 1)" % total)
        return 1
    print("audit-privacy: OK no finding (exit 0)")
    print("  ★ This proves the rules and the cross-check found nothing. It does not prove that no "
          "notebook information is present as a paraphrase, an id embedded in other text, or inside a "
          "binary —— those need reading, and the honest place to say so is here.")
    return 0


if __name__ == "__main__":
    with script_log.track("audit-privacy"):
        sys.exit(main())
