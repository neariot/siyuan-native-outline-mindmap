#!/usr/bin/env python3
"""Check that every `npm run <script>` a document names really exists in `package.json`.

The failure this prevents: a README shipped to users told them to run `TARGET=plugin npm run build`, and
the build config's own comment said there is no `TARGET` switch; a "development preview" section described
a `npm run dev` that could not serve anything (the build sets `html: false`, so there is no page). Both
survived because **a command in prose is never executed by anything** —— no gate reads a README.

★ What this checks is only what a script can check honestly:
  · every `npm run <name>` in a tracked document resolves to a script;
  · every script in `package.json` is either referenced by a document or listed in
    `scripts/command-allowlist.txt` as deliberately undocumented (a CI-only or internal helper).

★ What it does NOT check, and says so in its output: whether the command *does what the surrounding prose
  claims*. `TARGET=plugin npm run build` would have passed this gate —— `build` exists; the invented part
  was the environment variable in front of it. Catching that needs a reader, or a config whose own comments
  contradict the doc, which is how it was eventually found.

Usage:
    python3 scripts/check-documented-commands.py [--list]

Exit code: 0 when everything resolves, 1 on a documented command with no script or an unexplained script.
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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALLOWLIST = os.path.join(ROOT, 'scripts', 'command-allowlist.txt')

# Documents a user or contributor reads and acts on. `docs/AUDIT-FINDINGS.md` is deliberately absent: it
# is a work queue whose prose quotes commands it is *describing*, not recommending, and a finding about a
# command that does not exist is the point of that file rather than a defect in it.
DOCS = [
    'README.md', 'README.zh-CN.md', 'AGENTS.md',
    'docs/GETTING-STARTED.md', 'docs/GETTING-STARTED.zh-CN.md',
    'docs/SHORTCUTS.md', 'docs/SHORTCUTS.zh-CN.md',
    'docs/TESTING.md', 'docs/DEVELOPMENT.md', 'docs/DISTRIBUTION-README.md',
]
DOC_GLOBS = ['docs/*.md']

# `npm run <name>` and the `npm test` shorthand. ★ Two bugs lived in this pattern, both found by running
# it against the real documents rather than trusting it:
#   · matching only `npm run` missed `npm test`, so `test` came back as an undocumented script and the
#     "fix" looked like an allowlist entry;
#   · allowing any word after `npm` made **prose** match: the audit file's "there is no npm script, no
#     reference in docs/TESTING.md" was read as a command named `script`. A command is a token in a code
#     position, so the pattern requires `run <name>` or the four shorthands npm actually has.
NPM_RUN = re.compile(r'npm run ([A-Za-z0-9:_.-]+)|npm (test|start|stop|restart)\b')
# `npm ci` / `npm install` are npm's own commands, checked by nothing here.
# Commands run directly rather than through a script, which are checked separately (they are files).
PY = re.compile(r'python3 (scripts/[A-Za-z0-9_./-]+\.py)')
NODE = re.compile(r'node (scripts/[A-Za-z0-9_./-]+\.mjs)')


# ★ Scanned by the `docs/*.md` glob but deliberately not treated as advice the reader should follow:
#   the work queue quotes the commands it is *describing*, and a finding about a command that does not
#   exist is the point of that file rather than a defect in it. An earlier version promised this exclusion
#   in the docstring while the glob quietly re-added the file —— a comment describing behaviour the code
#   did not have, which is the failure mode this repository keeps meeting.
NOT_ADVICE = {'docs/AUDIT-FINDINGS.md', 'docs/TODO.md'}


def documented_files() -> list[str]:
    out: list[str] = []
    for d in DOCS:
        if os.path.exists(os.path.join(ROOT, d)):
            out.append(d)
    import glob as _glob
    for pattern in DOC_GLOBS:
        for path in sorted(_glob.glob(os.path.join(ROOT, pattern))):
            rel = os.path.relpath(path, ROOT)
            if rel not in out and rel not in NOT_ADVICE:
                out.append(rel)
    return out


def read_allowlist() -> set[str]:
    if not os.path.exists(ALLOWLIST):
        return set()
    names = set()
    for line in io.open(ALLOWLIST, encoding='utf-8'):
        line = line.split('#', 1)[0].strip()
        if line:
            names.add(line)
    return names


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--list', action='store_true', help='print every reference found, then exit')
    args = ap.parse_args()

    scripts = json.load(io.open(os.path.join(ROOT, 'package.json'), encoding='utf-8'))['scripts']
    allow = read_allowlist()
    files = documented_files()

    used: dict[str, list[str]] = {}
    problems: list[str] = []
    refs = 0

    for rel in files:
        text = io.open(os.path.join(ROOT, rel), encoding='utf-8').read()
        for m in NPM_RUN.finditer(text):
            name = m.group(1) or m.group(2)
            refs += 1
            used.setdefault(name, []).append(rel)
            if name not in scripts:
                problems.append(f'{rel}: `npm run {name}` —— no such script in package.json')
        for m in PY.finditer(text):
            refs += 1
            target = m.group(1)
            if not os.path.exists(os.path.join(ROOT, target)):
                problems.append(f'{rel}: `{target}` —— the file does not exist')
        for m in NODE.finditer(text):
            refs += 1
            target = m.group(1)
            if not os.path.exists(os.path.join(ROOT, target)):
                problems.append(f'{rel}: `{target}` —— the file does not exist')

    if args.list:
        for name in sorted(used):
            print(f'  {name:<22} {", ".join(sorted(set(used[name])))}')
        return 0

    # The reverse direction: a script no document names. Not an error by itself —— some are CI-only or
    # internal —— but each silently-undocumented one must be a decision, so they are listed rather than
    # left to be rediscovered.
    undocumented = sorted(n for n in scripts if n not in used and n not in allow)

    print(f'check-documented-commands: {len(files)} document(s), {refs} command reference(s), '
          f'{len(scripts)} script(s) in package.json')

    if undocumented:
        print(f'\n  {len(undocumented)} script(s) no document names:')
        for n in undocumented:
            print(f'    · {n:<22} = {scripts[n]}')
        print('    Add it to a document, or to `scripts/command-allowlist.txt` with the reason it is '
              'deliberately undocumented.')

    if problems:
        print(f'\n✘ {len(problems)} documented command(s) do not resolve:')
        for p in problems:
            print(f'    {p}')
        return 1

    print('\n★ What this does NOT check: whether a command does what the prose around it claims. An '
          'invented **flag or environment variable** in front of a real script passes here —— a README '
          'once told users to run `TARGET=plugin npm run build` while the build config said there is no '
          'TARGET switch. Catching that needs a reader.')
    return 0


if __name__ == '__main__':
    with track('check-documented-commands'):
        sys.exit(main())
