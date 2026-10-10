/**
 * Behaviour verification for overlapping EchoGuard write-backs.
 *
 * Background: `applying` is a **boolean** rather than a counter. When two write-back windows overlap,
 * whichever finishes first sets applying back to false, so the one still writing is misjudged as "not an echo".
 */
import { EchoGuard, withEchoGuard } from './sync';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
};

// ── single window: basic semantics ──
{
  const g = new EchoGuard(1500);
  check('initial state: not an echo', !g.isEcho('b1'));
  g.beginApply();
  check('after beginApply: is an echo', g.isEcho('b1'));
  g.endApply(['b1']);
  check('after endApply, inside the window: is an echo', g.isEcho('b1'));
}

// ── window expiry ──
{
  const g = new EchoGuard(50);
  g.beginApply();
  g.endApply(['b1']);
  const t0 = Date.now();
  while (Date.now() - t0 < 80) { /* busy wait */ }
  check('after the window expires: not an echo', !g.isEcho('b1'));
}

// ── ★ overlapping write-backs: this is the key scenario ──
{
  const g = new EchoGuard(1500);
  // write-back A starts, write-back B starts (the user clicks twice, two write-backs in flight)
  g.beginApply();   // A
  g.beginApply();   // B
  check('while both windows are open: is an echo', g.isEcho('anyBlock'));

  g.endApply(['blockA']);   // A finishes first
  // ★ at this moment B is still writing back, yet applying has been set back to false
  const stillEcho = g.isEcho('blockB');
  console.log(`     [diagnostic] after A finishes, while B is still writing back, isEcho(blockB) = ${stillEcho}`);
  console.log(`     [note] expected true (B has not finished writing). A false here proves the boolean defect.`);

  // even if blockB itself was not recorded in recent, it should still return true during a write-back
  check('★ overlapping write-backs: after A finishes, B must still be judged an echo', stillEcho);
}

// ── three-way overlap ──
{
  const g = new EchoGuard(1500);
  g.beginApply(); g.beginApply(); g.beginApply();
  g.endApply(['a']); g.endApply(['b']);
  check('three overlapping layers, only two ended: still an echo', g.isEcho('x'));
  g.endApply(['c']);
  check('all three layers ended: the blocks written inside the window are echoes', g.isEcho('a') && g.isEcho('c'));
  check('all three layers ended: a block never written is not an echo', !g.isEcho('x'));
}

// ── a surplus endApply must not drive the count negative ──
{
  const g = new EchoGuard(1500);
  g.endApply([]);
  g.endApply([]);
  g.beginApply();
  g.endApply([]);
  check('after a surplus endApply a new window can still close normally', !g.isEcho('zzz'));
}

// ── during beginApply a block that was never written still counts as an echo ──
{
  const g = new EchoGuard(1500);
  g.beginApply();
  check('a block never recorded is also an echo during a write-back', g.isEcho('never-seen'));
  g.endApply(['never-seen']);
}


void (async () => {

// The write path opens the echo window, awaits the write, and closes the window. Called by hand, a
  // **rejected** write skipped the close, so applyingCount stayed above zero and isApplying() stayed true
  // for the rest of the session: every later event was judged our own echo, external edits stopped being
  // applied, and local ones were reported as conflicts. withEchoGuard owns that balance.
  check('a failed write-back gives the window back', await (async () => {
    const g = new EchoGuard();
    let threw = false;
    try {
      await withEchoGuard(g, () => ['b1'], () => new Map([['b1', 'written']]), async () => {
        throw new Error('the kernel refused the write');
      });
    } catch {
      threw = true;
    }
    return threw && !g.isApplying() && !g.isEcho('b1');
  })());

  check('a successful write-back records what was written', await (async () => {
    const g = new EchoGuard();
    const result = await withEchoGuard(g, () => ['b1'], () => new Map([['b1', 'written']]),
      async () => 'done');
    return result === 'done' && !g.isApplying() && g.isEcho('b1') && g.isOwnValue('b1', 'written');
  })());

  check('the ids are read after the write, not before', await (async () => {
    const g = new EchoGuard();
    const ids: string[] = [];
    await withEchoGuard(g, () => ids, () => new Map(), async () => { ids.push('created-during-write'); });
    return g.isEcho('created-during-write');
  })());

  check('overlapping write-backs keep the window open until the last one finishes', await (async () => {
    const g = new EchoGuard();
    let release: () => void = () => {};
    const slow = withEchoGuard(g, () => [], () => new Map(), () => new Promise<void>((r) => { release = r; }));
    await withEchoGuard(g, () => [], () => new Map(), async () => {});
    const openWhileSlowIsRunning = g.isApplying();
    release();
    await slow;
    return openWhileSlowIsRunning && !g.isApplying();
  })());

  check('abortApply cannot drive the count negative', (() => {
    const g = new EchoGuard();
    g.abortApply();
    g.beginApply();
    g.endApply([]);
    g.endApply([]);
    return !g.isApplying();
  })());

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
})();
