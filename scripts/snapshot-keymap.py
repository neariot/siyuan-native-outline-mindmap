#!/usr/bin/env python3
"""Export a snapshot of the "built-in hotkey occupancy table" from a running SiYuan.

──────────────────────────────────────────────────────────────────
Why this script is needed
──────────────────────────────────────────────────────────────────

When the plugin binds default hotkeys to its own commands, it must avoid the keys SiYuan's built-ins already occupy.
Otherwise two commands bind the same key and the result depends on who takes the event first —— pressing it
may insert a memo, or may open the mind map, and that varies with the SiYuan version.

Checking by hand is unreliable (this plugin got it wrong once: `⌥⌘M` was written into a comment as "not occupied",
while it had long been taken by `/editor/insert/memo`). So the occupancy table is exported into a snapshot,
which `src/plugin/hotkey-collision.test.ts` checks on every test run.

That way, when SiYuan is upgraded and the built-in key bindings change, the test goes red along with them —— instead of waiting for a user to find
"pressing the hotkey does nothing" or "pressing it produces something else".

──────────────────────────────────────────────────────────────────
Usage
──────────────────────────────────────────────────────────────────

    python3 scripts/snapshot-keymap.py

It writes to src/plugin/__fixtures__/siyuan-keymap.json (overwriting the old one).
SiYuan must be running and CDP reachable (configuration in .env).
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Tab, close_stale_tabs, CDPUnreachable  # noqa: E402
from env import cfg  # noqa: E402
import script_log  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'src', 'plugin', '__fixtures__', 'siyuan-keymap.json')

# Flatten the hotkeys of all built-in sections in the page into "key → command path".
# Only the built-in sections are looked at (editor / general / filetree …), **the plugin section is not included** ——
# the plugin section is the very thing we are checking, so it must not count as "occupied".
EXPR = r"""
(() => {
  const km = window.siyuan && window.siyuan.config && window.siyuan.config.keymap;
  if (!km) return JSON.stringify({ error: 'no-keymap' });
  const out = {};
  const walk = (obj, prefix) => {
    if (!obj || typeof obj !== 'object') return;
    for (const key in obj) {
      const val = obj[key];
      if (!val || typeof val !== 'object') continue;
      if ('default' in val || 'custom' in val) {
        // ★ Built-ins only: `default` wins over `custom`. A customized machine would otherwise
        //   write its personal bindings into the tracked fixture that the collision test treats
        //   as SiYuan's built-in table. Both empty means "no key bound".
        const hk = (val.default || '').trim();
        if (hk) {
          // Keep all of them when one key is occupied by several commands, to make troubleshooting easier
          const prev = out[hk];
          const here = prefix + '/' + key;
          out[hk] = prev ? prev + ', ' + here : here;
        }
      } else {
        walk(val, prefix + '/' + key);
      }
    }
  };
  for (const section in km) {
    if (section === 'plugin') continue;   // see above: the plugin section takes no part in "built-in occupancy"
    walk(km[section], '/' + section);
  }
  return JSON.stringify({ ok: out });
})()
"""


def main():
    close_stale_tabs()
    tab = Tab(
        cfg.build_url('desktop', ''),
        w=1400,
        h=900,
        ready="!!window.siyuan",
    )
    try:
        raw = tab.ev(EXPR)
        data = json.loads(raw) if raw else {}
        if 'error' in data:
            print("❌ Could not get SiYuan's keymap: %s" % data['error'])
            return 1
        table = data.get('ok') or {}
        if not table:
            print('❌ The export came out empty —— refusing to write an empty snapshot (an empty table would make the collision check meaningless)')
            return 1
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, 'w', encoding='utf-8') as f:
            json.dump(table, f, ensure_ascii=False, indent=1, sort_keys=True)
            f.write('\n')
        print('✅ Wrote %s' % os.path.relpath(OUT, ROOT))
        print('   %d built-in key bindings in total' % len(table))
        for target in ('⌥⌘O', '⌥⌘I', '⌥⌘M'):
            who = table.get(target)
            print('   %s → %s' % (target, who if who else '(free)'))
        return 0
    finally:
        tab.close()


if __name__ == '__main__':
    with script_log.track("snapshot-keymap"):
        try:
            sys.exit(main())
        except CDPUnreachable as exc:
            print(f"snapshot-keymap: cannot run —— {exc}", file=sys.stderr)
            sys.exit(2)
