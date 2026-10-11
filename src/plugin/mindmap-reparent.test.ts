/**
 * Mind map drag-to-reparent: gesture decision, hit testing, cycle detection.
 *
 * Corresponds to .logs/API-GOTCHAS.md §111.
 *
 * ★ Core lesson: **once panning moves the nodes, hit testing forever hits the starting point itself**.
 *
 * ★ This file used to hold a local `hitTest()` and a `decide()` —— a model of the gesture, written inside the
 *   test —— so neither the pan/hit-test trap nor the cycle guard could turn it red. Both are read from the
 *   product now:
 *
 *   · the drop decision in `src/mindmap/Mindmap.tsx` (which position it hit-tests with, how it finds the
 *     target, and what disqualifies one);
 *   · the reparent itself in `src/plugin/mount.ts` (the cycle guard, and the take-out-then-append order).
 */
export {};

import fs from 'node:fs';
import path from 'node:path';
import { enclosingBody, fnBody } from './source-probe';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? `  ${detail}` : ''}`);
  }
};

const mindmapSrc = fs.readFileSync(path.join(__dirname, '..', 'mindmap', 'Mindmap.tsx'), 'utf8');
const mountSrc = fs.readFileSync(path.join(__dirname, 'mount.ts'), 'utf8');

console.log('=== the drop is hit-tested where the pointer really was ===');
{
  // ★ The anchor is a statement inside the handler, so the body is taken with `enclosingBody` —— `fnBody`
  //   takes the nearest function *starting after* the anchor and would return a nested closure instead.
  const body = enclosingBody(mindmapSrc, 'const px = dragRef.current.lastX;');
  check('★ the drop handler was found (precondition)', body.length > 100, `len=${body.length}`);
  check('★★★ it hit-tests with the position the handler recorded itself',
    body.includes('dragRef.current.lastX') && body.includes('lastY'),
    'pointer capture redirects later events, so the event coordinates point at the source node');
  check('★★★ … and never with the event coordinates',
    !/\be\.client[XY]\b/.test(body), 'measured: that returns the source node, so src === tgt and the reparent is dropped');
  check('★★ the target is found by comparing rectangles, not by elementFromPoint',
    body.includes('getBoundingClientRect') && !body.includes('elementFromPoint'),
    'inside SVG elementFromPoint returns `text`/`rect`, and `closest(.mm-node)` is unreliable');
  check('★★ a drop onto itself, or onto the root, is not a reparent',
    body.includes('tgt !== src') && body.includes("'__root__'"), body.slice(0, 120));
  check('★ only a real drag reparents (a click that moves nothing must stay a click)',
    body.includes('didDragRef'), body.slice(0, 120));
}

console.log('\n=== the reparent itself refuses a cycle and keeps the node ===');
{
  const body = fnBody(mountSrc, 'onReparent: (ids: string[], targetId: string)');
  check('★ the handler exists (precondition)', body.length > 100, `len=${body.length}`);
  check('★★★ dropping a node into its own descendant is refused before anything is mutated',
    body.includes('isDesc') && body.indexOf('isDesc') < body.indexOf('removeNode'),
    'the guard must run before the node is taken out, or a refused drop loses it');
  check('★ the refusal returns, rather than continuing with a partial move',
    /if \(n && isDesc\(n, targetId\)\) return;/.test(body), body.slice(0, 160));
  check('★★ the node is taken out **before** it is appended (otherwise it exists twice)',
    body.indexOf('removeNode(') < body.indexOf('children: [...'), 'remove-then-attach');
  check('★ it is appended to the **end** of the target\'s children, like the outline\'s drop zone "child"',
    /children: \[\.\.\.\(n\.children \?\? \[\]\), \.\.\.grabbed\]/.test(body), body.slice(0, 200));
  check('★ the move is undoable (a snapshot is pushed before the mutation)',
    body.indexOf('pushUndo(') >= 0 && body.indexOf('pushUndo(') < body.indexOf('removeNode('),
    'the user can take back a wrong drop');
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
