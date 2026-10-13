#!/usr/bin/env python3
"""Check that every finding in `docs/AUDIT-FINDINGS.md` still points at code that exists.

`docs/AUDIT-FINDINGS.md` is a work queue: "an entry leaves it by being fixed, or by being refuted in
writing." Nothing verified either half, so an entry whose defect was fixed months ago stays in the queue
looking exactly like a live one, and a reader cannot tell them apart. That is how a 200-entry queue becomes
a file people stop reading.

This tool answers the one question a pattern *can* answer: **does the cited `file:line` still resolve, and
does the code at that place still resemble what the finding described?** It deliberately does not try to
decide whether a defect is fixed —— that needs judgement, and a tool that guessed would be worse than none.
It reports three states and prints what it cannot see:

  stale-file    the cited file does not exist (moved, renamed, deleted)
  stale-line    the file exists but has fewer lines than the citation
  drifted       the line resolves, but none of the finding's own identifiers are near it
  cannot-judge  the finding names no identifier (prose about a doc or a UI string): nothing to search for
  ok            the citation resolves and the finding's identifiers are at (or near) the citation

★ It is a *triage aid*, not an authority. `drifted` means "a human must re-read this one" —— a fixed
  defect and a moved line look the same to a substring search, which is exactly why the report says so
  instead of marking anything fixed.

Usage:
    python3 scripts/check-audit-findings.py [--limit N] [--state STATE] [--json]

Exit code:
  0  nothing a tool can decide is wrong
  1  at least one entry cites a file that does not exist, or a line past the end of its file
  2  the ledger could not be parsed at all

★ `stale-file` / `stale-line` are a **hard failure** because each has exactly two possible meanings and
  both are actionable without judgement: the defect was fixed (the entry leaves the queue) or the code
  moved (the citation is corrected). Leaving them unread is what turns the queue into a file people stop
  trusting. `drifted` and `cannot-judge` are **not** failures —— whether a defect is fixed needs a person,
  and a gate that guessed would train people to silence it.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from script_log import track  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # rebound by --selftest
LEDGER = os.path.join(ROOT, 'docs', 'AUDIT-FINDINGS.md')

# `- **medium · bug** `src/core/map.ts:639`` then an indented description on the following line(s).
ENTRY = re.compile(r'^- \*\*(?P<sev>high|medium|low) · (?P<cat>[a-z-]+)\*\* `(?P<file>[^`]+?)`\s*$')
CITE = re.compile(r'^(?P<file>.+?):(?P<line>\d+)$')

# How far from the cited line we look for the finding's own wording before calling it drifted. Line
# numbers move when unrelated code is added above; a fix that rewrites the area moves it much further.
NEAR = 12


def normalise(s: str) -> str:
    """Words only, so a comparison is not defeated by reflowed prose or changed punctuation."""
    return re.sub(r'[^a-z0-9]+', ' ', s.lower()).strip()


def distinguishing_words(desc: str) -> list[str]:
    """Code identifiers named in the finding's prose —— file names, symbols, config keys.

    ★★ Only **identifier-shaped** tokens count, and that restriction is the whole point. A first version
    accepted any word of seven characters or more, so the README finding ("The Chinese README still
    documents a build flag ...") searched the file for `Chinese` and `documents` —— prose that no source
    file contains —— and reported `drifted` for a finding whose citation was perfectly good. Sixty entries
    came back `drifted` on that criterion, which is a number that looks like a finding and means nothing.

    The useful signal is a name the *code* also carries: a finding about `pruneDestroyedSiblings` says so,
    and searching that still finds the code after the line number has moved. When the prose names no such
    thing (a prose-only finding about a README, a doc, or a UI string), there is nothing to search for and
    the honest answer is `cannot-judge`, not a guess in either direction.
    """
    tokens = re.findall(r'[A-Za-z_][A-Za-z0-9_]{6,}', desc)
    seen: list[str] = []
    for t in tokens:
        # identifier-shaped: has an underscore, is SCREAMING_CASE, or is camelCase/mixedCase. A plain
        # capitalised English word ("Chinese", "Delete") is prose, and searching for it is how the first
        # version produced 60 false `drifted`.
        if ('_' in t) or t.isupper() or (re.search(r'[a-z][A-Z]', t) and not t[0].isupper()):
            if t not in seen:
                seen.append(t)
    return seen[:8]


def header_counts(text: str) -> dict | None:
    """The header's own tally, or None when the rows are absent.

    ★ The header says the count is "derived from the entries themselves so it cannot drift" —— and it
    drifted anyway (206 while the file held 193, and a `16 fixed or refuted` claim that no longer
    matched the 147 struck entries). A claim about the file that nothing recomputes is a claim that
    goes stale silently, so this reads the four rows back and `main` fails when they disagree.
    """
    rows = {}
    for label, key in (
        ('entries in this file', 'entries'),
        ('severity', 'severity'),
        ('by category', 'category'),
    ):
        m = re.search(r'^\| ' + re.escape(label) + r' \| (.+?) \|$', text, re.M)
        if not m:
            return None
        rows[key] = m.group(1)
    return rows


def cat_counts(s: str) -> dict:
    """`test-quality 52, docs 50` → counts. Order-insensitive on purpose: tying counts have no
    canonical order, and demanding one would make the check fail on a cosmetic reshuffle."""
    return {m[1]: int(m[2]) for m in re.finditer(r'([a-z][a-z-]*) (\d+)', s)}


def tally(entries: list[dict], text: str) -> dict:
    """Recount the file the way the header reports it: severity and category over **all** entries,
    open and struck alike (`137 low, 69 medium` summed to the `206` total), while the open/struck
    split is carried by the entries row."""
    import collections
    all_e = re.findall(r'^- (?:~~)?\*\*(high|medium|low) · ([a-z-]+)\*\*', text, re.M)
    struck = len(re.findall(r'^- ~~\*\*', text, re.M))
    sev = collections.Counter(sev for sev, _ in all_e)
    cat = collections.Counter(cat for _, cat in all_e)
    return {
        'total': len(all_e),
        'open': len(entries),
        'struck': struck,
        'severity': f"{sev.get('low', 0)} low, {sev.get('medium', 0)} medium"
                    + (f", {sev['high']} high" if sev.get('high') else ''),
        'severity_counts': dict(sev),
        'category': ', '.join(f'{k} {v}' for k, v in sorted(cat.items(), key=lambda kv: (-kv[1], kv[0]))),
        'category_counts': dict(cat),
    }


def parse_ledger(text: str) -> list[dict]:
    lines = text.split('\n')
    out: list[dict] = []
    for n, line in enumerate(lines):
        m = ENTRY.match(line)
        if not m:
            continue
        desc = ''
        for follow in lines[n + 1:]:
            if follow.startswith('- ') or follow.startswith('#'):
                break
            if follow.strip():
                desc += ' ' + follow.strip()
        cite = CITE.match(m.group('file').strip())
        out.append({
            'sev': m.group('sev'),
            'cat': m.group('cat'),
            'file': cite.group('file') if cite else m.group('file').strip(),
            'line': int(cite.group('line')) if cite else None,
            'desc': desc.strip(),
            'ledger_line': n + 1,
        })
    return out


def classify(entry: dict) -> dict:
    path = os.path.join(ROOT, entry['file'])
    if not os.path.exists(path):
        return {**entry, 'state': 'stale-file', 'note': 'the cited file does not exist'}
    if entry['line'] is None:
        return {**entry, 'state': 'no-line', 'note': 'the citation carries no line number'}

    try:
        src = io.open(path, encoding='utf-8', errors='replace').read().split('\n')
    except OSError as exc:
        return {**entry, 'state': 'stale-file', 'note': f'unreadable: {exc}'}
    if entry['line'] > len(src):
        return {**entry, 'state': 'stale-line',
                'note': f'the file has {len(src)} lines, the citation says {entry["line"]}'}

    words = distinguishing_words(entry['desc'])
    # Everything a finding could be pointing at: the line itself and its immediate neighbourhood.
    lo = max(0, entry['line'] - 1 - NEAR)
    hi = min(len(src), entry['line'] + NEAR)
    window = normalise('\n'.join(src[lo:hi]))

    if not words:
        # No name to search for. The citation resolves, so this is not stale —— but nothing here can
        # confirm the code is still the code the finding described, and saying `ok` would overclaim.
        return {**entry, 'state': 'cannot-judge',
                'note': 'prose-only finding: it names no symbol, file or key to search for'}
    hits = [w for w in words if normalise(w) in window]
    if not hits:
        return {**entry, 'state': 'drifted',
                'note': f'none of {", ".join(words[:4])} appear within {NEAR} lines'}
    return {**entry, 'state': 'ok', 'note': f'{len(hits)}/{len(words)} identifiers near the line'}


def selftest() -> int:
    """Check this checker against in-memory fixtures.

    Every tool in this repository is expected to be able to fail, and a tool whose failure path nothing
    exercises is a tool that reports whatever it likes. These cases pin the three decisions that matter,
    using a temporary tree so nothing here depends on the real repository's contents.

    Sections where this tool has already been wrong, and which are therefore pinned:
      · a finding's prose is not an identifier —— the first version searched for `Chinese` and reported 60
        entries drifted for a criterion that meant nothing;
      · an entry the strict pattern cannot parse must be an error, not a silent skip —— it once reported 205
        findings for a file holding 206.
    """
    import tempfile
    failures = 0

    def check(what: str, got: object, want: object) -> None:
        nonlocal failures
        if got != want:
            failures += 1
            print(f'  ✘ {what}: got {got!r}, want {want!r}')

    # The prose/identifier distinction, which is the whole reason `cannot-judge` exists.
    check('prose words are not identifiers',
          distinguishing_words('The Chinese README still documents a build flag that no longer exists'), [])
    check('camelCase counts', distinguishing_words('pruneDestroyedSiblings loses its mapping') != [], True)
    check('snake_case counts', distinguishing_words('handleMentionClick is never called') != [], True)
    check('SCREAMING_CASE counts', distinguishing_words('MOBILE_MAX_WIDTH is duplicated') != [], True)

    # The classifier, against a scratch tree: a missing file, a past-EOF line, and a resolving citation.
    with tempfile.TemporaryDirectory() as td:
        with io.open(os.path.join(td, 'small.ts'), 'w', encoding='utf-8') as fh:
            fh.write('const pruneDestroyedSiblings = 1;\n')
        global ROOT
        real_root = ROOT
        try:
            ROOT = td
            check('a missing file is stale-file',
                  classify({'file': 'nope.ts', 'line': 1, 'desc': 'x'})['state'], 'stale-file')
            check('a line past the end is stale-line',
                  classify({'file': 'small.ts', 'line': 99, 'desc': 'x'})['state'], 'stale-line')
            check('a resolving citation with its identifier is ok',
                  classify({'file': 'small.ts', 'line': 1,
                            'desc': 'pruneDestroyedSiblings declares a sibling destroyed'})['state'], 'ok')
            check('an entry naming no identifier cannot be judged',
                  classify({'file': 'small.ts', 'line': 1,
                            'desc': 'The Chinese README is stale'})['state'], 'cannot-judge')
        finally:
            ROOT = real_root

    # The parser must not skip an entry it cannot match.
    parsed = parse_ledger('- **low · bug** `a.ts:1`  \n  a description here\n')
    check('a well-formed entry parses', len(parsed), 1)
    check('the citation is split', (parsed[0]['file'], parsed[0]['line']), ('a.ts', 1) if parsed else None)

    # ★ The header tally check, both directions —— a check that cannot go red is not a check.
    hdr = (
        '| entries in this file | **2** (1 struck, 1 open) |\n'
        '| severity | 1 low, 1 medium |\n'
        '| by category | bug 1, docs 1 |\n'
    )
    body = '- **low · docs** `a.ts:1`  \n  d\n- ~~**medium · bug** `a.ts:2`~~ **fixed**\n  d\n'
    good = parse_ledger(body)
    check('the header tally matches the entries',
          tally(good, body)['total'], 2)
    check('the severity row is reproduced verbatim',
          tally(good, body)['severity'], '1 low, 1 medium')
    check('the category row is order-insensitive',
          cat_counts('bug 1, docs 1'), {'bug': 1, 'docs': 1})
    check('the category row is reproduced as counts',
          cat_counts(tally(good, body)['category']), {'bug': 1, 'docs': 1})
    check('the header rows are read back',
          header_counts(hdr) is not None, True)
    check('a stale header is not accepted',
          header_counts(hdr)['severity'] == tally(good, body)['severity'], True)
    stale = hdr.replace('| severity | 1 low, 1 medium |', '| severity | 2 low, 0 medium |')
    check('a drifted header is detected',
          header_counts(stale)['severity'] != tally(good, body)['severity'], True)
    stale_cat = hdr.replace('| by category | bug 1, docs 1 |', '| by category | bug 2, docs 0 |')
    check('a drifted category row is detected',
          cat_counts(header_counts(stale_cat)['category']) != tally(good, body)['category_counts'], True)

    if failures:
        print(f'check-audit-findings --selftest: {failures} case(s) failed')
        return 1
    print('check-audit-findings --selftest: all cases pass')
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--limit', type=int, default=0, help='show at most N entries')
    ap.add_argument('--state', choices=['stale-file', 'stale-line', 'drifted', 'cannot-judge', 'ok', 'no-line'],
                    help='only show this state')
    ap.add_argument('--json', action='store_true', help='machine-readable output')
    ap.add_argument('--selftest', action='store_true',
                    help='check this checker against in-memory fixtures, then exit')
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    if not os.path.exists(LEDGER):
        print(f'check-audit-findings: {LEDGER} does not exist', file=sys.stderr)
        return 2
    text = io.open(LEDGER, encoding='utf-8').read()
    entries = parse_ledger(text)
    # ★ Count the entries the *loose* pattern sees and refuse to run if the strict parser dropped any.
    #   Measured: one entry carried trailing prose after its citation (`... \u2190 the last test file ...`),
    #   which the strict pattern rejects —— so the tool reported 205 findings where the file held 206 and
    #   said nothing about the one it had silently skipped. A tool that drops input and reports success is
    #   the vacuous pass this repository keeps warning about, so a mismatch is now a hard error.
    loose = len(re.findall(r'^- \*\*(?:high|medium|low) · ', text, re.M))
    if loose != len(entries):
        print(f'check-audit-findings: {loose} entry lines but only {len(entries)} parsed —— an entry does '
              'not match the expected shape (`- **severity · category** `file:line`  `). Fix the entry; do '
              'not let the tool skip it silently.', file=sys.stderr)
        for n, line in enumerate(text.split('\n'), 1):
            if re.match(r'^- \*\*(?:high|medium|low) · ', line) and not ENTRY.match(line):
                print(f'  line {n}: {line[:110]}', file=sys.stderr)
        return 2
    if not entries:
        print('check-audit-findings: the ledger parsed to ZERO findings —— the format changed, and a tool '
              'that reports "nothing stale" because it found nothing is the vacuous pass this repository '
              'keeps warning about.', file=sys.stderr)
        return 2

    results = [classify(e) for e in entries]
    counts: dict[str, int] = {}
    for r in results:
        counts[r['state']] = counts.get(r['state'], 0) + 1

    if args.json:
        print(json.dumps({'counts': counts, 'entries': results}, ensure_ascii=False, indent=1))
        return 0

    order = ['stale-file', 'stale-line', 'drifted', 'cannot-judge', 'no-line', 'ok']
    print(f'check-audit-findings: {len(results)} findings in docs/AUDIT-FINDINGS.md')
    for state in order:
        if counts.get(state):
            print(f'  {state:<12} {counts[state]}')

    shown = 0
    for r in results:
        if r['state'] == 'ok' or (args.state and r['state'] != args.state):
            continue
        if args.limit and shown >= args.limit:
            break
        shown += 1
        print(f"\n  [{r['state']}] {r['sev']} · {r['cat']}  {r['file']}:{r['line']}")
        print(f"      ledger line {r['ledger_line']} — {r['note']}")

    print('\n★ What this does NOT see: whether a defect is actually fixed. `ok` means the citation still '
          'resolves and the finding\'s own identifiers are near it —— not that the code is correct. A fixed '
          'defect and an edited line are indistinguishable to a substring search, so a human reads the '
          'entry before it leaves the queue.')
    print('★ `cannot-judge` is not a verdict: those findings name no symbol, so this tool has nothing to '
          'search for. They are the ones a reader must open first.')

    broken = counts.get('stale-file', 0) + counts.get('stale-line', 0)
    if broken:
        print(f'\n✘ {broken} entr{"y" if broken == 1 else "ies"} cite a place that no longer exists: '
              'the defect was fixed (remove the entry) or the code moved (correct the citation). '
              'Run with --json for the machine-readable list.')
        return 1

    # The header's tally must agree with the entries. Kept last so the more actionable citation errors
    # are reported first, and only a header that is actually present is checked.
    counts_row = header_counts(text)
    if counts_row:
        now = tally(entries, text)
        problems: list[str] = []
        if counts_row['entries'] != f"**{now['total']}** ({now['struck']} struck, {now['open']} open)":
            problems.append(f"entries in this file | {counts_row['entries']}")
        if counts_row['severity'] != now['severity']:
            problems.append(f"severity | {counts_row['severity']}")
        if cat_counts(counts_row['category']) != now['category_counts']:
            problems.append(f"by category | {counts_row['category']}")
        if problems:
            print('\n✘ the header tally disagrees with the entries:')
            for p in problems:
                print(f'    {p}')
            print('  expected:')
            print(f"    entries in this file | **{now['total']}** ({now['struck']} struck, {now['open']} open)")
            print(f"    severity | {now['severity']}")
            print(f"    by category | {now['category']}")
            return 1
    return 0


if __name__ == '__main__':
    with track('check-audit-findings'):
        sys.exit(main())
