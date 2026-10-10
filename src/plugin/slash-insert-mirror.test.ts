/**
 * The slash menu must "insert a mirror block", not "open a tab" (corresponds to agy's UI-TC-24).
 *
 * ──────────────────────────────────────────────────────────────────
 * Origin
 * ──────────────────────────────────────────────────────────────────
 *
 * The slash menu entry's comment says "insert a mind map mirror block at the cursor",
 * `docs/GETTING-STARTED.md` also promises users that it "inserts a mirror block into the body",
 * and the command label is "Insert mind map" -- all three say **write into the body**.
 *
 * But the code calls `openMindmapTab()`: it opens a new tab and does not touch the body at all.
 * Measured before and after triggering the callback:
 *
 *     tabs              11 → 12        ← a new page was opened
 *     body kramdown length 762 → 762   ← nothing was inserted
 *
 * On mobile this is a **missing feature**, not an experience problem: phones have no command palette and no `⌥⌘I`,
 * the slash menu is the only way in. If it opens a tab instead, users can no longer embed a mind map into the body.
 *
 * ──────────────────────────────────────────────────────────────────
 * Criterion
 * ──────────────────────────────────────────────────────────────────
 *
 * Read `src/plugin/index.ts` and statically assert on the slash item's callback:
 * it must take the "insert a mirror block" path and **must not** call `openMindmapTab`.
 *
 * Why a static assertion instead of running it and clicking: the slash menu goes through SiYuan's IME/slash popup,
 * which is expensive and brittle to replicate offline; and the error here is "the wrong function was called",
 * a fact that can be settled in the source itself, so reading the code is more stable than simulating interaction.
 * Real-device behaviour is covered by a separate verification (see the handover notes); the two complement each other.
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
const srcPath = path.join(here, 'index.ts');
const src = fs.readFileSync(srcPath, 'utf8');

/** Cut out the `this.protyleSlash = [ ... ];` section */
function slashBlock(): string {
  const start = src.indexOf('this.protyleSlash');
  if (start < 0) return '';
  // match brackets forward from the start to reach the end of the array
  let i = src.indexOf('[', start);
  if (i < 0) return '';
  let depth = 0;
  const from = i;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return src.slice(from);
}

const block = slashBlock();

// ──────────────────────────────────────────────────────────────────
console.log('the slash item exists and there is exactly one (more would duplicate entries in the / menu)');

{
  check('this.protyleSlash is found', block.length > 0);
  const ids = [...block.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
  check('the slash item has an id', ids.length >= 1, `actual ${JSON.stringify(ids)}`);
  check('★ the slash item has no duplicate id', new Set(ids).size === ids.length, ids.join(', '));
  check('the slash item filter words contain mindmap keyword (Chinese users must be able to find it)',
    /filter:\s*\[[^\]]*(?:'导图'|'\\u5bfc\\u56fe')/.test(block));
}

// ──────────────────────────────────────────────────────────────────
console.log('\n★ the callback of the slash item must take the "insert a mirror block" path');

{
  const cb = /callback:\s*\(\)\s*=>\s*\{([\s\S]*?)\}/.exec(block);
  check('the callback body of the slash item is extracted', cb !== null);
  const body = cb ? cb[1] : '';

  check('★ must not call openMindmapTab (that opens a tab, it does not insert into the body)',
    !/openMindmapTab/.test(body),
    body.trim().replace(/\s+/g, ' ').slice(0, 80));

  check('★ must call insertMirrorIntoActiveDoc (the only entry point that inserts a mirror block)',
    /insertMirrorIntoActiveDoc/.test(body),
    body.trim().replace(/\s+/g, ' ').slice(0, 80));
}

// ──────────────────────────────────────────────────────────────────
console.log('\nthe two entry points share one implementation (so it cannot drift again)');

{
  // the insertMirror of the command palette must go through the same method too
  const cmd = /langKey:\s*'insertMirror'[\s\S]{0,300}?callback:\s*async\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\}/.exec(src);
  check('the callback of the insertMirror command is extracted', cmd !== null);
  if (cmd) {
    check('★ the insertMirror of the command palette also calls insertMirrorIntoActiveDoc',
      /insertMirrorIntoActiveDoc/.test(cmd[1]),
      cmd[1].trim().replace(/\s+/g, ' ').slice(0, 80));
  }

  // The shared method must really exist and really call appendMirrorBlock.
  // ★ Do not use a non-greedy bracket match like `\{([\s\S]*?)\n\s*\}` -- the method body has nested
  //   (try/catch) constructs, which would stop before the first inner `}` and make the assertion fail.
  //   Here we pair the braces ourselves to reach the real end of the method.
  const def = ((): string | null => {
    const m = /async\s+insertMirrorIntoActiveDoc\s*\([^)]*\)\s*:\s*Promise<void>\s*\{/.exec(src);
    if (!m) return null;
    const from = m.index + m[0].length;
    let depth = 1;
    for (let i = from; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) return src.slice(from, i);
      }
    }
    return src.slice(from);
  })();
  check('the insertMirrorIntoActiveDoc method is defined', def !== null);
  if (def) {
    check('★ it really calls appendMirrorBlock (otherwise it was only renamed)',
      /appendMirrorBlock/.test(def),
      def.length > 0 ? '' : '(the method body parsed as empty)');
    check('it warns when there is no active document (no silent failure)',
      /showMessage/.test(def));
  }
}

// ──────────────────────────────────────────────────────────────────
console.log('\nthe criterion itself is valid (proving these assertions are not always true)');

{
  // Take a fake callback that should fail and confirm the check logic catches it
  const looksWrong = (body: string): boolean => /openMindmapTab/.test(body);
  const looksRight = (body: string): boolean => /insertMirrorIntoActiveDoc/.test(body);
  check('★ the check logic recognises the "calls openMindmapTab" mistake',
    looksWrong('const id = getActiveDocId(); void plugin.openMindmapTab(id);'));
  check('★ the check logic accepts the correct form',
    looksRight('void plugin.insertMirrorIntoActiveDoc();'));
  check('the check logic does not mistake the correct form for a failure',
    !looksWrong('void plugin.insertMirrorIntoActiveDoc();'));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
