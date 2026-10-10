#!/usr/bin/env python3
"""Style scoping gate: no unscoped bare selector may appear in the build output index.css.

──────────────────────────────────────────────────────────────────────
Why this script is needed
──────────────────────────────────────────────────────────────────────
The plugin's CSS is **injected globally** (SiYuan attaches it to the host page with <link>; there is no Shadow DOM).
The source once had 173 selectors written as bare class names: `.node-row`, `.outliner-title`, `.btn`,
`.link-chip`, `.match-item`…… those names are far too generic, and the risk of colliding with the host
or another plugin's names is always there.

"SiYuan happens not to use that class name right now" is not a reason —— the host being redesigned, another
plugin being installed, or even just a second plugin on the same page, can all collide out of the blue.
So they must be scoped **unconditionally**.

The scoping itself happens at build time (see scripts/css-scope.mjs + rsbuild.config.ts);
this script does the **acceptance check**: it scans the output after the build and fails the build
on any bare selector that slipped through.

The two work front to back, insuring each other —— if the prefixer is ever broken or bypassed,
this will stop it at once, rather than waiting for a user to see a broken interface.

Usage:
    python3 scripts/verify-css-scope.py            # check dist-plugin/index.css
    python3 scripts/verify-css-scope.py <file.css>
"""

import re
import sys
import os
import script_log

HOST_SCOPE = '.om-mm-host'

# Allowed scope forms: as long as one of them is present, the selector counts as pulled into the plugin.
ALLOWED_SCOPES = (
    HOST_SCOPE,              # attached under the plugin container (the absolute mainstay)
    '.om-',                  # the plugin's own prefixed class names
    '.mm-',                  # mind map internal prefix
    '.mobile-keyboard-bar',  # mobile soft keyboard bar: rendered inside the plugin container, but its class has no om- prefix
    'b3-',                   # SiYuan canonical class names (e.g. the b3-menu slot)
    '[class*="om-"]',        # attribute-selector form
)

# Keyframes inside `@keyframes` (from/to/50%) are not selectors, skip them.
KEYFRAME_SELECTOR = re.compile(r'^(from|to|\d+(\.\d+)?%)(\s*,\s*(from|to|\d+(\.\d+)?%))*$')


def strip_comments(css):
    return re.sub(r'/\*.*?\*/', '', css, flags=re.DOTALL)


def iter_rules(css):
    """Yield (line number, selector, whether inside an at-rule such as @media/@supports).

    Scans character by character with bracket matching —— a simple regex cannot handle nested @media.
    """
    stack = []
    buf = ''
    line = 1
    for ch in css:
        if ch == '\n':
            line += 1
        elif ch == '{':
            sel = buf.strip()
            buf = ''
            if sel.startswith('@'):
                stack.append('at')
            else:
                yield line, sel, 'at' in stack
                stack.append('rule')
        elif ch == '}':
            if stack:
                stack.pop()
            buf = ''
        else:
            buf += ch


def is_scoped(selector):
    return any(s in selector for s in ALLOWED_SCOPES)


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'dist-plugin/index.css'
    if not os.path.exists(path):
        print(f'  ❌ {path} not found, run npm run build first')
        return 1

    css = strip_comments(open(path, encoding='utf-8').read())

    total = 0
    bad = []
    for line, sel, _ in iter_rules(css):
        for one in (x.strip() for x in sel.split(',')):
            if not one:
                continue
            if KEYFRAME_SELECTOR.match(one):
                continue
            total += 1
            if not is_scoped(one):
                bad.append((line, one))

    print(f'  selectors total  {total}')
    print(f'  scoped           {total - len(bad)}')
    print(f'  unscoped         {len(bad)}')

    if bad:
        print()
        print(f'  ❌ Found {len(bad)} unscoped bare selectors, release is forbidden:')
        seen = set()
        for line, one in bad:
            if one in seen:
                continue
            seen.add(one)
            print(f'     {path}:{line}  {one[:88]}')
            if len(seen) >= 15:
                print(f'     ... plus {len(bad) - len(seen)} more collapsed')
                break
        print()
        print('  How to fix: such selectors are automatically scoped into ' + HOST_SCOPE + ' by the build-time prefixer,')
        print('       so reaching this point means the prefixer did not take effect or was bypassed ——')
        print('       check tools.postcss in rsbuild.config.ts and scripts/css-scope.mjs.')
        return 1

    print()
    print(f'  ✅ All {total} selectors are scoped into the plugin')
    return 0


if __name__ == '__main__':
    with script_log.track("verify-css-scope"):
        sys.exit(main())
