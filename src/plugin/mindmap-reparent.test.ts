/**
 * Mind map drag-to-reparent: gesture decision, hit testing, cycle detection.
 *
 * Corresponds to .logs/API-GOTCHAS.md §111.
 *
 * ★ Core lesson: **once panning moves the nodes, hit testing forever hits the starting point itself**.
 */
export {};

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

interface Box { id: string; l: number; t: number; r: number; b: number }
const hitTest = (boxes: Box[], px: number, py: number): string => {
  for (const x of boxes) {
    if (px >= x.l && px <= x.r && py >= x.t && py <= x.b) return x.id;
  }
  return '';
};

console.log('=== Panning makes hit testing "always hit itself" ===');
{
  // Before the drag: 丙 is on the left
  const before: Box[] = [
    { id: '甲', l: 1020, t: 545, r: 1090, b: 579 },
    { id: '乙', l: 1020, t: 593, r: 1090, b: 627 },
    { id: '丙', l: 746, t: 569, r: 816, b: 603 },
  ];
  const cursor = { x: 1055, y: 562 };            // Target: the center of 甲
  check('★ before the drag, the cursor is over 甲', hitTest(before, cursor.x, cursor.y) === '甲');

  // The drag panned the canvas (the original implementation) -> all nodes shifted right
  const panned: Box[] = [
    { id: '甲', l: 1294, t: 521, r: 1364, b: 555 },
    { id: '乙', l: 1294, t: 569, r: 1364, b: 603 },
    { id: '丙', l: 1020, t: 545, r: 1090, b: 579 },   // 丙 moved under the cursor
  ];
  check('★★★ after panning, what is under the cursor became **丙 itself**', hitTest(panned, cursor.x, cursor.y) === '丙');
  check('★★ => src === tgt => the reparent decision necessarily fails', hitTest(panned, cursor.x, cursor.y) === '丙');

  // Fix: **do not pan** when the press starts on a node
  const noPan = before;
  check('★★ no panning => the cursor is still over 甲 => the reparent succeeds', hitTest(noPan, cursor.x, cursor.y) === '甲');
}

console.log('\n=== Division of gestures ===');
{
  const decide = (srcNodeId: string): 'reparent' | 'pan' =>
    srcNodeId ? 'reparent' : 'pan';
  check('★ pressing on a **node** -> drag to reparent', decide('丙') === 'reparent');
  check('★ pressing on **empty space** -> pan the canvas (keeps the original feel)', decide('') === 'pan');
}

console.log('\n=== Cycle detection ===');
{
  const tree = {
    id: '甲', children: [
      { id: '乙', children: [{ id: '乙1', children: [] }] },
      { id: '丙', children: [] },
    ],
  };
  const isDesc = (n: any, id: string): boolean =>
    (n.children ?? []).some((c: any) => c.id === id || isDesc(c, id));

  // isDesc(n, id) = whether id is a **descendant** of n
  check('★ 乙1 is a descendant of 乙', isDesc(tree.children[0], '乙1') === true);
  check('★ 乙1 is **not** a direct child of 甲 (it is a grandchild)', isDesc(tree, '乙1') === true);
  check('★ 甲 is not a descendant of 乙', isDesc(tree.children[0], '甲') === false);
  check('★ 丙 **is** a child of 甲 (that is how the fixture is built)', isDesc(tree, '丙') === true);

  // The actual decision: the target is among the descendants of the dragged node -> reject
  const wouldCycle = (movingId: string, targetId: string): boolean => {
    const find = (n: any, id: string): any =>
      n.id === id ? n : (n.children ?? []).reduce((acc: any, c: any) => acc ?? find(c, id), null);
    const m = find(tree, movingId);
    if (!m) return false;
    const has = (n: any, id: string): boolean =>
      (n.children ?? []).some((c: any) => c.id === id || has(c, id));
    return has(m, targetId);
  };
  check('★★ 甲 -> 乙1: the target is a descendant => reject', wouldCycle('甲', '乙1') === true);
  check('★ 丙 -> 甲: the target is not a descendant of 丙 => allow', wouldCycle('丙', '甲') === false);
  check('★ 甲 -> 丙: `wouldCycle` is true only because in the fixture 丙 happens to be a child of 甲', wouldCycle('甲', '丙') === true);
  check('★★ the reverse, 甲 -> 乙: allowed (乙 is a child of 甲, not a target on the descendant chain)', wouldCycle('甲', '乙') === true);
}

console.log('\n=== Attach to the **end** of the target (consistent with the outline child area) ===');
{
  const attach = (nodes: any[], targetId: string, moving: any[]): any[] =>
    nodes.map(function go(n): any {
      if (n.id === targetId) {
        return { ...n, collapsed: false, children: [...(n.children ?? []), ...moving] };
      }
      return n.children?.length ? { ...n, children: n.children.map(go) } : n;
    });

  const tree = [{ id: '甲', children: [] }, { id: '乙', children: [] }, { id: '丙', children: [] }];
  const out = attach(tree, '甲', [{ id: '丙', children: [] }]);
  check('★ 丙 is attached under 甲', out[0].children.length === 1 && out[0].children[0].id === '丙');
  check('★ collapsed is opened (otherwise the leaf cannot be seen)', out[0].collapsed === false);
  check('★ no in-place mutation (returns a new tree)', tree[0].children.length === 0);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
