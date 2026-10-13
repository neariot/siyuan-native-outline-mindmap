/**
 * Default hotkeys must not collide with keys SiYuan already uses (agy UI-TC-25).
 *
 * ──────────────────────────────────────────────────────────────────
 * Why this test exists
 * ──────────────────────────────────────────────────────────────────
 *
 * Before binding a hotkey you must check whether a SiYuan built-in already uses that key -- in practice `⌥⌘M` was taken long ago:
 *
 *     /editor/insert/memo   insert memo   ⌥⌘M
 *
 * When two commands share one key, the result depends on who receives the event first. That is not "it works", it is luck:
 * Pressing it may insert a memo or open the mind map, and which one it is changes with the SiYuan version.
 *
 * The right fix for this class of problem is not to win the race, but to **never collide at all**.
 * Checking by hand cannot prevent it (a previous check got it wrong), so it lives here as a test.
 *
 * ──────────────────────────────────────────────────────────────────
 * Where the evidence comes from
 * ──────────────────────────────────────────────────────────────────
 *
 * SiYuan's table of occupied hotkeys has two sources:
 *   1. Built-in bindings: defined in SiYuan's source; at runtime they land in `window.siyuan.config.keymap`
 *      under the `editor` / `general` / `filetree` ... sections. The test checks them via an **exported snapshot**
 *      (see `KEYMAP_SNAPSHOT`); the snapshot comes from a real running instance.
 *   2. Other plugins: `keymap.plugin.<pluginName>.<langKey>`.
 *
 * ★ This deliberately **hardcodes no list of which keys are occupied** -- such a list goes stale,
 *   and when it goes stale the test is still green (the worst case). Instead:
 *   · assert that our keys are absent from the snapshot, so refreshing the snapshot turns the test red;
 *   · assert that our two keys differ from each other;
 *   · assert the bound key parses as ⌥⌘/⌘/⌃⌘ + a single character, so we never write a string SiYuan cannot read.
 *
 * Snapshot file: `src/plugin/__fixtures__/siyuan-keymap.json`
 * (exported from a running SiYuan by `scripts/snapshot-keymap.py`)
 */

export {};

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(`${name} ${extra}`);
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** Hotkeys our plugin registers. Keep in sync with addCommand in src/plugin/index.ts. */
const OUR_HOTKEYS: Record<string, string> = {
  openMindmap: '⌥⌘O',
  insertMirror: '⌥⌘I',
};

/** Read the snapshot of SiYuan's built-in hotkeys (exported from a real instance) */
function loadSiYuanKeymap(): { map: Record<string, string> | null; corrupt: boolean } {
  const p = path.join(here, '__fixtures__', 'siyuan-keymap.json');
  if (!fs.existsSync(p)) return { map: null, corrupt: false };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return raw && typeof raw === 'object' ? { map: raw, corrupt: false } : { map: null, corrupt: true };
  } catch {
    return { map: null, corrupt: true };
  }
}

// ──────────────────────────────────────────────────────────────────
console.log('Hotkey format: it must be written the way SiYuan recognizes');

{
  // SiYuan uses macOS notation: ⌥=Alt ⌘=Cmd ⌃=Ctrl ⇧=Shift, followed by a single character.
  // ★ At least **one** modifier is required -- written as `+`, not `*`.
  //   With `*` a bare letter like `O` would pass validation too, but that is not a hotkey in SiYuan,
  //   which means "you think it is bound when it is not" -- more insidious than binding the wrong key.
  const valid = /^[⌥⌘⌃⇧]+[A-Za-z0-9.\u2190-\u21FF]$/u;
  for (const [langKey, hk] of Object.entries(OUR_HOTKEYS)) {
    check(`${langKey} hotkey format is valid (${hk})`, valid.test(hk), `got ${hk}`);
  }
  check('⌥⌘O passes format validation', valid.test('⌥⌘O'));
  check('the empty string fails format validation (empty means "no key bound" and must not appear)', !valid.test(''));
  check('a bare letter fails validation (a modifier is required)', !valid.test('O'));
  check('★ the validator itself works: real hotkeys like ⌥⌘O pass', valid.test('⌘S') && valid.test('⌃⌥X'));
}

{
  console.log('  two commands must not be bound to the same key');
  const vals = Object.values(OUR_HOTKEYS);
  check('★ our two in-plugin hotkeys differ from each other', new Set(vals).size === vals.length, vals.join(' '));
}

// ──────────────────────────────────────────────────────────────────
console.log('\n★ Must avoid keys SiYuan built-ins already occupy');

{
  const { map: keymap, corrupt } = loadSiYuanKeymap();
  if (corrupt) {
    // ★ A corrupt snapshot is not a missing one: report which, so the fix (re-export vs create)
    //   is obvious instead of sending the reader to create a file that exists.
    check('the SiYuan hotkey snapshot parses (re-export it, do not create it)', false,
      'src/plugin/__fixtures__/siyuan-keymap.json exists but is not a JSON object; run scripts/snapshot-keymap.py to re-export it');
  } else if (!keymap) {
    // With no snapshot, **fail loudly** instead of passing silently --
    // a silent skip means "no protection", which is exactly what this test was added to prevent.
    check(
      'a SiYuan hotkey snapshot exists (src/plugin/__fixtures__/siyuan-keymap.json)',
      false,
      '-- without a snapshot collisions cannot be checked; run scripts/snapshot-keymap.py first to export one',
    );
  } else {
    // keymap shape: { "occupied key": "which command" }
    const occupied = new Map<string, string>();
    for (const [hk, cmd] of Object.entries(keymap)) {
      if (hk && cmd) occupied.set(hk, String(cmd));
    }
    check('the snapshot has content (it is not an empty table)', occupied.size > 0);

    for (const [langKey, hk] of Object.entries(OUR_HOTKEYS)) {
      const who = occupied.get(hk);
      check(
        `★ ${langKey}'s ${hk} is not occupied by a SiYuan built-in`,
        who === undefined,
        who ? `-- already occupied by "${who}"` : '',
      );
    }

    // Reverse check that the lookup works: a key **known to be occupied** must be found
    // (if this one passes too, the table lookup never took effect at all).
    // ★ Pinned, not conditional: the fixture is tracked, so a fixed known-occupied key must be
    //   there — skipping when absent silently drops the only proof the lookup works.
    //   (Verified live: ⌥⌘M is occupied by /editor/insert/memo — the collision this file exists for.)
    check(
      '★ the check works (⌥⌘M is found occupied)',
      occupied.get('⌥⌘M') !== undefined,
      `spot check ⌥⌘M → ${occupied.get('⌥⌘M')}`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────
console.log('\nSource and test must agree on the hotkeys (so changing one does not forget the other)');

{
  const srcPath = path.join(here, 'index.ts');
  const src = fs.readFileSync(srcPath, 'utf8');

  for (const [langKey, hk] of Object.entries(OUR_HOTKEYS)) {
    // look for the hotkey near that langKey
    const re = new RegExp(`langKey:\\s*'${langKey}'[\\s\\S]{0,200}?hotkey:\\s*'([^']+)'`);
    const m = re.exec(src);
    check(`${langKey}: a hotkey is found in the source`, m !== null);
    if (m) {
      check(`★ ${langKey} hotkey in the source matches the test (source ${m[1]})`, m[1] === hk, `the test records ${hk}`);
    }
  }
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
