// ★★★ The numbering-conversion plan, driven directly —— no browser, no kernel.
//
// `planNumberingConversion` decides which mapped nodes get deleted + reinserted with the other
// list marker (`-` vs `1.`), because the kernel has no in-place `u`↔`o` conversion (all four
// measured avenues answer `code: 0` and change nothing). Every skip rule here is a measured
// boundary: dropping any of them either destroys a task, converts the wrong thing, or pays a
// conversion for a node the insert path already handles.

import { planNumberingConversion } from './store';
import type { OutlineNode } from '../model/types';

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

const N = (id: string, over: Partial<OutlineNode> = {}): OutlineNode =>
  ({ id, modified: 0, text: id, children: [], ...over });

const itemIdOf = (m: Record<string, string>) => (nodeId: string): string | undefined => m[nodeId];
const isFresh = (fresh: Set<string>) => (bid: string): boolean => fresh.has(bid);
const storedOf = (m: Record<string, string | undefined>) => (itemId: string): string | undefined => m[itemId];

const items = { a: 'lia', b: 'lib', c: 'lic', d: 'lid', e: 'lie', f: 'lif' };

// ---------------------------------------------------------------- the two conversions

{
  const tree = [N('a'), N('b', { numbered: true })];
  const got = planNumberingConversion(
    tree, itemIdOf(items), isFresh(new Set()), storedOf({ lia: 'u', lib: 'u' }),
  );
  check(
    '★★ a plain node in an unordered list is left alone, a numbered one in it converts',
    got.length === 1 && got[0].nodeId === 'b' && got[0].itemId === 'lib',
    JSON.stringify(got),
  );
}

{
  const tree = [N('c', { numbered: true }), N('d')];
  const got = planNumberingConversion(
    tree, itemIdOf(items), isFresh(new Set()), storedOf({ lic: 'o', lid: 'o' }),
  );
  check(
    '★★ an ordered node that loses its numbering converts back, an ordered one that keeps it does not',
    got.length === 1 && got[0].nodeId === 'd' && got[0].itemId === 'lid',
    JSON.stringify(got),
  );
}

// ---------------------------------------------------------------- every skip rule

{
  // A task lives in a `t` list: converting to `o` would destroy the task, and no measured write
  // keeps both. Task preservation outranks numbering.
  const tree = [N('a', { numbered: true, taskStatus: 1 })];
  const got = planNumberingConversion(
    tree, itemIdOf(items), isFresh(new Set()), storedOf({ lia: 'u' }),
  );
  check('★ a numbered task never converts (task wins)', got.length === 0, JSON.stringify(got));
}

{
  // A stored task list is hands-off even for a plainly-numbered node.
  const tree = [N('b', { numbered: true })];
  const got = planNumberingConversion(
    tree, itemIdOf(items), isFresh(new Set()), storedOf({ lib: 't' }),
  );
  check('★ a stored task list is never converted', got.length === 0, JSON.stringify(got));
}

{
  // Unmapped nodes go through the insert path, which already carries the marker.
  const tree = [N('zz', { numbered: true })];
  const got = planNumberingConversion(
    tree, itemIdOf(items), isFresh(new Set()), storedOf({}),
  );
  check('★ an unmapped node is not planned (insert covers it)', got.length === 0, JSON.stringify(got));
}

{
  // Freshly-inserted blocks were just written with the right marker; their subtype is not indexed
  // yet, so any reading would be stale anyway.
  const tree = [N('e', { numbered: true })];
  const got = planNumberingConversion(
    tree, itemIdOf(items), isFresh(new Set(['lie'])), storedOf({ lie: 'u' }),
  );
  check('★ a freshly-inserted block is skipped', got.length === 0, JSON.stringify(got));
}

{
  // The index missed the block: the safe direction is to do nothing and retry next pass.
  const tree = [N('f', { numbered: true })];
  const got = planNumberingConversion(
    tree, itemIdOf(items), isFresh(new Set()), storedOf({}),
  );
  check('★ an unknown stored subtype converts nothing', got.length === 0, JSON.stringify(got));
}

{
  // Agreement in both directions is silence.
  const tree = [N('a'), N('c', { numbered: true })];
  const got = planNumberingConversion(
    tree, itemIdOf(items), isFresh(new Set()), storedOf({ lia: 'u', lic: 'o' }),
  );
  check('★ matching memory and kernel plan nothing', got.length === 0, JSON.stringify(got));
}

// ---------------------------------------------------------------- report

console.log(`numbering-plan: ${pass} passed, ${fail} failed`);
if (fail) {
  console.error(failures.map((f) => `  ✘ ${f}`).join('\n'));
  process.exit(1);
}
