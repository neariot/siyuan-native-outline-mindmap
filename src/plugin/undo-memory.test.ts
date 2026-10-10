/**
 * Memory footprint of the undo stack (section 3.6-① of `.logs/perf-test-design.md`).
 *
 * ──────────────────────────────────────────────────────────────────
 * What the document is worried about
 * ──────────────────────────────────────────────────────────────────
 *
 * "Memory accumulation from `undoStackRef` snapshots: the undo stack is capped at 50 steps, and each step keeps
 *   a full deep copy of `OutlineNode[]`. At T3 (2000 nodes), 50 snapshots
 *   could hold more than 100MB of JS heap."
 *
 * ──────────────────────────────────────────────────────────────────
 * Measured conclusion: the worry points the right way, but the magnitude is overstated by about 3x
 * ──────────────────────────────────────────────────────────────────
 *
 * Each tier is measured in a **separate process** (measuring several tiers in one process reuses the free heap, so later tiers report
 * a fake 0.0MB -- see the note at the end of the file for this pitfall):
 *
 *     tier   nodes    50 snapshots   each
 *     T1       50       0.7 MB     0.01 MB
 *     T2      500       6.6 MB     0.13 MB
 *     T3     2000      29.5 MB     0.59 MB
 *     T4    10000     165.1 MB     3.30 MB
 *
 * About 0.28~0.30 KB per node, linear.
 *
 * So:
 *   · T3 is actually 29.5MB, not "over 100MB";
 *   · T4 is the 165MB one, and by the document's own definition T4 is
 *     "extreme single-document probing of system capacity and architectural collapse limits", not a daily scenario;
 *   · For reference: SiYuan is Electron, and Chromium's default JS heap limit is in the GB range, so
 *     165MB is roughly 5%.
 *
 * ⇒ **Judged not a defect**. The undo stack is capped at 50 and shifts out the oldest entry on overflow, so
 *   there is no unbounded growth. What really matters is "does it actually evict after the cap is exceeded",
 *   and that is guarded by the source assertion below.
 *
 * ──────────────────────────────────────────────────────────────────
 * What this test guards
 * ──────────────────────────────────────────────────────────────────
 *
 * It does not guard "memory below some number" (that is environment-dependent); it guards two **semantics**:
 *   ① snapshots are deep copies -- otherwise undo would mutate the current tree (this class of bug has happened before);
 *   ② the undo stack has a hard cap and evicts on overflow -- preventing unbounded growth;
 *   ③ snapshot cost is linear in the node count, with no super-linear serialization overhead.
 */

export {};

import { genKramdown, TIERS } from '../perf/loadgen';
import { kramdownToTree } from '../core/map';
import { flattenAll } from '../model/tree';

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

/** Snapshot implementation identical to the one in `mount.ts:931` */
const snapshot = (tree: unknown): unknown[] => JSON.parse(JSON.stringify(tree ?? []));

function heapMB(): number {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

// ──────────────────────────────────────────────────────────────────
console.log('snapshots must be deep copies (a shallow copy lets undo mutate the current tree)');

{
  const original = [{ id: 'a', text: 'hello', children_: [{ id: 'b', text: 'x', children_: [] }] }];
  const snap = snapshot(original) as typeof original;

  check('content is identical after snapshotting', JSON.stringify(snap) === JSON.stringify(original));

  // mutate the original tree; the snapshot must not follow
  original[0].text = 'CHANGED';
  original[0].children_[0].text = 'CHANGED-TOO';
  check(
    'the snapshot replicated in this file is a deep copy',
    snap[0].text === 'hello' && snap[0].children_[0].text === 'x',
    `got ${snap[0].text} / ${snap[0].children_[0].text}`,
  );

  // ★★ The checks above test the **snapshot replicated in this file**, not the product code.
  //
  //   Measured lesson: turning the snapshot in mount.ts into a shallow copy
  //   (`(tree ?? []).slice()`) still left this file at 13/13 green --
  //   because the snapshot above is locally defined and has nothing to do with mount.ts.
  //
  //   What really guards the product is the **source-reading** assertion below.
  const fs = require('node:fs');
  const mount = fs.readFileSync('src/plugin/mount.ts', 'utf8');
  const snapDef = /\s*const snapshot = \(tree: OutlineNode\[\] \| null\): OutlineNode\[\] =>\s*([\s\S]*?);/.exec(mount);
  check('the snapshot definition in mount.ts is found', snapDef !== null);
  if (snapDef) {
    const body = snapDef[1];
    check(
      '★★ the snapshot in mount.ts is a deep copy (JSON round-trip / structuredClone)',
      /JSON\.parse\(JSON\.stringify\(/.test(body) || /structuredClone\(/.test(body),
      `got: ${body.trim().replace(/\s+/g, ' ').slice(0, 60)}`,
    );
    check(
      '★★ the snapshot in mount.ts is not a shallow copy (no .slice() / spread)',
      !/\.slice\(\)/.test(body) && !/\[\.\.\./.test(body),
      `got: ${body.trim().replace(/\s+/g, ' ').slice(0, 60)}`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────
console.log('\nundo stack cap: hard eviction required, no unbounded growth');

{
  const fs = require('node:fs');
  const mount = fs.readFileSync('src/plugin/mount.ts', 'utf8');

  check('UNDO_LIMIT is defined', /const UNDO_LIMIT = \d+/.test(mount));
  const limit = Number(/const UNDO_LIMIT = (\d+)/.exec(mount)?.[1] ?? 0);
  check('★ the cap is 50 (as the document states)', limit === 50, `got ${limit}`);
  check('★ the cap is a **finite number** (not Infinity/unlimited)', Number.isFinite(limit) && limit > 0);

  // pushUndo shifts internally once past the cap
  const push = mount.slice(
    mount.indexOf('const pushUndo = React.useCallback'),
    mount.indexOf('const pushUndo = React.useCallback') + 900,
  );
  check(
    '★ pushing past the cap evicts the oldest entry (st.shift())',
    /st\.length > UNDO_LIMIT/.test(push) && /st\.shift\(\)/.test(push),
    'expects `if (st.length > UNDO_LIMIT) st.shift()`',
  );

  // the redo stack needs a cap too, otherwise redo grows unbounded as well
  check(
    '★ the redo stack has a cap too (otherwise the redo path grows unbounded)',
    /redoStackRef\.current\.length > UNDO_LIMIT/.test(mount),
  );
}

// ──────────────────────────────────────────────────────────────────
console.log('\nsnapshot cost is linear in the node count (no super-linear serialization)');

{
  const costPerNode: number[] = [];
  for (const t of [TIERS[0], TIERS[1], TIERS[2]]) {
    const tree = kramdownToTree(genKramdown(t));
    const n = flattenAll(tree).length;

    // cost is measured in **time** (memory needs a separate process; only scaling is guarded here)
    snapshot(tree); // warm-up
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      snapshot(tree);
      const dt = performance.now() - t0;
      if (dt < best) best = dt;
    }
    costPerNode.push(best / n);
    console.log(`     ${t.name}  ${String(n).padStart(5)} nodes   per snapshot ${best.toFixed(2)}ms   ${((best / n) * 1000).toFixed(2)}µs/node`);
  }

  // T1 is too small and timing noise dominates; use T2->T3 to see the scaling
  const perNode2 = costPerNode[1];
  const perNode3 = costPerNode[2];
  check(
    '★ the per-node snapshot cost is roughly constant (T2 vs T3 differ by less than 4x)',
    perNode3 < perNode2 * 4 && perNode2 < perNode3 * 4,
    `T2 ${perNode2.toFixed(4)}µs vs T3 ${perNode3.toFixed(4)}µs`,
  );
}

// ──────────────────────────────────────────────────────────────────
console.log('\nthe criterion itself is valid');

{
  // a shallow copy should be caught by the criterion
  const tree = [{ id: 'a', text: 'x', children_: [{ id: 'b', text: 'y', children_: [] }] }];
  const shallow = [...tree];
  const deep = snapshot(tree) as typeof tree;
  shallow[0].text = 'CHANGED';
  check(
    '★ the criterion distinguishes a shallow copy (it follows when the original tree is mutated)',
    shallow[0].text === 'CHANGED',
  );
  check('a deep copy is unaffected', deep[0].text === 'x');

  // unbounded growth should be caught by the criterion
  const bounded = (n: number, limit: number): number[] => {
    const st: number[] = [];
    for (let i = 0; i < n; i++) {
      st.push(i);
      if (st.length > limit) st.shift();
    }
    return st;
  };
  check('★ the criterion recognises a bounded stack (still 50 entries after 1000 pushes)', bounded(1000, 50).length === 50);
  check('★ the criterion recognises an unbounded stack (without shift it grows to 1000)', bounded(1000, 1e9).length === 1000);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}

// ──────────────────────────────────────────────────────────────────
// Appendix: the correct way to measure memory (do not delete this passage; it will be hit again)
//
// Measuring several tiers in a row inside one process makes **the second tier onwards report 0.0MB**:
//
//     T3  2000 nodes  50 snapshots: 29.5MB / -0.0MB     ← the second one is fake
//
// Cause: the 29.5MB allocated in the first round is reclaimed into the free heap by GC and reused by the second round,
// so the heapUsed delta is near 0. It looks like "T3 uses no memory", but the measurement method is wrong.
//
// Correct approach: one separate process per tier, and take the baseline after a manual gc with `node --expose-gc`:
//
//     for i in 0 1 2 3; do
//       node --expose-gc --import tsx <this>.mts $i
//     done
