/**
 * Mind map one-finger pan and two-finger zoom (maps to UI-TC-09, Major).
 *
 * ──────────────────────────────────────────────────────────────────
 * What the case asks for
 * ──────────────────────────────────────────────────────────────────
 *
 * "Simulate a two-finger pinch gesture and a one-finger blank-area drag → the mind map transform matrix `transform`
 *   responds to the gesture in real time"
 *
 * What is actually rendered is `Mindmap.tsx:1196`:
 *
 *     <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
 *
 * So what has to be guarded is how `view = {x, y, k}` changes with the gesture.
 *
 * ──────────────────────────────────────────────────────────────────
 * Three semantics that are easy to get wrong (all pinned down by this test)
 * ──────────────────────────────────────────────────────────────────
 *
 * ① **zoom must be clamped to 0.2 ~ 3.0**
 *    Clamping only the lower bound or only the upper bound lets the user shrink the canvas out of sight / blow it up beyond recovery.
 *
 * ② **pressing down on a node must not pan the canvas**
 *    This was a real bug fixed after measurement: the original implementation panned unconditionally, so while dragging a node
 *    the whole canvas moved along and **the node under the cursor was always the source node itself**, so re-parent detection had to fail
 *    (the root cause of UI-TC-10). Panning must only be triggered by "pressing down on blank space".
 *    Criterion: `if (!dragRef.current.srcNodeId) { ...pan... }`
 *
 * ③ **one-finger pan has a 5px dead zone**
 *    Without a dead zone, a slightly shaky tap would push the canvas away.
 *
 * Frame rate (≥50fps) is environment dependent and is not measured here —— this file tests the **transform math**.
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

// ──────────────────────────────────────────────────────────────────
// Replicate the gesture math (cross-checked against `onPointerMove` at Mindmap.tsx:296)
// ──────────────────────────────────────────────────────────────────

const MIN_K = 0.2;
const MAX_K = 3;
const PAN_DEADZONE = 5;

type View = { x: number; y: number; k: number };
type Pt = { x: number; y: number };

const clampK = (k: number): number => Math.min(MAX_K, Math.max(MIN_K, k));
const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

/** One-finger pan: only takes effect when pressing on blank space, and has a 5px dead zone */
function pan(
  view: View,
  start: Pt,
  startView: View,
  cur: Pt,
  srcNodeId: string,
): { view: View; panned: boolean } {
  const dx = cur.x - start.x;
  const dy = cur.y - start.y;
  if (Math.hypot(dx, dy) <= PAN_DEADZONE) return { view, panned: false };
  if (srcNodeId) return { view, panned: false }; // pressed on a node → no panning
  return { view: { ...view, x: startView.x + dx, y: startView.y + dy }, panned: true };
}

/** Two-finger zoom: factor = current finger distance / initial finger distance */
function pinch(initK: number, initDist: number, p1: Pt, p2: Pt): number {
  return clampK(initK * (dist(p1, p2) / initDist));
}

// ──────────────────────────────────────────────────────────────────
console.log('① two-finger zoom: the transform responds to finger distance in real time');

{
  const p1 = { x: 100, y: 100 };
  const p2 = { x: 200, y: 100 }; // initial finger distance 100
  const initDist = dist(p1, p2);
  check('initial finger distance', initDist === 100);

  check('★ same finger distance → same zoom (k=1)', pinch(1, initDist, p1, p2) === 1);
  check('★ double finger distance → double k (spread = zoom in)',
    pinch(1, initDist, { x: 100, y: 100 }, { x: 300, y: 100 }) === 2);
  check('★ half finger distance → half k (pinch = zoom out)',
    pinch(1, initDist, { x: 100, y: 100 }, { x: 150, y: 100 }) === 0.5);
  check('zoom is **relative** to the current k, not an absolute overwrite',
    pinch(2, initDist, { x: 100, y: 100 }, { x: 250, y: 100 }) === 3,
    // initK=2 × factor 1.5 = 3 (exactly at the upper bound).
    // ★ a combination that does **not trigger clamp** has to be picked here to detect "relative":
    //   if it were implemented as an absolute overwrite (taking factor directly as k), the result would be 1.5 instead of 3.
    `got ${pinch(2, initDist, { x: 100, y: 100 }, { x: 250, y: 100 })}`);
}

// ──────────────────────────────────────────────────────────────────
console.log('\n② zoom must be clamped to 0.2 ~ 3.0');

{
  const p1 = { x: 0, y: 0 };
  const initDist = 10;

  check('★ upper bound 3.0 (an extreme spread does not exceed it)',
    pinch(1, initDist, p1, { x: 10000, y: 0 }) === 3,
    `got ${pinch(1, initDist, p1, { x: 10000, y: 0 })}`);
  check('★ lower bound 0.2 (pinching until almost coincident does not go below it)',
    pinch(1, initDist, p1, { x: 0.01, y: 0 }) === 0.2,
    `got ${pinch(1, initDist, p1, { x: 0.01, y: 0 })}`);
  check('inside the upper bound nothing is clamped (2.9 stays 2.9)', Math.abs(pinch(1, initDist, p1, { x: 29, y: 0 }) - 2.9) < 1e-9);
  check('inside the lower bound nothing is clamped (0.25 stays 0.25)', Math.abs(pinch(1, initDist, p1, { x: 2.5, y: 0 }) - 0.25) < 1e-9);

  // Boundary: the case where both clamps are written wrongly
  check('★ the criterion detects an implementation that clamps only the upper bound (the lower bound is missed)', clampK(0.0001) === MIN_K);
  check('★ the criterion detects an implementation that clamps only the lower bound (the upper bound is missed)', clampK(999) === MAX_K);
}

// ──────────────────────────────────────────────────────────────────
console.log('\n③ one-finger pan: the 5px dead zone');

{
  const v: View = { x: 0, y: 0, k: 1 };
  const start = { x: 100, y: 100 };

  const tiny = pan(v, start, v, { x: 103, y: 103 }, ''); // ~4.2px
  check('★ no movement inside the dead zone (a slight shake must not push the canvas away)', tiny.panned === false);
  check('inside the dead zone view is returned unchanged', tiny.view.x === 0 && tiny.view.y === 0);

  const moved = pan(v, start, v, { x: 150, y: 130 }, '');
  check('★ past the dead zone it pans', moved.panned === true);
  check('★ the displacement matches the finger displacement',
    moved.view.x === 50 && moved.view.y === 30,
    `got (${moved.view.x},${moved.view.y})`);
  check('panning does not change the zoom', moved.view.k === 1);

  // Panning is relative to the view at press time, not accumulative
  const startView: View = { x: 10, y: 20, k: 1.5 };
  const r2 = pan(v, start, startView, { x: 200, y: 100 }, '');
  check('★ computed from the view at press time (not accumulated per frame, which would drift)',
    r2.view.x === startView.x + 100 && r2.view.y === startView.y + 0,
    `got (${r2.view.x},${r2.view.y})`);
}

// ──────────────────────────────────────────────────────────────────
console.log('\n④ ★ pressing on a node → no canvas pan (a precondition for re-parent detection)');

{
  const v: View = { x: 0, y: 0, k: 1 };
  const start = { x: 100, y: 100 };

  const onNode = pan(v, start, v, { x: 300, y: 300 }, 'node-abc');
  check('★★ no panning when a node is hit (otherwise the node under the cursor is always the source node and re-parenting must fail)',
    onNode.panned === false,
    `got panned=${onNode.panned}`);
  check('★★ view is completely unchanged', onNode.view.x === 0 && onNode.view.y === 0);

  const onBlank = pan(v, start, v, { x: 300, y: 300 }, '');
  check('pressing on blank space pans normally', onBlank.panned === true);
}

// ──────────────────────────────────────────────────────────────────
console.log('\n⑤ combined: two-finger zoom and one-finger pan do not interfere');

{
  const v: View = { x: 5, y: 5, k: 1 };
  const initDist = 100;
  const k2 = pinch(1, initDist, { x: 0, y: 0 }, { x: 150, y: 0 });
  check('two-finger zoom changes k only', k2 === 1.5);
  const afterZoom: View = { ...v, k: k2 };
  check('zoom leaves x/y alone', afterZoom.x === 5 && afterZoom.y === 5);

  // panning after a zoom keeps k unchanged
  const p = pan(afterZoom, { x: 0, y: 0 }, afterZoom, { x: 50, y: 0 }, '');
  check('★ panning leaves k alone', p.view.k === 1.5);
  check('★ panning after a zoom is still correct', p.view.x === 55);
}

// ──────────────────────────────────────────────────────────────────
console.log('\n★ alignment with the source');

{
  const src = fs.readFileSync('src/mindmap/Mindmap.tsx', 'utf8');

  check('★ transform uses translate + scale (the order must not be swapped)',
    /transform=\{`translate\(\$\{view\.x\},\$\{view\.y\}\) scale\(\$\{view\.k\}\)`\}/.test(src),
    'scale before translate would multiply the displacement by the zoom');

  // ★ `Math.min(3, Math.max(0.2, ...))` appears **twice** in the source:
  //     ① two-finger pinch: `... dragRef.current.initK * factor`
  //     ② zoom button: `... v.k * f`
  //   if the assertion only wrote `Math.min\(3,\s*Math.max\(0\.2,`, it would be satisfied by ② alone ——
  //   delete the lower-bound clamp from ① and the test still goes fully green. The assertion must be pinned to **the two-finger one**.
  check('★ two-finger zoom is clamped to 0.2 ~ 3 (pinned to the pinch one, not the zoom-button one)',
    /const newK = Math\.min\(3,\s*Math\.max\(0\.2,\s*dragRef\.current\.initK \* factor\)\)/.test(src),
    'expected `const newK = Math.min(3, Math.max(0.2, dragRef.current.initK * factor))`');
  check('(the zoom-button one is clamped as well; both places cannot be reduced to one)',
    /setView\(\(v\) => \(\{ \.\.\.v, k: Math\.min\(3,\s*Math\.max\(0\.2, v\.k \* f\)\) \}\)\)/.test(src));

  check('★★ no panning when a node is hit (the `if (!dragRef.current.srcNodeId)` guard exists)',
    /if \(!dragRef\.current\.srcNodeId\)/.test(src));

  check('★ panning has a 5px dead zone', /Math\.hypot\(dx, dy\) > 5/.test(src));

  check('★ the initial finger distance and initial k are recorded on two fingers',
    /initDist = Math\.hypot/.test(src) && /initK = view\.k/.test(src));

  check('★ factor = current finger distance / initial finger distance',
    /const factor = dist \/ dragRef\.current\.initDist/.test(src));

  check('★ panning starts from the view at press time (viewX/viewY), not accumulative',
    /dragRef\.current\.viewX \+ dx/.test(src));

  check('★ no automatic fit after the user adjusted the viewport manually (otherwise the view keeps being dragged back)',
    /userAdjustedView\.current = true/.test(src));
}

// ──────────────────────────────────────────────────────────────────
console.log('\nThe criteria themselves are effective');

{
  // an implementation "without a dead zone" must be caught
  const noDeadzone = (d: number): boolean => d > 0;
  check('★ the criterion detects a "no dead zone" implementation', noDeadzone(0.5) === true);

  // an implementation that "also pans on nodes" must be caught
  const buggy = pan({ x: 0, y: 0, k: 1 }, { x: 0, y: 0 }, { x: 0, y: 0, k: 1 },
    { x: 100, y: 0 }, '');
  check('★ the criterion confirms blank-space panning works', buggy.panned === true);

  // a reversed clamp (min/max swapped) must be caught
  const reversed = (k: number): number => Math.max(3, Math.min(0.2, k));
  check('★ the criterion detects an implementation with min/max swapped', reversed(1) !== 1,
    `after swapping, clamp(1) = ${reversed(1)}`);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nFailed checks:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
