/**
 * Regression test for the three-zone drop target decision (agy UI-TC-17).
 *
 * ──────────────────────────────────────────────────────────────────
 * Why this test exists
 * ──────────────────────────────────────────────────────────────────
 *
 * The `25% / 75%` boundary used to be **written out in two places**:
 *   · desktop `onDragOver` (mouse drag)
 *   · mobile `touchHitTest` (finger drag)
 *
 * A comment claimed "the same boundary as the desktop, so the feel matches", but no **mechanism**
 * guaranteed they really agreed. Change one and forget the other and "the mouse drop lands somewhere else than the finger drop"
 * -- and since few people try both inputs in the same build, the defect stays hidden.
 *
 * Now both call the same pure function in `drop-zone.ts`, and this test pins its behavior.
 *
 * ──────────────────────────────────────────────────────────────────
 * Three-zone semantics
 * ──────────────────────────────────────────────────────────────────
 *
 *     0%  ┌──────────────┐
 *         │   above      │  insert before this row (become the previous sibling)
 *    25%  ├──────────────┤
 *         │   child      │  become a child of this row
 *    75%  ├──────────────┤
 *         │   below      │  insert after this row (become the next sibling)
 *   100%  └──────────────┘
 *
 * The edges (0.25 / 0.75) use strict less-than / strict greater-than -- landing exactly on the boundary counts as `child`,
 * so the middle interval is a **closed interval** [0.25, 0.75] and the exact middle is always `child`.
 */

export {};

import {
  DROP_ABOVE_RATIO,
  DROP_BELOW_RATIO,
  dropZoneAt,
  dropZoneFor,
  nearestRowZone,
} from './drop-zone';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(`${name}\n      expected ${JSON.stringify(want)}  got ${JSON.stringify(got)}`);
  }
}

/** Assert whether something throws -- used to pin the no-throw behavior */
function checkNoThrow(name: string, fn: () => unknown) {
  try {
    fn();
    pass++;
  } catch (e) {
    fail++;
    failures.push(`${name}\n      unexpected throw: ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log('Basic three-zone semantics (row height 100, so coordinates are percentages):');
{
  const H = 100;
  check('y=0   row top    → above', dropZoneFor(0, 0, H), 'above');
  check('y=10  10%      → above', dropZoneFor(10, 0, H), 'above');
  check('y=24  24%      → above', dropZoneFor(24, 0, H), 'above');
  check('y=26  26%      → child', dropZoneFor(26, 0, H), 'child');
  check('y=50  50% middle → child', dropZoneFor(50, 0, H), 'child');
  check('y=74  74%      → child', dropZoneFor(74, 0, H), 'child');
  check('y=76  76%      → below', dropZoneFor(76, 0, H), 'below');
  check('y=90  90%      → below', dropZoneFor(90, 0, H), 'below');
  check('y=100 row bottom → below', dropZoneFor(100, 0, H), 'below');
}

console.log('\n★ Boundary values: exactly on the boundary is child (closed-interval semantics):');
{
  const H = 100;
  check(`y=25 (exactly ${DROP_ABOVE_RATIO}) → child`, dropZoneFor(25, 0, H), 'child');
  check(`y=75 (exactly ${DROP_BELOW_RATIO}) → child`, dropZoneFor(75, 0, H), 'child');
  // either side of the boundary
  check('y=24.9 just above 25% → above', dropZoneFor(24.9, 0, H), 'above');
  check('y=25.1 just below 25% → child', dropZoneFor(25.1, 0, H), 'child');
  check('y=74.9 just above 75% → child', dropZoneFor(74.9, 0, H), 'child');
  check('y=75.1 just below 75% → below', dropZoneFor(75.1, 0, H), 'below');
}

console.log('\nRow not at the viewport origin (rectTop is not 0):');
{
  // a row starting at y=300 with height 80
  check('y=300 row top       → above', dropZoneFor(300, 300, 80), 'above');
  check('y=320 25% (=20)   → child', dropZoneFor(320, 300, 80), 'child');
  check('y=340 middle (=50) → child', dropZoneFor(340, 300, 80), 'child');
  check('y=365 81%        → below', dropZoneFor(365, 300, 80), 'below');
}

console.log('\n★ A row height of 0 must not crash (element hidden / not laid out yet):');
{
  // getBoundingClientRect reports height 0 under display:none or before layout,
  // and dividing directly yields Infinity / NaN, which makes the drop decision fail silently.
  checkNoThrow('height=0 does not throw', () => dropZoneFor(50, 0, 0));
  // ★ Do not use (clientY - top) / 1 -- that treats the pixel distance to the row top as a ratio:
  //   a 50px pointer offset would give ratio=50 → below, even though it is not on that row at all.
  //   Correct semantics: when height is unusable, keep only the reliable fact of which side of the row top it is on.
  check('height=0, pointer above the row top → above', dropZoneFor(-5, 0, 0), 'above');
  check('height=0, pointer exactly at the row top → above', dropZoneFor(0, 0, 0), 'above');
  check('height=0, pointer below the row top → below', dropZoneFor(50, 0, 0), 'below');
  check('★ with height=0 the pixel distance is never treated as a ratio', dropZoneFor(50, 0, 0) === 'child', false);
  checkNoThrow('height=NaN does not throw', () => dropZoneFor(50, 0, NaN));
  check('height=NaN, pointer below the row top → below', dropZoneFor(50, 0, NaN), 'below');
  checkNoThrow('clientY=NaN returns null', () => dropZoneFor(NaN, 0, 100));
  check('clientY=NaN → null', dropZoneFor(NaN, 0, 100), null);
}

console.log('\nInvalid input must return null (the caller uses that to ignore this event):');
{
  check('ratio=NaN  → null', dropZoneAt(NaN), null);
  check('ratio=Infinity → null', dropZoneAt(Infinity), null);
  check('ratio=-Infinity → null', dropZoneAt(-Infinity), null);
  checkNoThrow('NaN does not throw', () => dropZoneAt(NaN));
}

console.log('\nValues outside the row are handled as its two ends (callers often pass a bare ratio):');
{
  check('ratio=-0.5 → above', dropZoneAt(-0.5), 'above');
  check('ratio=1.5  → below', dropZoneAt(1.5), 'below');
  check('ratio=0    → above', dropZoneAt(0), 'above');
  check('ratio=1    → below', dropZoneAt(1), 'below');
}

console.log('\n★ Fallback: the pointer is in no row, so find the vertically nearest one:');
{
  // three rows, height 40 each: A=[0,40] B=[40,80] C=[80,120]
  const rows = [
    { top: 0, height: 40 },
    { top: 40, height: 40 },
    { top: 80, height: 40 },
  ];
  const FAR = 1000;

  // landing directly on the upper half of B → above, lower half → below (the fallback has only two zones)
  check('y=50 on the upper half of B → index=1, above', JSON.stringify(nearestRowZone(50, rows, FAR)), JSON.stringify({ index: 1, zone: 'above' }));
  check('y=70 on the lower half of B → index=1, below', JSON.stringify(nearestRowZone(70, rows, FAR)), JSON.stringify({ index: 1, zone: 'below' }));

  // **outside** a row: y=25 is inside A ([0,40]), so it is not "outside". Use y=-10, above A
  check('y=-10 above A → index=0, above', JSON.stringify(nearestRowZone(-10, rows, FAR)), JSON.stringify({ index: 0, zone: 'above' }));
  check('y=130 below C → index=2, below', JSON.stringify(nearestRowZone(130, rows, FAR)), JSON.stringify({ index: 2, zone: 'below' }));

  // ★ The fallback boundary is 0.5 (not 0.25/0.75): outside a row a finger cannot express "become a child"
  check('y=20 exactly at 50% of A → above (0.5 counts as the upper half)', JSON.stringify(nearestRowZone(20, rows, FAR)), JSON.stringify({ index: 0, zone: 'above' }));
  check('y=20.1 just past 50% → below', JSON.stringify(nearestRowZone(20.1, rows, FAR)), JSON.stringify({ index: 0, zone: 'below' }));

  // distance limit: beyond it a row is not a candidate
  check('y=500 beyond maxDistance=100 → null', nearestRowZone(500, rows, 100), null);
  check('y=-500 beyond maxDistance=100 → null', nearestRowZone(-500, rows, 100), null);
  check('empty candidates → null', nearestRowZone(50, [], FAR), null);
}

console.log('\nFallback: with several rows take the **nearest** one:');
{
  const rows = [
    { top: 0, height: 20 },
    { top: 200, height: 20 },
    { top: 400, height: 20 },
  ];
  const FAR = 10000;
  // y=195 is only 5 away from B(top=200) and far from the rest → B must win
  check('y=195 → picks index=1', nearestRowZone(195, rows, FAR)?.index, 1);
  check('y=395 → picks index=2', nearestRowZone(395, rows, FAR)?.index, 2);
  check('y=5   → picks index=0', nearestRowZone(5, rows, FAR)?.index, 0);
}

console.log('\n★ Desktop and mobile must use the one boundary (so it cannot fork again):');
{
  // These two call sites used to each write 0.25/0.75 out. Both now call dropZoneFor,
  // so "the same (y, top, h) yields the same zone" is an identity -- confirmed explicitly here,
  // and the two exported constants are pinned as well (changing a constant turns the test red).
  const cases: Array<[number, number, number]> = [
    [0, 0, 100],
    [24, 0, 100],
    [25, 0, 100],
    [50, 0, 100],
    [75, 0, 100],
    [76, 0, 100],
    [340, 300, 80],
  ];
  for (const [y, top, h] of cases) {
    const a = dropZoneFor(y, top, h);
    const b = dropZoneAt((y - top) / (h || 1));
    check(`agreement: (${y},${top},${h}) both paths give the same answer`, a, b);
  }
  check('constant DROP_ABOVE_RATIO = 0.25', DROP_ABOVE_RATIO, 0.25);
  check('constant DROP_BELOW_RATIO = 0.75', DROP_BELOW_RATIO, 0.75);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  FAIL ' + f);
  throw new Error(`${fail} test(s) failed`);
}
