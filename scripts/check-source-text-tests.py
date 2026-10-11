#!/usr/bin/env python3
"""Find test files that assert on the **text of product source** instead of on behaviour.

A test that reads `src/…/Foo.tsx` and regex-matches its contents cannot go red when the product breaks.
It goes red when the product is **reworded** —— which is worse than useless, because the failure looks like
a regression in the code that was just cleaned up, and the "fix" is to update the pattern. Measured: merging
two hand-written cycle guards into one shared helper broke `mindmap-reparent.test.ts`, which was grepping
for the old helper's name; the behaviour was identical and every E2E case passed.

This repository deleted 15 such files in one pass. This tool exists so they do not come back.

★ The criterion is a **pair**, not either half alone:
    · the file reads a product source file (a `.ts`/`.tsx` under `src/`, not a fixture, not `dist-plugin`), AND
    · the file imports nothing from the product —— so nothing in it can execute product logic.
  Either half on its own has legitimate exceptions, and this repository has both:
    · reading the **built artifact** (`dist-plugin/index.js`) is real output, so
      `minify-tdz.test.ts` and `tooltip-build.test.ts` are fine —— they are pinned as exemptions below;
    · a file may import the product **and** read source for a structural reason (`source-probe.test.ts`
      tests the probe itself). Those are reported as `mixed` and left alone, because a person has to judge
      whether the text half adds anything.

Usage:
    python3 scripts/check-source-text-tests.py [--list]

Exit code: 1 when a file matches the pair above and is not an explicit exemption.
"""
from __future__ import annotations

import argparse
import glob
import io
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from script_log import track  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Test files that read product source text on purpose, each with the reason. An exemption is a decision;
# a pattern that cannot tell a deliberate case from a defect is a pattern that gets silenced.
EXEMPT = {
    'src/plugin/source-probe.test.ts':
        'tests the source-probe helper itself, which necessarily reads source text',
    'src/model/tree.test.ts':
        'imports the product and asserts behaviour; any source read is incidental',
}

READS = re.compile(r"readFileSync\(\s*([^,)]+)")
PRODUCT_IMPORT = re.compile(r"^import .*from '(?!node:)[^']*'", re.M)
# Paths that are legitimate to read: fixtures, and the built bundle (real output, not source).
LEGIT_PATH = re.compile(r"__fixtures__|dist-plugin|\.json['\"]|index\.js|package\.json|styles\.css")
SOURCE_PATH = re.compile(r"\.tsx?['\"]|\$\{[^}]*\}|join\(")


def source_reads(text: str) -> bool:
    """Does this file read a product `.ts`/`.tsx` source file?"""
    for m in READS.finditer(text):
        arg = m.group(1)
        if LEGIT_PATH.search(arg):
            continue
        if SOURCE_PATH.search(arg) or re.search(r"'[^']*'\s*\+", arg):
            return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--list', action='store_true', help='print the classification of every test file')
    args = ap.parse_args()

    pure: list[str] = []
    mixed: list[str] = []
    total = 0
    for path in sorted(glob.glob(os.path.join(ROOT, 'src', '**', '*.test.ts'), recursive=True)
                       + glob.glob(os.path.join(ROOT, 'src', '**', '*.test.tsx'), recursive=True)):
        rel = os.path.relpath(path, ROOT)
        total += 1
        text = io.open(path, encoding='utf-8').read()
        if not source_reads(text):
            continue
        (mixed if PRODUCT_IMPORT.search(text) else pure).append(rel)

    if args.list:
        print(f'  {total} test file(s)')
        print(f'\n  reads product source AND imports the product (judge by hand):')
        for m in mixed:
            print(f'    {m}')
        print(f'\n  reads product source, imports nothing (cannot test behaviour):')
        for m in pure:
            print(f'    {m}{"   [exempt]" if m in EXEMPT else ""}')
        return 0

    offenders = [p for p in pure if p not in EXEMPT]
    print(f'check-source-text-tests: {total} test file(s), {len(pure)} read product source without '
          f'importing the product, {len(mixed)} do both')

    if offenders:
        print(f'\n✘ {len(offenders)} file(s) assert on source **text** with nothing imported —— they can '
              'only go red when the product is reworded:')
        for o in offenders:
            print(f'    {o}')
        print('\n  Replace it with a case that drives the behaviour (an E2E case if that needs a browser), '
              'or add it to EXEMPT in this script with the reason it must read text.')
        return 1

    print('\n★ What this does NOT see: a file that imports the product and *also* greps its source is '
          'reported as `mixed` and left alone —— the text half may still be worthless. Nor can it tell '
          'whether the behavioural half is any good. It catches the one shape that is unambiguous: nothing '
          'imported, so nothing can be executed.')
    return 0


if __name__ == '__main__':
    with track('check-source-text-tests'):
        sys.exit(main())
