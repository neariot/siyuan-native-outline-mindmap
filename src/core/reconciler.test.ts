// Unit tests for the pure mathematical Tree Reconciler (diffTrees and applyTreePatches).

import { diffTrees, applyTreePatches, type TreePatch } from './reconciler';
import type { OutlineNode } from '../model/types';
import { cloneNodes } from '../model/tree';

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

const mkNode = (
  id: string,
  text = id,
  children: OutlineNode[] = [],
  extras: Partial<OutlineNode> = {},
): OutlineNode => ({
  id,
  modified: 0,
  text,
  children,
  ...extras,
});

// 1. Identical trees produce zero patches
{
  const t1 = [mkNode('a', 'alpha', [mkNode('b', 'beta')]), mkNode('c', 'gamma')];
  const t2 = cloneNodes(t1);
  const patches = diffTrees(t1, t2);
  check('identical trees produce empty diff', patches.length === 0, `got ${patches.length}`);
}

// 2. Insertions: top-level and nested
{
  const base = [mkNode('a', 'alpha')];
  const target = [mkNode('a', 'alpha'), mkNode('b', 'beta', [mkNode('c', 'gamma')])];
  const patches = diffTrees(base, target);

  check('detects insertion patch', patches.some((p) => p.type === 'insert' && p.node.id === 'b'));
  const insertPatch = patches.find((p) => p.type === 'insert' && p.node.id === 'b') as Extract<
    TreePatch,
    { type: 'insert' }
  >;
  check('insert patch includes nested children', insertPatch?.node.children?.length === 1);
  check('insert patch target parent is root', insertPatch?.parentId === null);
  check('insert patch prevSibling is a', insertPatch?.prevSiblingId === 'a');

  const applied = applyTreePatches(base, patches);
  check('applied insert matches target structure', JSON.stringify(applied) === JSON.stringify(target));
}

// 3. Removals: single node and subtree pruning
{
  const base = [mkNode('a', 'alpha', [mkNode('b', 'beta', [mkNode('c', 'gamma')])]), mkNode('d', 'delta')];
  const target = [mkNode('d', 'delta')];
  const patches = diffTrees(base, target);

  check(
    'emits removal for root ancestor a only',
    patches.filter((p) => p.type === 'remove').length === 1 &&
      patches.some((p) => p.type === 'remove' && p.nodeId === 'a'),
  );
  const applied = applyTreePatches(base, patches);
  check('applied removal matches target', JSON.stringify(applied) === JSON.stringify(target));
}

// 4. Content updates: text, paragraphs, taskStatus, numbering, heading
{
  const base = [mkNode('a', 'old-text', [], { paragraphs: ['p1'], taskStatus: 0, numbered: false, heading: 0 })];
  const target = [
    mkNode('a', 'new-text', [], {
      paragraphs: ['p1', 'p2'],
      taskStatus: 1,
      numbered: true,
      heading: 2,
    }),
  ];
  const patches = diffTrees(base, target);

  check('detects updateText patch', patches.some((p) => p.type === 'updateText' && p.text === 'new-text'));
  check('detects updateParagraphs patch', patches.some((p) => p.type === 'updateParagraphs' && p.paragraphs.length === 2));
  check('detects setTaskStatus patch', patches.some((p) => p.type === 'setTaskStatus' && p.taskStatus === 1));
  check('detects setNumbering patch', patches.some((p) => p.type === 'setNumbering' && p.numbered === true));
  check('detects setHeading patch', patches.some((p) => p.type === 'setHeading' && p.heading === 2));

  const applied = applyTreePatches(base, patches);
  check('applied updates match target', JSON.stringify(applied) === JSON.stringify(target));
}

// 5. Moves: reordering siblings and reparenting
{
  const base = [
    mkNode('a', 'A'),
    mkNode('b', 'B'),
    mkNode('c', 'C'),
  ];
  // Reorder to C, A, B
  const reordered = [
    mkNode('c', 'C'),
    mkNode('a', 'A'),
    mkNode('b', 'B'),
  ];
  const patchesReorder = diffTrees(base, reordered);
  check('detects move on reorder', patchesReorder.some((p) => p.type === 'move' && p.nodeId === 'c'));
  const appliedReorder = applyTreePatches(base, patchesReorder);
  check('applied reorder matches target', JSON.stringify(appliedReorder) === JSON.stringify(reordered));

  // Reparent: indent B under A
  const nested = [
    mkNode('a', 'A', [mkNode('b', 'B')]),
    mkNode('c', 'C'),
  ];
  const patchesNested = diffTrees(base, nested);
  check('detects move on reparenting', patchesNested.some((p) => p.type === 'move' && p.nodeId === 'b' && p.parentId === 'a'));
  const appliedNested = applyTreePatches(base, patchesNested);
  check('applied reparent matches target', JSON.stringify(appliedNested) === JSON.stringify(nested));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('FAILURES:');
  for (const f of failures) console.log('  FAIL ' + f);
  throw new Error(`${fail} test(s) failed`);
}
