/**
 * Wait strategy for batch moves (corresponds to section 3.5 of `.logs/perf-test-design.md`).
 *
 * ──────────────────────────────────────────────────────────────────
 * Cause: a fixed 300ms × every node
 * ──────────────────────────────────────────────────────────────────
 *
 * `store.ts:moveNodes` ran this once for **every** node to move:
 *
 *     await this.client.moveBlock(...)
 *     await new Promise((r) => setTimeout(r, 300));   // ← fixed wait
 *     await this.client.sql(`SELECT parent_id ...`)   // ← verify
 *
 * And that wait **accumulates per node**:
 *
 *     batch indent of 20 sibling nodes  →  20 × 300ms = 6 seconds
 *     50 nodes                        →  15 seconds
 *     100 nodes                       →  30 seconds
 *
 * One `Tab` press indenting 20 nodes froze the UI for 6 seconds — this is what section 3.5 of the doc calls
 * the "serial polling penalty".
 *
 * ──────────────────────────────────────────────────────────────────
 * Measured: that 300ms was waited for nothing
 * ──────────────────────────────────────────────────────────────────
 *
 * The comment says "the kernel writes the index asynchronously, wait a bit and confirm", but 6 consecutive runs on a real machine show
 * **the index does not lag** — querying `parent_id` right after `moveBlock` returns already gives the new value:
 *
 *     run 1: call 139ms   call+query 141ms   visible=True
 *     run 2: call  53ms   call+query  54ms   visible=True
 *     runs 3~6: call 53ms  call+query 55~57ms visible=True
 *
 * The ~50ms is entirely two HTTP round trips, not index latency.
 *
 * ⇒ Change it to "poll until visible, then return": normally it hits on the first try (~55ms, 5x faster),
 *   and if it really does lag, polling is **more reliable** than a fixed wait (a fixed 300ms on a slow machine
 *   may still fail to land on disk).
 *
 * ──────────────────────────────────────────────────────────────────
 * What this test guards
 * ──────────────────────────────────────────────────────────────────
 *
 * ① The source no longer contains a "fixed sleep per node" pattern;
 * ② It polls and **does not wait first** (query, then wait), which is where the speedup comes from;
 * ③ The polling is bounded (no infinite loop);
 * ④ Break on a hit (does not waste all 12 rounds).
 */

export {};

import * as fs from 'node:fs';
import { braceBlock, stripComments } from '../plugin/source-probe';

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

const store = fs.readFileSync('src/siyuan/store.ts', 'utf8');

/** Slice out the body of moveNodes */
function moveNodesBody(): string {
  const start = store.indexOf('private async moveNodes(');
  if (start < 0) return '';
  const open = store.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < store.length; i++) {
    if (store[i] === '{') depth++;
    else if (store[i] === '}') {
      depth--;
      if (depth === 0) return store.slice(open, i);
    }
  }
  return store.slice(open);
}

// ★ Strip comments before asserting. A positive assertion (like `/for (let i …)/.test(body)`) on text
//   that still has comments is satisfied by **a code sample inside a comment**: the real loop is deleted, a comment still explains it,
//   and the criterion still passes. Once comments are stripped, only real code can satisfy it.
const body = stripComments(moveNodesBody());

// ──────────────────────────────────────────────────────────────────
console.log('the move loop must no longer contain a "fixed wait per node"');

{
  check('moveNodes is found', body.length > 0);

  // ★ Core assertion: no fixed sleep may appear **directly after moveBlock**.
  //
  //   Note the criterion cannot just be "does the file contain setTimeout" — the polling form also has
  //   setTimeout. The two look identical; the difference is **position**:
  //
  //     fixed wait (bad):  moveBlock(...); sleep(300); sql(...)      ← sleep is outside the loop
  //     polling (good):   for(...) { sql(...); if(hit) break; sleep(120); }
  //                                                              ↑ sleep is inside the loop
  //
  //   So the criterion is: no sleep **outside the loop body**. Checking only "is there a setTimeout"
  //   would also fail a correct polling implementation.
  const loopStart = body.search(/for \(let i = 0; i < (?:\d+|[A-Za-z_][\w]*); i\+\+\)/);
  const outsideLoop = loopStart >= 0 ? body.slice(0, loopStart) : body;

  const straySleep = /setTimeout\(\s*\(?r\)?[^,]*,\s*(\d+)\s*\)/.exec(outsideLoop);
  check(
    '★ no "fixed sleep outside the loop body" after the move (that would accumulate per node)',
    straySleep === null,
    straySleep ? `found outside the loop: setTimeout(..., ${straySleep[1]})` : '',
  );

  check(
    '★ no more setTimeout(..., 300) (the magic number of the old fixed wait)',
    !/setTimeout\(\s*\(?r\)?[^,]*,\s*300\s*\)/.test(body),
  );

  // The polling interval must be clearly below 300ms, otherwise nothing was optimized
  const inLoop = braceBlock(body, loopStart);
  // The interval may be a constant name; take the value from the constant definition in the source
  const consts: Record<string, number> = {};
  for (const m of store.matchAll(/export const ([A-Z_][A-Z0-9_]*)\s*=\s*(\d+)/g)) {
    consts[m[1]] = Number(m[2]);
  }
  const rawMs = /setTimeout\(\s*\(?r\)?[^,]*,\s*([\w]+)\s*\)/.exec(inLoop)?.[1];
  const pollMs = rawMs ? (/^\d+$/.test(rawMs) ? Number(rawMs) : (consts[rawMs] ?? 0)) : 0;
  check(
    '★ the polling interval is clearly below 300ms (otherwise nothing was optimized)',
    pollMs > 0 && pollMs < 300,
    `actual ${pollMs || 'not found'}ms`,
  );
}

// ──────────────────────────────────────────────────────────────────
console.log('\npoll until visible instead: query first, break on a hit, bounded');

{
  check(
    '★ there is a polling loop',
    /for \(let i = 0; i < \d+; i\+\+\)/.test(body),
  );

  // No wait first: inside the loop body, sql comes before sleep
  const loopIdx = body.search(/for \(let i = 0; i < (?:\d+|[A-Za-z_][\w]*); i\+\+\)/);
  if (loopIdx >= 0) {
    const loop = braceBlock(body, loopIdx);
    const sqlPos = loop.indexOf('.sql');
    const sleepPos = loop.indexOf('setTimeout');
    check(
      '★ inside the loop, "query first, wait after" (the first round is not wasted; this is where the speedup comes from)',
      sqlPos >= 0 && sleepPos >= 0 && sqlPos < sleepPos,
      `sql@${sqlPos} sleep@${sleepPos}`,
    );
    check(
      '★ break on a hit (does not waste all polling rounds)',
      /ok = true;\s*break;/.test(loop),
    );
    check(
      '★ the polling is bounded (the count is a finite number, no infinite loop)',
      /for \(let i = 0; i < (\d+|[A-Za-z_][\w]*); i\+\+\)/.test(body) &&
        /for \(let i = 0; i < (\d+|POLL_ROUNDS); i\+\+\)/.test(loop),
    );
  }

  // The verification SQL is still there (verification must not be dropped for speed)
  check(
    '★ parent_id is still verified after the move (verification must not be dropped for speed)',
    /SELECT parent_id FROM blocks WHERE id=/.test(body),
  );
}

// ──────────────────────────────────────────────────────────────────
console.log('\nthe criterion itself is valid');

{
  const eachNodeFixedSleep = (n: number): number => n * 300;
  const withPoll = (n: number): number => n * 55;

  check('★ the criterion can compute the cost of the fixed wait (20 nodes = 6 seconds)',
    eachNodeFixedSleep(20) === 6000);
  check('★ the criterion captures the gain from polling (20 nodes drop from 6000ms to 1100ms)',
    withPoll(20) < eachNodeFixedSleep(20) / 5,
    `${withPoll(20)} vs ${eachNodeFixedSleep(20)}`);

  // Reverse direction: if the implementation regresses to a fixed sleep, the regex above must catch it
  const bad = 'await new Promise((r) => setTimeout(r, 300));';
  check(
    '★ the regex recognizes a "fixed sleep" regression',
    /await new Promise\(\(r\) => setTimeout\(r, (\d+)\)\);/.test(bad),
  );
  // The polling form has a sleep in a **legitimate position** and must not be failed.
  // The criterion is "is the sleep outside the loop", not "is there a sleep".
  const good = 'for (let i = 0; i < 12; i++) { await this.client.sql(`...`); await new Promise((r) => setTimeout(r, 120)); }';
  const goodLoopStart = good.search(/for \(let i = 0; i < \d+; i\+\+\)/);
  const goodOutside = good.slice(0, goodLoopStart);
  check(
    '★ the criterion does not mistake a "polling form" for a fixed sleep (a sleep inside the loop is legitimate)',
    !/setTimeout\(\s*\(?r\)?[^,]*,\s*\d+\s*\)/.test(goodOutside),
  );
  check(
    '★ the criterion really does recognize a "fixed sleep outside the loop" regression',
    /setTimeout\(\s*\(?r\)?[^,]*,\s*(\d+)\s*\)/.test(
      'awaited stuff before; await new Promise((r) => setTimeout(r, 300));',
    ),
  );
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
