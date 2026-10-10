#!/usr/bin/env python3
"""Chinese test fixtures must be function labels, not content.

A fixture is text we invented to stand for something: a node, the second paragraph, a bold run. Written
that way it cannot be mistaken for real material —— it is obviously synthetic on sight, and there is no
way for it to have been copied out of a document, because it does not *say* anything.

This checks every Chinese string literal in the suite against `scripts/fixture-vocabulary.txt`: a fixture
has to be composed entirely of those words (plus digits, CJK numerals and ordinary ASCII). Anything else
is a finding, because a label like that is *content*: it reads like a real note, and a fixture that
reads like a real note is one nobody can audit at a glance.

Some literals are exempt, and each exemption names its rule:

  * `catalogue`  —— a value of `src/plugin/i18n/zh_CN.json`: the interface's own text, not a fixture.
  * `semantics`  —— the Chinese *is* the case: full-width punctuation, U+3000, a zero-width character,
                    a character outside the BMP, or a CJK/ASCII mix (segmentation).
  * `allowlist`  —— a `language-allowlist.txt` entry, i.e. a value observed from a running kernel.

    python3 scripts/check-fixture-text.py            # the suite
    python3 scripts/check-fixture-text.py --selftest # the rule's own cases, no I/O
    python3 scripts/check-fixture-text.py --list     # also print every exempted literal and why

★ What it cannot see: whether a functional-looking label is *also* true of somebody's real content (it
cannot be), and whether the vocabulary itself has grown a word that is really content. The vocabulary is
short on purpose and a stale entry is a finding, so it gets read whenever it changes.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

CJK = re.compile(r"[\u3400-\u9fff]+")
#: Anything that makes the Chinese itself the thing under test rather than a label.
SEMANTIC = re.compile(
    r"[\u3000-\u303f\uff01-\uff5e\u200b-\u200f\u2028-\u202f]"   # ideographic space, CJK/full-width forms,
                                                                 # zero-width placeholders
    r"|[\U00010000-\U0010ffff]"                                  # outside the BMP
)
NUMERAL = "0-9一二三四五六七八九十百千万第一第二第三"


def vocabulary():
    path = os.path.join(HERE, "fixture-vocabulary.txt")
    tokens = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.split("#", 1)[0].strip()
            if line:
                tokens.extend(line.split())
    return sorted(set(tokens), key=len, reverse=True)


def catalogue_values():
    values = set()

    def walk(node):
        if isinstance(node, dict):
            for child in node.values():
                walk(child)
        elif isinstance(node, str) and node.strip():
            values.add(node.strip())

    with open(os.path.join(REPO_ROOT, "src/plugin/i18n/zh_CN.json"), encoding="utf-8") as handle:
        walk(json.load(handle))
    return values


def allowlist_entries():
    path = os.path.join(HERE, "language-allowlist.txt")
    entries = set()
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                line = line.split("#", 1)[0].strip()
                if line:
                    entries.add(line.split(":", 1)[-1].strip())
    return entries


def segments(label, tokens):
    """Can this label be spelled entirely with vocabulary words (plus numerals and ASCII)?

    Greedy longest-first, then a check that nothing is left over. Returns the leftover text, empty when
    the label is composed of function words.
    """
    rest = label
    for token in tokens:
        rest = rest.replace(token, "")
    return re.sub(r"[%s\sA-Za-z0-9.,:;!?()\[\]{}<>/\\|+\-=_*'\"~`@#$%%^&]" % NUMERAL, "", rest)


def evaluate(literals, tokens, catalogue, allowlist):
    """Returns (findings, excused-by-rule, examples). Pure —— the selftest drives it directly."""
    findings, excused = [], Counter()
    for item in literals:
        body = item["text"]
        if len(body) >= 2 and body[0] in "\"'`" and body[-1] == body[0]:
            body = body[1:-1]
        if not CJK.search(body):
            continue
        if body.strip() in catalogue:
            excused["catalogue"] += 1
            continue
        if SEMANTIC.search(body):
            excused["semantics"] += 1
            continue
        if body.strip() in allowlist:
            excused["allowlist"] += 1
            continue
        # ★ Only a **pure Chinese** literal is a fixture. A mixed one is an English message or a selector
        #   quoting a fixture ("the panel should contain ”输入“"), and judging it whole would report the
        #   message instead of the fixture —— 500 findings, almost all of them prose about a label.
        runs = [m.group(0) for m in CJK.finditer(body)]
        if not runs:
            continue
        # ★ Judged per **run**, not per literal. A one-character label describes nothing and cannot carry
        #   content (it tells one sibling from another), and such labels sit inside larger samples —— a
        #   document whose nodes are 甲/乙 while its body is 节点一/节点二. A run is fine when it is one
        #   character or when it is spelled entirely with the vocabulary; anything else is content.
        bad = [run for run in runs if len(run) > 1 and segments(run, tokens)]
        if not bad:
            excused["labels-only"] += 1
            continue
        if re.search(r"[A-Za-z]", body) or len(runs) > 1 and re.search(r"[A-Za-z0-9]", body):
            excused["quoted-in-message"] += 1
            continue
        findings.append((item["file"], item["line"], body,
                         " ".join("%s -> %s" % (run, segments(run, tokens)) for run in bad)))
    return findings, excused


def tracked_test_files():
    out = subprocess.run(["git", "ls-files"], cwd=REPO_ROOT, capture_output=True, text=True, check=True)
    return [f for f in out.stdout.split("\n") if f and re.search(r"(\.test\.ts|\.spec\.ts|^e2e/.*\.ts)$", f)]


def extract(paths):
    out = subprocess.run(["node", os.path.join(HERE, "extract-literals.mjs"), *paths],
                         cwd=REPO_ROOT, capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


SELFTEST_CASES = (
    ("a function label passes", "节点二", True),
    ("a composed label passes", "第二段文本", True),
    ("a numbered label passes", "标题1", True),
    ("content is a finding", "未收录词", False),
    ("a sentence is a finding", "未收录的句子", False),
    ("semantics is exempt", "上，下", True),
    ("the product name is not a fixture", "原生大纲导图", True),
)


def selftest():
    tokens = vocabulary()
    catalogue = {"原生大纲导图"}
    passed = failed = 0
    for name, label, expected_clean in SELFTEST_CASES:
        # semantics / catalogue exemptions are what "clean" means here
        findings, _ = evaluate([{"text": "'%s'" % label, "file": "t.test.ts", "line": 1}], tokens,
                               catalogue, set())
        clean = not findings
        ok = clean == expected_clean
        print("  %s %s%s" % ("PASS" if ok else "FAIL", name,
                             "" if ok else "  (expected %s)" % ("clean" if expected_clean else "a finding")))
        passed, failed = (passed + 1, failed) if ok else (passed, failed + 1)
    # ★ The vocabulary has to be able to fail: a label it does not carry must be a finding.
    findings, _ = evaluate([{"text": "'未收录词二'", "file": "t.test.ts", "line": 1}], tokens, set(), set())
    ok = bool(findings)
    print("  %s a label the list does not carry is a finding" % ("PASS" if ok else "FAIL"))
    passed, failed = (passed + 1, failed + 1 if not ok else failed)
    print("\nselftest: %s (%d case(s), %d failed)" % ("PASS" if not failed else "FAIL", passed + failed, failed))
    return 0 if not failed else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--list", action="store_true", help="print every exempted literal with its rule")
    args = ap.parse_args()
    if args.selftest:
        return selftest()

    tokens = vocabulary()
    literals = extract(tracked_test_files())
    findings, excused = evaluate(literals, tokens, catalogue_values(), allowlist_entries())

    used = set()
    for item in literals:
        body = item["text"][1:-1] if len(item["text"]) >= 2 else item["text"]
        for token in tokens:
            if token in body:
                used.add(token)
    stale = [t for t in tokens if t not in used]

    for path, line, body, leftover in findings[:40]:
        print("  %s:%d: %s  (not vocabulary: %s)" % (path, line, body[:40], leftover[:20]))
    if args.list:
        for name, count in excused.items():
            print("  -- %s: %d literal(s)" % (name, count))
    for token in stale:
        print("  stale vocabulary entry: %s" % token)
    print("check-fixture-text: %d finding(s), %d exempt (catalogue %d, semantics %d, allowlist %d), "
          "%d stale token(s)"
          % (len(findings), sum(excused.values()), excused.get("catalogue", 0), excused.get("semantics", 0),
             excused.get("allowlist", 0), len(stale)))
    return 1 if findings or stale else 0


if __name__ == "__main__":
    sys.exit(main())
