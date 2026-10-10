/**
 * The shrink boundary of the `everSeen` set (corresponds to section 3.6-② of `.logs/perf-test-design.md`).
 *
 * ──────────────────────────────────────────────────────────────────
 * What `everSeen` is for
 * ──────────────────────────────────────────────────────────────────
 *
 * It is the **accidental-deletion safety gate** of `syncDeletions`:
 *
 *     A block ID may only be deleted from SiYuan if it has appeared in `everSeen`
 *
 * Without this gate, any block that is "not in the map but still in the UI" would be misjudged as
 * "deleted by the user" and really deleted. So it **must be conservative and only ever grow**.
 *
 * But it also grows without bound with the "block IDs that have been used" — after a long session (an hour of heavy use,
 * switching back and forth between 20 documents) it may accumulate hundreds of thousands of dead IDs.
 *
 * Hence `EVERSEEN_SOFT_CAP = 4000` and `shrinkEverSeen()`.
 *
 * ──────────────────────────────────────────────────────────────────
 * The shrinking dilemma (this is what this section really guards)
 * ──────────────────────────────────────────────────────────────────
 *
 *   Shrink too aggressively → IDs that are still needed get cleared → blocks that should be deleted cannot be (leftovers)
 *   Never shrink → unbounded memory growth
 *
 * `shrinkEverSeen` handles this in **two stages**:
 *   ① conservative filter: keep only "current live blocks + blocks in the map", drop the rest;
 *   ② if after filtering it is **still** over the cap (for example a single document really has more than 4000 blocks),
 *      reset the whole thing to the "current live block set" — better forgetful than unbounded.
 *
 * This file guards:
 *   · no shrinking below the cap (avoids a full traversal on every write-back)
 *   · shrink above the cap, and **not a single live block may be lost** (losing one means its block can never be deleted)
 *   · with a mix of live and dead blocks, only the dead ones are dropped
 *   · in the extreme case (the live blocks alone exceed the cap) the reset branch runs and still converges
 */

import { fnBody } from '../plugin/source-probe';

export {};

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

const SOFT_CAP = 4000;

/**
 * A replica of `shrinkEverSeen` from `store.ts:600`.
 *
 * Compared against the source line by line:
 *     if (this.everSeen.size <= EVERSEEN_SOFT_CAP) return;
 *     const keep = new Set(lastAliveBlockIds);
 *     for (bid of lastByBlock.keys()) keep.add(bid);
 *     for (bid of lastListItems.values()) keep.add(bid);
 *     const next = new Set(); for (k of everSeen) if (keep.has(k)) next.add(k);
 *     everSeen = next.size > CAP ? new Set(lastAliveBlockIds) : next;
 */
function shrinkEverSeen(
  everSeen: Set<string>,
  lastAliveBlockIds: Set<string>,
  lastByBlock: Map<string, string>,
  lastListItems: Map<string, string>,
): Set<string> {
  if (everSeen.size <= SOFT_CAP) return everSeen;
  const keep = new Set<string>(lastAliveBlockIds);
  for (const bid of lastByBlock.keys()) keep.add(bid);
  for (const bid of lastListItems.values()) keep.add(bid);
  const next = new Set<string>();
  for (const k of everSeen) if (keep.has(k)) next.add(k);
  return next.size > SOFT_CAP ? new Set<string>(lastAliveBlockIds) : next;
}

/** Build n block IDs */
const ids = (n: number, prefix = 'b'): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);

// ──────────────────────────────────────────────────────────────────
console.log('below the cap nothing happens (avoids a full traversal on every write-back)');

{
  const ever = new Set(ids(100));
  const alive = new Set(ids(50));
  const after = shrinkEverSeen(ever, alive, new Map(), new Map());
  check('★ below the cap it returns the input unchanged (the same object)', after === ever);
  check('★ below the cap no entry is dropped', after.size === 100);
}

// ──────────────────────────────────────────────────────────────────
console.log('\nshrink above the cap, but not a single live block may be lost');

{
  const alive = new Set(ids(100, 'alive'));
  const dead = new Set(ids(9000, 'dead'));
  const ever = new Set([...alive, ...dead]);
  check('precondition: a set over the cap was built', ever.size > SOFT_CAP, `${ever.size}`);

  const after = shrinkEverSeen(ever, alive, new Map(), new Map());
  console.log(`     before shrink ${ever.size} → after shrink ${after.size}`);

  check('★ shrinking really did reduce the set', after.size < ever.size, `${ever.size} → ${after.size}`);
  check('★ the result does not exceed the soft cap', after.size <= SOFT_CAP, `actual ${after.size}`);

  // ★★ most important: every live block must be kept
  let missing = 0;
  for (const k of alive) if (!after.has(k)) missing++;
  check(
    '★★ not a single live block was lost (losing one means "blocks that should be deleted cannot be")',
    missing === 0,
    `lost ${missing} of them`,
  );
}

// ──────────────────────────────────────────────────────────────────
console.log('\nlive/dead mix: drop only dead blocks, keep live ones');

{
  const alive = new Set(ids(200, 'A'));
  const dead = new Set(ids(5000, 'D'));
  const mapped = new Set(ids(30, 'M'));
  const ever = new Set([...alive, ...dead, ...mapped]);

  const lastByBlock = new Map<string, string>();
  for (const k of mapped) lastByBlock.set(k, 'node-' + k);

  const after = shrinkEverSeen(ever, alive, lastByBlock, new Map());
  console.log(`     ${ever.size} → ${after.size} (live ${alive.size} + mapped ${mapped.size})`);

  check('all live blocks are present', [...alive].every((k) => after.has(k)));
  check('★ blocks in the map are kept too (they may still correspond to real blocks)', [...mapped].every((k) => after.has(k)));
  check('★ dead blocks are cleared', !after.has('D0') && !after.has('D4999'));
  check('the resulting size ≈ live + mapped, not the original', after.size <= alive.size + mapped.size);
}

// ──────────────────────────────────────────────────────────────────
console.log('\nextreme: the live blocks alone exceed the cap → the reset branch runs and still converges');

{
  // When a single document really has more than 4000 blocks, the conservative filter cannot help — it must be able to degrade
  const alive = new Set(ids(6000, 'huge'));
  const dead = new Set(ids(6000, 'dead'));
  const ever = new Set([...alive, ...dead]);

  const after = shrinkEverSeen(ever, alive, new Map(), new Map());
  console.log(`     ${ever.size} → ${after.size}`);

  check(
    '★ when the live blocks exceed the cap it resets entirely to the live block set (better forgetful than unbounded)',
    after.size === alive.size,
    `actual ${after.size}, expected ${alive.size}`,
  );
  check('★ after the reset no dead block is left', !after.has('dead0'));
  check(
    '★ after the reset the set size is bounded (equal to the live block count, it does not keep growing)',
    after.size <= 6000,
    `actual ${after.size}`,
  );
}

// ──────────────────────────────────────────────────────────────────
console.log('\nrepeated shrinking does not bounce back (idempotent/convergent)');

{
  const alive = new Set(ids(100, 'alive'));
  let ever = new Set([...alive, ...ids(9000, 'dead')]);

  const sizes: number[] = [ever.size];
  for (let round = 0; round < 5; round++) {
    ever = shrinkEverSeen(ever, alive, new Map(), new Map());
    sizes.push(ever.size);
  }
  console.log(`     5 consecutive rounds: ${sizes.join(' → ')}`);

  check('★ it is stable after the first shrink (later rounds do not change)', sizes[1] === sizes[2] && sizes[2] === sizes[3]);
  check('★ repeated shrinking does not wear the live blocks away', [...alive].every((k) => ever.has(k)));
}

// ──────────────────────────────────────────────────────────────────
console.log('\n★ aligned with the real source (keeps the replica in this file from drifting)');

{
  // Behaviour assertions on the replica model **are not product evidence**: delete every criterion from mount.ts
  // and this replica test still passes, because it tests its own replica.
  // Here the source is read directly, pinning the key structures and constants.
  const fs = require('node:fs');
  const store = fs.readFileSync('src/siyuan/store.ts', 'utf8');

  // ① the soft cap constant
  const cap = Number(/EVERSEEN_SOFT_CAP\s*=\s*(\d+)/.exec(store)?.[1] ?? 0);
  check('★ the soft cap matches the source (4000)', cap === SOFT_CAP, `the source has ${cap}, this file uses ${SOFT_CAP}`);

  // ② extract the body of shrinkEverSeen
  // ★ Slice the body by structure, not with a guessed window like `slice(start, start + 1200)`:
  //   adding a comment can push the code under assertion out of the window (false red), and removing a comment moves the window
  //   over code outside the function (silent false green).
  const start = store.indexOf('private shrinkEverSeen()');
  check('shrinkEverSeen is found', start > 0);
  const body = fnBody(store, 'private shrinkEverSeen()');
  check('the body of shrinkEverSeen is sliced out (fails if it cannot be sliced)', body.length > 0);

  check(
    '★ it returns early below the cap (no full traversal)',
    /if \(this\.everSeen\.size <= SiYuanStore\.EVERSEEN_SOFT_CAP\) return;/.test(body),
  );
  // ★ `lastAliveBlockIds` appears **twice** in this function:
  //     ① `const keep = new Set<string>(this.lastAliveBlockIds);`   ← conservative filter
  //     ② `? new Set<string>(this.lastAliveBlockIds)`               ← reset branch
  //   If the assertion only says `new Set<string>(this.lastAliveBlockIds)`, what it matches is
  //   occurrence ② — so deleting occurrence ① (live blocks are no longer kept, shrinking turns aggressive and live blocks get wiped)
  //   still leaves the test fully green. The assertion must be pinned to the construction of the `keep` variable.
  check(
    '★ the keep set contains "current live blocks" (pinned to the construction of keep, not the reset branch)',
    /const keep = new Set<string>\(this\.lastAliveBlockIds\)/.test(body),
    'expected `const keep = new Set<string>(this.lastAliveBlockIds)`',
  );
  check(
    '★ the keep set contains "blocks in the map" (lastByBlock)',
    /this\.lastByBlock\.keys\(\)/.test(body),
  );
  check(
    '★ the keep set contains "listItem blocks" (lastListItems.values())',
    /this\.lastListItems\.values\(\)/.test(body),
  );
  check(
    '★ when it is still over the cap after the conservative filter, it resets entirely to the live block set (two-stage shrinking)',
    /next\.size > SiYuanStore\.EVERSEEN_SOFT_CAP/.test(body) &&
      /new Set<string>\(this\.lastAliveBlockIds\)/.test(body),
  );

  // ③ shrinking really is called (writing it without calling it is the same as not having it)
  const calls = (store.match(/this\.shrinkEverSeen\(\)/g) ?? []).length;
  check('★ shrinkEverSeen really is called on the write-back path', calls >= 1, `call sites: ${calls}`);
}

console.log('\nthe criteria themselves are valid');

{
  // A wrong "never shrinks" implementation: it must be caught by the "really did reduce" criterion
  const noShrink = (ever: Set<string>): Set<string> => ever;
  const ever = new Set([...ids(100, 'a'), ...ids(9000, 'd')]);
  const r = noShrink(ever);
  check('★ the criterion recognizes a "never shrinks at all" implementation', !(r.size < ever.size), 'noShrink did not reduce the set');

  // An aggressive "always reset" implementation: it loses the mapped blocks beyond the live ones
  const aggressive = (): Set<string> => new Set(ids(10, 'only-alive'));
  const agg = aggressive();
  const alive = new Set(ids(100, 'alive'));
  check('★ the criterion recognizes an "over-aggressive" implementation (live blocks lost)', [...alive].some((k) => !agg.has(k)));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
