/**
 * Behaviour verification for overlapping EchoGuard write-backs.
 *
 * Background: `applying` is a **boolean** rather than a counter. When two write-back windows overlap,
 * whichever finishes first sets applying back to false, so the one still writing is misjudged as "not an echo".
 */
import { EchoGuard } from './sync';

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

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
