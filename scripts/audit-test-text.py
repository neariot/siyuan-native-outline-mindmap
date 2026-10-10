#!/usr/bin/env python3
"""Test text: no copyright risk and no privacy risk.

Every string literal in the suite is checked against the corpora that would make it risky:

* **third-party text** —— SiYuan's own shipped material (`SIYUAN_SRC`, and the isolated instance's
  `resources/`, which holds the kernel's `guide/` and its language files). A fixture that reproduces a
  stretch of somebody else's prose is a copying problem regardless of intent, and it is decidable: the
  text is on this machine.
* **the reference workspace** —— the documents of the instance the user works in, read read-only. A
  fixture copied out of a real document identifies that workspace, which is what the privacy rule in
  `AGENTS.md` section 1 forbids. Reading is allowed; keeping a copy is not.
* **live identifiers** —— notebook and document ids of both instances. An id-shaped fixture is fine only
  if it is *invented*, so a fixture equal to a real id is a finding, not a fixture.

Length alone decides nothing: `Key point` is ordinary English, and an eight-character Chinese fixture can
be an invented block title. The thresholds below are stated so they can be argued with.

    python3 scripts/audit-test-text.py                 # the tracked suite, offline checks only
    python3 scripts/audit-test-text.py --live          # also ask the instances what they really contain
    python3 scripts/audit-test-text.py --selftest      # the checks' own cases, no network
    python3 scripts/audit-test-text.py --json          # machine-readable, for a wider sweep

★ What it cannot see, in its own words: a *paraphrase* of somebody else's text, a fixture assembled from
several real documents, and anything shorter than the thresholds. It also cannot judge whether a fixture
is *tasteful* —— only whether it exists somewhere it should not.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass, field

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

#: How much of a fixture must match a corpus before it counts as copied. Short matches are inevitable:
#: a fixture title like `笔记` appears in any Chinese text. Twelve characters of CJK, or ten words of
#: prose, is long enough that a match means the text came from somewhere.
MIN_CJK_RUN = 12
MIN_WORDS_RUN = 10

#: How much third-party text is held in memory for the copying check. A file larger than the first bound
#: is skipped (a bundled asset is not prose); the total stops the run growing without limit.
CORPUS_MAX_FILE_BYTES = 2_000_000
CORPUS_MAX_BYTES = 60_000_000

#: Files whose text is the thing under test rather than prose we wrote.
TEST_FILE_RE = re.compile(r"(\.test\.ts|\.spec\.ts|^e2e/.*\.ts)$")

ID_PATTERN = re.compile(r"\b\d{14}-[0-9a-z]{7}\b")
CJK_RUN = re.compile(r"[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]{%d,}" % MIN_CJK_RUN)
COPYRIGHT_MARKER = re.compile(r"©|\(c\)\s*\d{4}|copyright|all rights reserved", re.I)


@dataclass
class Finding:
    file: str
    line: int
    kind: str
    detail: str


@dataclass
class Report:
    literals: int = 0
    files: int = 0
    findings: list = field(default_factory=list)
    counts: Counter = field(default_factory=Counter)
    notes: list = field(default_factory=list)


def tracked_test_files():
    out = subprocess.run(["git", "ls-files"], cwd=REPO_ROOT, capture_output=True, text=True, check=True)
    return [f for f in out.stdout.split("\n") if f and TEST_FILE_RE.search(f)]


def extract_literals(paths):
    """String literals, via the TypeScript compiler —— a regex cannot tell a string from a comment."""
    out = subprocess.run(["node", os.path.join(HERE, "extract-literals.mjs"), *paths],
                         cwd=REPO_ROOT, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def unquote(text):
    if len(text) >= 2 and text[0] in "\"'`" and text[-1] == text[0]:
        return text[1:-1]
    return text


# ---- corpora ---------------------------------------------------------------


def third_party_corpus():
    """SiYuan's own material: its source checkout and the isolated instance's shipped resources.

    Returns (text, source_label) or (None, why-not).
    """
    import env

    parts, labels = [], []
    src = env.cfg.siyuan_src
    if os.path.isdir(src):
        guide = os.path.join(src, "app", "src")
        for root, dirs, files in os.walk(src if not os.path.isdir(guide) else src):
            dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "dist", "build")]
            for name in files:
                if os.path.splitext(name)[1] in (".go", ".ts", ".json", ".md"):
                    parts.append(os.path.join(root, name))
            if len(parts) > 4000:
                break
        labels.append("SIYUAN_SRC")
    resources = os.path.join(env.cfg.test_instance_dir, "resources")
    if os.path.isdir(resources):
        for root, dirs, files in os.walk(resources):
            for name in files:
                if os.path.splitext(name)[1] in (".json", ".md"):
                    parts.append(os.path.join(root, name))
        labels.append("the isolated instance's resources (guide + language files)")
    if not parts:
        return None, "no third-party corpus found (SIYUAN_SRC unset and no instance resources)"
    # ★ Bounded on purpose: a full SiYuan checkout is hundreds of megabytes, and holding it all to answer
    #   "does this fixture appear in somebody else's text" would cost more than the question is worth. The
    #   material that matters for copying is prose —— the guide, the language files, the docs —— and this
    #   cap keeps the run in seconds. What was actually read is printed, so the bound is visible.
    blob, read_bytes, read_files = [], 0, 0
    for path in parts:
        if read_bytes > CORPUS_MAX_BYTES or read_files > 6000:
            break
        try:
            if os.path.getsize(path) > CORPUS_MAX_FILE_BYTES:
                continue
            with open(path, encoding="utf-8", errors="ignore") as handle:
                text = handle.read()
        except OSError:
            continue
        blob.append(text)
        read_bytes += len(text)
        read_files += 1
    return "\n".join(blob), "+".join(labels) + " (%d file(s), %.1f MB read)" % (read_files, read_bytes / 1e6)


def reference_workspace_text(base, token, limit=40):
    """The body text of documents in the reference instance, read-only. Never printed, never stored."""
    import urllib.request

    def call(path, payload):
        request = urllib.request.Request(
            base + path, data=json.dumps(payload).encode(),
            headers={"Authorization": "Token " + token, "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)

    rows = call("/api/query/sql", {
        "stmt": "SELECT id FROM blocks WHERE type = 'd' LIMIT %d" % limit}).get("data") or []
    chunks = []
    for row in rows:
        try:
            data = call("/api/block/getBlockKramdown", {"id": row["id"]}).get("data") or {}
            chunks.append(data.get("kramdown") or "")
        except Exception:  # a document that cannot be read is not a reason to stop
            continue
    return "\n".join(chunks)


# ---- checks ----------------------------------------------------------------


def check_literals(literals, *, third_party, reference, live_ids):
    report = Report()
    report.literals = len(literals)
    report.files = len({x["file"] for x in literals})

    for item in literals:
        body = unquote(item["text"])
        where = (item["file"], item["line"])

        if COPYRIGHT_MARKER.search(body):
            report.counts["copyright marker"] += 1
            report.findings.append(Finding(*where, "copyright-marker",
                                           "a copyright notice is not a fixture"))

        for match in ID_PATTERN.finditer(body):
            report.counts["id-shaped"] += 1
            if live_ids and match.group(0) in live_ids:
                report.findings.append(Finding(
                    *where, "live-id",
                    "an id-shaped fixture equals an id a running instance really reports, so it "
                    "identifies that notebook or document —— invent one"))

        if third_party:
            for match in CJK_RUN.finditer(body):
                if match.group(0) in third_party:
                    report.counts["copied from third-party text"] += 1
                    report.findings.append(Finding(
                        *where, "third-party-text",
                        "a %d-character Chinese run appears verbatim in SiYuan's own shipped text "
                        "(%s) —— write the fixture instead of copying it"
                        % (len(match.group(0)), "value withheld")))

        if reference:
            for match in CJK_RUN.finditer(body):
                if match.group(0) in reference:
                    report.counts["copied from the reference workspace"] += 1
                    report.findings.append(Finding(
                        *where, "workspace-text",
                        "a %d-character Chinese run appears verbatim in a document of the instance the "
                        "user works in —— that is their content, not a fixture" % len(match.group(0))))

        words = body.split()
        if third_party and len(words) >= MIN_WORDS_RUN and not re.search(r"[\u3400-\u9fff]", body):
            if body in third_party:
                report.counts["copied from third-party text"] += 1
                report.findings.append(Finding(
                    *where, "third-party-text",
                    "a %d-word English run appears verbatim in SiYuan's own material" % len(words)))

    if not third_party:
        report.notes.append("the third-party corpus was not available, so copying was not checked")
    if not reference:
        report.notes.append("the reference workspace was not read, so copied workspace content was not "
                            "checked (--live reads it, read-only)")
    if not live_ids:
        report.notes.append("live identifiers were not fetched, so an invented-looking id could still be "
                            "a real one (--live checks)")
    return report


# ---- selftest --------------------------------------------------------------

SELFTEST_CASES = (
    ("a copyright notice in a fixture", {"text": "'(c) 2020 Somebody'", "file": "t.test.ts", "line": 1},
     "copyright-marker"),
    ("a real id is a finding", {"text": "'20261004021333-aaa1111'", "file": "t.test.ts", "line": 1}, "live-id"),
    ("an invented id of the same shape is not", {"text": "'20250101010101-abc1234'", "file": "t.test.ts",
                                                 "line": 1}, None),
    ("a long Chinese run is a finding", {"text": "'%s'" % ("中" * 20), "file": "t.test.ts", "line": 1},
     "third-party-text"),
    ("a short Chinese fixture is not", {"text": "'笔记'", "file": "t.test.ts", "line": 1}, None),
)


def selftest():
    passed = failed = 0
    thirds = "x" + "中" * 20 + "y"
    ref = "z" + "中" * 20 + "w"
    ids = {"20261004021333-aaa1111"}
    for name, item, expected in SELFTEST_CASES:
        report = check_literals([dict(item, kind="string")], third_party=thirds, reference=ref, live_ids=ids)
        kinds = [f.kind for f in report.findings]
        ok = (expected in kinds) if expected else not kinds
        print("  %s %s" % ("PASS" if ok else "FAIL", name))
        passed, failed = (passed + 1, failed) if ok else (passed, failed + 1)
    # ★ The tool must be able to report clean input as clean, or it is just an alarm.
    clean = check_literals([{"text": "'an invented fixture'", "kind": "string", "file": "t.test.ts", "line": 1}],
                           third_party=thirds, reference=ref, live_ids=ids)
    ok = not clean.findings
    print("  %s an invented fixture reports nothing" % ("PASS" if ok else "FAIL"))
    passed, failed = (passed + 1, failed) if ok else (passed, failed + 1)
    print("\nselftest: %s (%d case(s), %d failed)" % ("PASS" if not failed else "FAIL", passed + failed, failed))
    return 0 if not failed else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--live", action="store_true",
                    help="also fetch live ids and read the reference workspace (read-only) and check "
                         "against SiYuan's shipped text")
    ap.add_argument("--selftest", action="store_true", help="run the checks' own cases and exit")
    ap.add_argument("--json", action="store_true", help="print findings as JSON")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    files = tracked_test_files()
    literals = extract_literals(files)

    third_party, why = (None, "not requested")
    reference, live_ids = "", set()
    if args.live:
        third_party, why = third_party_corpus()
        import env
        live_ids = set()
        for base, token in ((env.cfg.siyuan, env.cfg.token()), (env.cfg.siyuan_test, env.cfg.test_token())):
            try:
                reference += reference_workspace_text(base, token, limit=40)
            except Exception as exc:
                print("  -- could not read a workspace (%s); its content was not checked"
                      % type(exc).__name__)
        # notebooks and documents of both instances, by id
        import urllib.request
        for base, token in ((env.cfg.siyuan, env.cfg.token()), (env.cfg.siyuan_test, env.cfg.test_token())):
            for stmt in ("SELECT id FROM blocks WHERE type = 'd' LIMIT 2000",
                         "SELECT id FROM boxes LIMIT 200"):
                try:
                    request = urllib.request.Request(
                        base + "/api/query/sql", data=json.dumps({"stmt": stmt}).encode(),
                        headers={"Authorization": "Token " + token, "Content-Type": "application/json"})
                    with urllib.request.urlopen(request, timeout=30) as response:
                        for row in json.load(response).get("data") or []:
                            live_ids.add(row["id"])
                except Exception:
                    continue
        # ★ The label, never the blob. Printing the corpus itself wrote 45 MB of somebody else's source
        #   into a log —— and the same line, one variable over, would have written the user's workspace.
        print("  -- live: %d id(s) from both instances, %d character(s) of reference workspace, "
              "third-party corpus: %s" % (len(live_ids), len(reference), why if third_party else "unavailable"))

    report = check_literals(literals, third_party=third_party, reference=reference, live_ids=live_ids)

    if args.json:
        print(json.dumps({"literals": report.literals, "files": report.files,
                          "counts": dict(report.counts),
                          "findings": [f.__dict__ for f in report.findings]}, ensure_ascii=False))
    else:
        for finding in report.findings[:40]:
            print("  %s:%d: %s: %s" % (finding.file, finding.line, finding.kind, finding.detail))
        for note in report.notes:
            print("  -- %s" % note)
        print("audit-test-text: %d literal(s) in %d file(s); %d finding(s) %s"
              % (report.literals, report.files, len(report.findings),
                 dict(report.counts) if report.counts else ""))

    return 1 if report.findings else 0


if __name__ == "__main__":
    sys.exit(main())
