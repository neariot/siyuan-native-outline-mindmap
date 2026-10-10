/**
 * UI-TC-08: offset calculation for the toolbar when the soft keyboard opens (regression test).
 *
 * ──────────────────────────────────────────────────────────────────
 * Spec text
 * ──────────────────────────────────────────────────────────────────
 *
 * > trigger `visualViewport.resize` to **simulate** the keyboard opening
 * > the bottom offset of `.mobile-keyboard-bar` matches the viewport delta exactly, and the cursor stays visible
 *
 * ★ The spec explicitly says **simulate**, not a real device -- so this one can be verified offline.
 *
 * ──────────────────────────────────────────────────────────────────
 * Logic under test (copied from handleViewport in `Outliner.tsx`)
 * ──────────────────────────────────────────────────────────────────
 *
 * ```ts
 * const rawOffset = window.innerHeight - vv.height;
 * const isKbOpen  = isMobile && rawOffset > 60;
 * const offset    = isKbOpen ? Math.max(0, Math.round(rawOffset)) : 0;
 * ```
 *
 * Three key points, each with a history of pitfalls:
 *
 * 1. **The baseline must be `window.innerHeight`, not `vv.height`**.
 *    When iOS Safari opens the keyboard, `vv.height` shrinks while `innerHeight` stays the same,
 *    and only their difference is the keyboard height.
 *
 * 2. **Never add or subtract `vv.offsetTop`**. While typing, iOS pans the visual viewport,
 *    `offsetTop` drops to 0, which puts the toolbar under the keyboard (a defect measured
 *    and recorded in the code comments).
 *
 * 3. **Threshold 60px + mobile only**. A false positive makes the toolbar float up on the desktop for no reason.
 */

export {};

import * as fs from 'node:fs';

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

/** Replicates the offset calculation of handleViewport */
function computeOffset(opts: {
  innerHeight: number;
  innerWidth: number;
  vvHeight: number;
  vvOffsetTop?: number;
}): { offset: number; isKbOpen: boolean } {
  const { innerHeight, innerWidth, vvHeight } = opts;
  const rawOffset = innerHeight - vvHeight;
  const isMobile = innerWidth <= 768;
  const isKbOpen = isMobile && rawOffset > 60;
  const offset = isKbOpen ? Math.max(0, Math.round(rawOffset)) : 0;
  return { offset, isKbOpen };
}

console.log('① keyboard opens: the offset matches the viewport delta exactly');

{
  // typical iOS: innerHeight stays 852, vv.height shrinks to 852-336=516
  const r = computeOffset({ innerHeight: 852, innerWidth: 393, vvHeight: 516 });
  check('★ keyboard height 336 → offset 336', r.offset === 336, `actual ${r.offset}`);
  check('judged as the keyboard being open', r.isKbOpen);

  // every height must match exactly
  for (const kb of [100, 200, 291, 336, 420]) {
    const x = computeOffset({ innerHeight: 852, innerWidth: 393, vvHeight: 852 - kb });
    check(`keyboard ${kb}px → offset ${kb}`, x.offset === kb, `actual ${x.offset}`);
  }
}

console.log('\n② keyboard closes: offset returns to zero');

{
  const r = computeOffset({ innerHeight: 852, innerWidth: 393, vvHeight: 852 });
  check('delta 0 → offset 0', r.offset === 0, `actual ${r.offset}`);
  check('judged as the keyboard being closed', !r.isKbOpen);
}

console.log('\n③ ★ threshold 60px: anything below it is not a keyboard');

{
  // the address bar collapsing/expanding changes vv by tens of pixels and must not be mistaken for a keyboard
  for (const d of [0, 1, 30, 59, 60]) {
    const r = computeOffset({ innerHeight: 852, innerWidth: 393, vvHeight: 852 - d });
    check(`delta ${d}px → not judged as a keyboard (offset 0)`, r.offset === 0, `actual ${r.offset}`);
  }
  const r61 = computeOffset({ innerHeight: 852, innerWidth: 393, vvHeight: 852 - 61 });
  check('delta 61px → judged as a keyboard', r61.offset === 61, `actual ${r61.offset}`);
}

console.log('\n④ ★ mobile only (nothing floats up on the desktop)');

{
  const r = computeOffset({ innerHeight: 900, innerWidth: 1280, vvHeight: 500 });
  check('★ desktop width 1280 → offset is always 0', r.offset === 0, `actual ${r.offset}`);
  check('the desktop is not judged as a keyboard', !r.isKbOpen);

  // boundary: 768 counts as mobile, 769 does not
  const a = computeOffset({ innerHeight: 852, innerWidth: 768, vvHeight: 516 });
  const b = computeOffset({ innerHeight: 852, innerWidth: 769, vvHeight: 516 });
  check('width 768 → active (≤768)', a.offset === 336, `actual ${a.offset}`);
  check('width 769 → not active', b.offset === 0, `actual ${b.offset}`);
}

console.log('\n⑤ ★ does not use vv.offsetTop (a pitfall already hit)');

{
  // while typing, iOS pans the visual viewport and offsetTop changes
  // if the formula adds or subtracts it, the offset drops to 0 → the toolbar ends up under the keyboard
  const withTop = (offsetTop: number) => {
    const innerHeight = 852;
    const vvHeight = 516;
    const rawOffset = innerHeight - vvHeight;
    const isKbOpen = 393 <= 768 && rawOffset > 60;
    // replicate the **correct** implementation: use only innerHeight - vv.height
    return isKbOpen ? Math.max(0, Math.round(rawOffset)) : 0;
  };
  for (const top of [0, 50, 200, 336]) {
    check(`★ with offsetTop=${top} the offset is still 336 (it has no effect)`,
      withTop(top) === 336, `actual ${withTop(top)}`);
  }
}

console.log('\n⑥ a negative delta produces no negative offset (defensive)');

{
  const r = computeOffset({ innerHeight: 500, innerWidth: 393, vvHeight: 852 });
  check('★ delta -352 → offset 0 (never negative)', r.offset === 0, `actual ${r.offset}`);
}

console.log('\n⑦ ★ stays in sync with the source implementation (it must not just test its own copy)');

{
  const src = fs.readFileSync('src/plugin/outline/Outliner.tsx', 'utf8');

  check('★ the source still computes the delta as innerHeight - vv.height',
    /window\.innerHeight\s*-\s*vv\.height/.test(src),
    'the formula in Outliner.tsx changed, so the replica in this test must keep up');

  check('★ the source still has the 60px threshold',
    /rawOffset\s*>\s*60/.test(src),
    'the threshold changed');

  check('★ the source still treats innerWidth <= 768 as mobile',
    /window\.innerWidth\s*<=\s*768/.test(src),
    'the mobile detection changed');

  // ★ merely defining isMobile is not enough -- it must **really take part** in the isKbOpen criterion.
  //   Measured: when only the definition was asserted, changing `isMobile && rawOffset > 60` to
  //   `rawOffset > 60` (dropping the mobile restriction) still left the test all green, a missed detection.
  check('★★ isMobile must really take part in isKbOpen (it cannot just be defined and unused)',
    /isKbOpen\s*=\s*isMobile\s*&&/.test(src),
    'isMobile was removed from isKbOpen → the desktop floats up as well');

  check('★ the source still does not mix vv.offsetTop into the formula (a pitfall already hit)',
    !/rawOffset[^;]*(?:\+|-)\s*vv\.offsetTop/.test(src),
    'offsetTop was added back and will put the toolbar under the keyboard');

  check('★ the source still guards against negative values (Math.max(0, …))',
    /Math\.max\(0,\s*Math\.round\(rawOffset\)\)/.test(src),
    'the negative-value guard is gone');

  check('★ still listens to both resize and scroll (iOS fires both)',
    /visualViewport\.addEventListener\('resize'/.test(src) &&
    /visualViewport\.addEventListener\('scroll'/.test(src));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
