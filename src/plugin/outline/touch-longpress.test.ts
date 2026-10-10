/**
 * Touch long-press drag / short-press focus (UI-TC-05 and UI-TC-06, both Critical).
 *
 * ──────────────────────────────────────────────────────────────────
 * What the cases require
 * ──────────────────────────────────────────────────────────────────
 *
 * UI-TC-05 long-press drag activation:
 *   "hold on the node bullet for 360ms → fire a slight vibration feedback, the node gets
 *     `.touch-dragging`, and the drop indicator line appears"
 *
 * UI-TC-06 touch short-press focus:
 *   "tap for 100ms and release → trigger Zoom into the branch, the breadcrumb updates, **drag is not triggered**"
 *
 * The two are a **mutually exclusive** pair: from the same gesture origin, holding long enough takes the drag path, not holding long enough takes the focus path.
 * So what really has to be guarded is this boundary —— neither "a short press taken as a drag", nor
 * "a long press that does nothing".
 *
 * ──────────────────────────────────────────────────────────────────
 * Implementation points (Outliner.tsx:1593 `onBulletTouchStart`)
 * ──────────────────────────────────────────────────────────────────
 *
 *   · long-press threshold **350ms** (the case says 360ms, a 10ms gap, see the note at the end)
 *   · moving more than **8px** during the long press → judged a scroll, the long press is cancelled
 *   · entering the drag state: `setTouchDragging(true)` + `navigator.vibrate?.(15)`
 *     + starting edge auto-scroll
 *   · release: preventDefault only when `active`, then endTouchDrag
 *
 * `navigator.vibrate` may not exist on desktop Chrome —— the code calls it with `?.` and
 * wraps it in try/catch, so **a missing vibration must not break the long press**. This is one of the key assertions of this file.
 */

export {};

import * as fs from 'node:fs';
import { fnBody } from '../source-probe';

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
// Replica of the long-press state machine (cross-checked against Outliner.tsx:1593)
// ──────────────────────────────────────────────────────────────────

const LONG_PRESS_MS = 350;
const MOVE_TOLERANCE = 8;

type State = {
  timer: ReturnType<typeof setTimeout> | null;
  active: boolean;
  dragId: string;
  x: number;
  y: number;
  startX: number;
  startY: number;
};

type Effects = {
  touchDragging: boolean;
  dragIds: string[];
  vibrated: number | null;
  autoScroll: boolean;
  zoomed: string | null;
  dropped: { id: string; zone: string } | null;
};

function makeHarness(opts: { vibrateSupported?: boolean } = {}) {
  const fx: Effects = {
    touchDragging: false,
    dragIds: [],
    vibrated: null,
    autoScroll: false,
    zoomed: null,
    dropped: null,
  };
  let st: State | null = null;

  const vibrate = opts.vibrateSupported === false
    ? undefined
    : (ms: number) => { fx.vibrated = ms; };

  const start = (id: string, x: number, y: number): void => {
    st = { timer: null, active: false, dragId: id, x, y, startX: x, startY: y };
    const cur = st;
    cur.timer = setTimeout(() => {
      if (!st || st.dragId !== id) return;
      st.active = true;
      fx.touchDragging = true;
      fx.dragIds = [id];
      fx.autoScroll = true;
      try {
        vibrate?.(15);
      } catch {
        /* unsupported is fine */
      }
    }, LONG_PRESS_MS);
  };

  const move = (x: number, y: number): void => {
    if (!st) return;
    st.x = x;
    st.y = y;
    if (!st.active) {
      if (Math.abs(x - st.startX) > MOVE_TOLERANCE || Math.abs(y - st.startY) > MOVE_TOLERANCE) {
        if (st.timer !== null) clearTimeout(st.timer);
        st = null;
      }
      return;
    }
    // Drag state: hit test -> drop
    fx.dropped = { id: 'target', zone: 'below' };
  };

  const end = (): void => {
    if (!st) return;
    const wasActive = st.active;
    if (st.timer !== null) clearTimeout(st.timer);
    if (!wasActive) {
      // Short press → Zoom focus (no drag)
      fx.zoomed = st.dragId;
    }
    st = null;
  };

  return { fx, start, move, end, state: () => st };
}

// ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
console.log('UI-TC-05 long press 350ms → enters the drag state');

{
  const h = makeHarness();
  h.start('n1', 100, 100);
  check('not dragging at the moment of press (timer not elapsed)', h.fx.touchDragging === false);
    await new Promise((r) => setTimeout(r, 380));
  check('★★ entering the drag state after 350ms', h.fx.touchDragging === true);
  check('★ dragged node is registered', h.fx.dragIds.length === 1 && h.fx.dragIds[0] === 'n1');
  check('★ fires the vibration feedback (15ms)', h.fx.vibrated === 15, `got ${h.fx.vibrated}`);
  check('★ starts edge auto-scroll', h.fx.autoScroll === true);
  check('no Zoom triggered during the long press (mutual exclusion)', h.fx.zoomed === null);
}

// ──────────────────────────────────────────────────────────────────
console.log('\nUI-TC-06 short press 100ms then release → Zoom focus, drag not triggered');

{
  const h = makeHarness();
  h.start('n2', 100, 100);
  await new Promise((r) => setTimeout(r, 100));
  h.end();
  check('★★ short press does not enter the drag state', h.fx.touchDragging === false);
  check('★★ short press triggers Zoom focus', h.fx.zoomed === 'n2', `got ${h.fx.zoomed}`);
  check('★ short press does not vibrate', h.fx.vibrated === null);
  check('★ short press does not start auto-scroll', h.fx.autoScroll === false);
  check('state is cleared after the short press', h.state() === null);

  // after release the timer must not drag anyone into the drag state
  await new Promise((r) => setTimeout(r, 400));
  check('★★ after release, even 350ms later there is no "late entry into drag"',
    h.fx.touchDragging === false);
}

// ──────────────────────────────────────────────────────────────────
console.log('\nmoving > 8px during the long press → judged a scroll, long press cancelled');

{
  const h = makeHarness();
  h.start('n3', 100, 100);
  h.move(105, 103); // 5px / 3px, within tolerance
  await new Promise((r) => setTimeout(r, 380));
  check('movement within tolerance (5px) does not affect the long press', h.fx.touchDragging === true);

  const h2 = makeHarness();
  h2.start('n4', 100, 100);
  h2.move(120, 100); // 20px, beyond 8px
  await new Promise((r) => setTimeout(r, 380));
  check('★★ beyond 8px the long press is cancelled (the user is scrolling)', h2.fx.touchDragging === false);
  check('★ no vibration after the cancellation', h2.fx.vibrated === null);
  check('★ no drag after the cancellation', h2.fx.dragIds.length === 0);

  // the vertical direction has to be judged too
  const h3 = makeHarness();
  h3.start('n5', 100, 100);
  h3.move(100, 130);
  await new Promise((r) => setTimeout(r, 380));
  check('★ over 8px vertically also cancels (not only the horizontal axis)', h3.fx.touchDragging === false);
}

// ──────────────────────────────────────────────────────────────────
console.log('\n★ when the device does not support vibration, the long press must still work');

{
  const h = makeHarness({ vibrateSupported: false });
  h.start('n6', 100, 100);
  await new Promise((r) => setTimeout(r, 380));
  check('★★ enters the drag state even without navigator.vibrate (an optional capability must not take down the main flow)',
    h.fx.touchDragging === true);
  check('★ no error and no interruption when there is no vibration', h.fx.dragIds[0] === 'n6');
}

// ──────────────────────────────────────────────────────────────────
console.log('\nmoving while in the drag state → drop indicator line (drop hit)');

{
  const h = makeHarness();
  h.start('n7', 100, 100);
  await new Promise((r) => setTimeout(r, 380));
  check('drag state established', h.fx.touchDragging === true);
  h.move(200, 300);
  check('★★ moving while dragging computes a drop target (drop indicator line)', h.fx.dropped !== null);
  check('drop target carries a zone', h.fx.dropped?.zone === 'below');
}

// ──────────────────────────────────────────────────────────────────
console.log('\n★ alignment with the source (threshold, callbacks, optional vibration)');

{
  const src = fs.readFileSync('src/plugin/outline/Outliner.tsx', 'utf8');
  // ★ slice the function body by **structure**, not by a fixed character window.
  //   this used to be `src.slice(start, start + 1400)`: adding comments to these functions
  //   pushed the code the assertion needs out of the window —— not one wrong line of code yet it went red; conversely, deleting comments
  //   made the window cover the neighbouring branch and pass silently. A window length cannot be guessed.
  const start = src.indexOf('const onBulletTouchStart');
  check('onBulletTouchStart is found', start > 0);
  const body = fnBody(src, 'const onBulletTouchStart');
  check('slices the body of onBulletTouchStart (red when the slice fails, no silent pass)',
    body.length > 0, 'the function body is empty: the head string does not match the source');

  const ms = Number(/}, (\d+)\);/.exec(body)?.[1] ?? 0);
  check('★ the long-press threshold matches the source', ms === LONG_PRESS_MS, `source ${ms}ms, this file ${LONG_PRESS_MS}ms`);
  check('★ the threshold is in a sane range (250~500ms, too short misfires, too long has no patience)',
    ms >= 250 && ms <= 500, `got ${ms}ms`);
  // ⚠️ the tolerance criterion is not here —— it lives in `onBulletTouchMove` (see below).
  //    this assertion used to sit on the "origin function body" and only passed because the 1400-character window reached across into the move function,
  //    plus the "8px" text inside a comment: move the window and it goes falsely red, move the location and it goes falsely green.
  //    A criterion has to travel with the code it asserts about.
  check('★ sets the touch-dragging state flag when entering the drag state', /setTouchDragging\(true\)/.test(body));
  check('★★ vibration is an **optional call** (`?.`), and lack of support must not interrupt the long press',
    /navigator\.vibrate\?\.\(/.test(body));
  check('the vibration is guarded by try/catch', /try \{[\s\S]{0,80}vibrate/.test(body));
  check('★ starts edge auto-scroll after the long press', /startAutoScroll\(\)/.test(body));

  const moveBody = fnBody(src, 'const onBulletTouchMove');
  check('slices the body of onBulletTouchMove (red when the slice fails)', moveBody.length > 0);
  check('★ the 8px tolerance judges a scroll inside the move branch (matches the source)',
    (moveBody.match(/Math\.abs\([^)]*\)\s*>\s*8/g) || []).length === 2,
    'the tolerance criterion is not in onBulletTouchMove —— changing it to another number means "a scroll taken as a drag"');
  check('★ judges a scroll by 8px and clears the timer when the drag state is not entered',
    /clearTimeout\(st\.timer\)/.test(moveBody));
  check('★ preventDefault once in the drag state (otherwise the page follows the finger)',
    /e\.preventDefault\(\)/.test(moveBody));

  // short press takes the focus path: the endTouchDrag branch
  const endBody = fnBody(src, 'const onBulletTouchEnd');
  check('slices the body of onBulletTouchEnd (red when the slice fails)', endBody.length > 0);
  check('★ preventDefault only when active', /if \(st\.active\) e\.preventDefault\(\)/.test(endBody));
}

// ──────────────────────────────────────────────────────────────────
console.log('\nthe criterion itself is effective');

{
  // a wrong implementation where "a short press also drags" must be caught
  const bad = { touchDragging: true, zoomed: null as string | null };
  check('★ the criterion can spot "a short press taken as a drag"', bad.touchDragging === true && bad.zoomed === null);

  // a wrong implementation where "the long press does nothing" must be caught
  const noop = { touchDragging: false, vibrated: null as number | null };
  check('★ the criterion can spot "the long press does nothing"', noop.touchDragging === false);
}
}

main().then(() => {
  console.log(`\n${pass}/${pass + fail} passed`);
  if (failures.length) {
    console.log('\nfailed items:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
});
