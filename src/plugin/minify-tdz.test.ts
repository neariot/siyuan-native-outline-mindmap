/**
 * The build output must **not** contain a structure where "a filter callback and a same-named let share one block scope".
 *
 * Corresponding defect: a maintainer report
 *   "when creating a node with enter in outline mode it shows
 *     Cannot access 'e' before initialization"
 *
 * ── Root cause ──────────────────────────────────────────────────────
 *
 * The `walk` inside `syncStructure` used to inline:
 *
 *     const probeIds = siblingsBefore.filter((id) => id !== child);
 *     if (probeIds.length) {
 *       try {
 *         const q = async () => { ... };      // ← the minifier renames it to `e`
 *         let liveSet = await q();
 *
 * The minifier renames `q` to the single letter `e`, while the outer parameter `child`
 * referenced by the filter callback **is compressed to `e` as well**. After the name collision, the `e` inside the callback resolves to the `let` below,
 * accessed before that `let` executes → ReferenceError (TDZ).
 *
 * Measured minified output (the two are only 35 characters apart):
 *
 *     if(s.length){let t=s.filter(t=>t!==e);if(t.length)try{let e=await this...
 *
 * ── Why this test must exist ────────────────────────────────────────
 *
 * This defect is **completely invisible in the source** —— the variable names `child` / `q` / `probeIds` all differ,
 * type checking, unit tests, and code review all stay quiet. Only in the **minified output**
 * do the two names collapse into the same letter.
 *
 * And it recurs very easily: once `const q` is dropped, the minifier turns around and compresses `let liveSet`
 * to `e` as well, and the defect **reappears unchanged**. So treating the symptom (renaming the inner variable) does not help;
 * the "structure" has to be locked down —— a filter callback must not share a block scope with a let.
 *
 * This test scans `dist-plugin/index.js` directly and freezes that structural constraint.
 */
export {};

import { readFileSync, existsSync } from 'node:fs';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
};

const BUNDLE = 'dist-plugin/index.js';

console.log('=== scanning the build output ===');
{
  if (!existsSync(BUNDLE)) {
    console.log(`  ⚠️  skipping: ${BUNDLE} does not exist (run npm run build first)`);
  } else {
    const src = readFileSync(BUNDLE, 'utf8');

    // find the fragments where "a filter callback references the bare identifier e"
    const filterRe = /filter\((\w+)=>\1!==e\)/g;

    let m: RegExpExecArray | null;
    let hits: number[] = [];
    while ((m = filterRe.exec(src)) !== null) {
      const at = m.index;
      // within 120 characters after that filter, if `let e=` (or `const e=`) appears,
      // the e inside the callback resolves to that not-yet-initialized block binding → TDZ.
      const after = src.slice(at, at + 120);
      if (/\b(let|const)\s+e\s*=/.test(after)) hits.push(at);
    }

    check(
      '★ the output has no "filter callback references e + let e right after" TDZ structure',
      hits.length === 0,
    );

    if (hits.length) {
      for (const at of hits) {
        console.log(`     at ${at}: …${src.slice(Math.max(0, at - 40), at + 80)}…`);
      }
    }

    // reverse check: the extracted method really did go into the output (otherwise the check above could be a false green from "the code never made it into the build")
    check(
      '★ the output really contains pruneDestroyedSiblings (rules out the "the change never made it into the build" false green)',
      src.includes('pruneDestroyedSiblings'),
    );
  }
}

console.log('=== hand-built counterexample, proving the check can catch it ===');
{
  // replicate the shape after the minifier name collision: a filter callback references e, and a let e comes later in the same scope
  const bad =
    'if(s.length){let t=s.filter(t=>t!==e);if(t.length)try{let e=await this.q(t);}catch{}}';
  const filterRe = /filter\((\w+)=>\1!==e\)/g;
  const m = filterRe.exec(bad);
  const caught =
    !!m && /\b(let|const)\s+e\s*=/.test(bad.slice(m.index, m.index + 120));
  check('★ the check logic can identify a hand-made TDZ fragment (guards against the check itself going dead)', caught);

  // the shape after the fix: the filter callback parameter carries a prefix, so it cannot collide with a minified name
  const good =
    'let t=s.filter(sibId=>sibId!==child);let e=await this.q(t);';
  const m2 = /filter\((\w+)=>\1!==e\)/.exec(good);
  check('★ the fixed form is not falsely reported', m2 === null);
}

console.log(`\n  pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
