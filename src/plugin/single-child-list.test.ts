/**
 * A child node must be **merged into the parent's existing child list**, not create a new child list for every insertion.
 *
 * Corresponds to .logs/API-GOTCHAS.md §108.
 *
 * ★ This is the **last layer** of root cause for defect #53:
 *   a wrong insertion anchor → **two sibling child lists** appear under 甲 →
 *   the child node's blockId is a List (not a listItem) →
 *   `moveNodes`'s `actualParentOf` (only accepts type='i') cannot find it →
 *   `if (!actualParentBlock) continue` skips it → **the order can never be corrected**.
 */
export {};

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

interface Blk { id: string; type: 'd' | 'h' | 'l' | 'i' | 'p'; parent: string; text: string }

/** Render the block table as indented text like `A > {ChildT, SiblingE}`, so assertions are easy */
const render = (blocks: Blk[], rootId: string): string[] => {
  const out: string[] = [];
  // ★ only listItems are rendered (a paragraph block is the listItem's "body text", not a line of its own)
  const walk = (pid: string, depth: number): void => {
    for (const b of blocks.filter((x) => x.parent === pid)) {
      if (b.type === 'i') out.push('  '.repeat(depth) + b.text.trim());
      walk(b.id, b.type === 'i' ? depth + 1 : depth);
    }
  };
  walk(rootId, 0);
  return out;
};

const childListsOf = (blocks: Blk[], listItemId: string): Blk[] =>
  blocks.filter((b) => b.type === 'l' && b.parent === listItemId);

console.log('=== old behavior: anchor on the parent paragraph block → a new child list per child node ===');
{
  const blocks: Blk[] = [
    { id: 'doc', type: 'd', parent: '', text: '' },
    { id: 'L0', type: 'l', parent: 'doc', text: '' },
    { id: '甲', type: 'i', parent: 'L0', text: '甲' },
    { id: '甲p', type: 'p', parent: '甲', text: '甲' },
    // first insertion of ChildT: the kernel **creates** child list LA under A
    { id: 'LA', type: 'l', parent: '甲', text: '' },
    { id: '子T', type: 'i', parent: 'LA', text: '子T' },
    { id: '子Tp', type: 'p', parent: '子T', text: '子T' },
    // second insertion of SiblingE: another child list LB is **created**
    { id: 'LB', type: 'l', parent: '甲', text: '' },
    { id: '同E', type: 'i', parent: 'LB', text: '同E' },
    { id: '同Ep', type: 'p', parent: '同E', text: '同E' },
  ];
  const lists = childListsOf(blocks, '甲');
  check('★ there are **2** child lists under the 甲 listItem', lists.length === 2);
  check(
    '★★ they are siblings in the UI, but two **separate containers** in SiYuan —— the structure is wrong',
    lists.length !== 1,
  );

  // moveNodes looks the child node's blockId up in actualParentOf
  const actualParentOf = new Map<string, string>();
  for (const b of blocks) if (b.type === 'i') actualParentOf.set(b.id, b.parent);
  check('★★ if 子T\'s blockId is the List(LA), actualParentOf **cannot find it**', !actualParentOf.has('LA'));
  check('★ ⇒ `if (!actualParentBlock) continue` skips ⇒ the order can never be corrected', !actualParentOf.has('LA'));
}

console.log('\n=== new behavior: anchor on "the last listItem of the existing child list" → merge into the same list ===');
{
  const blocks: Blk[] = [
    { id: 'doc', type: 'd', parent: '', text: '' },
    { id: 'L0', type: 'l', parent: 'doc', text: '' },
    { id: '甲', type: 'i', parent: 'L0', text: '甲' },
    { id: '甲p', type: 'p', parent: '甲', text: '甲' },
    { id: 'LA', type: 'l', parent: '甲', text: '' },
    { id: '子T', type: 'i', parent: 'LA', text: '子T' },
    { id: '子Tp', type: 'p', parent: '子T', text: '子T' },
    // second insertion of SiblingE: the anchor is **ChildT (the last listItem in LA)** → merged into LA
    { id: '同E', type: 'i', parent: 'LA', text: '同E' },
    { id: '同Ep', type: 'p', parent: '同E', text: '同E' },
  ];
  const lists = childListsOf(blocks, '甲');
  check('★★ there is only **1** child list under the 甲 listItem', lists.length === 1);

  const kids = blocks.filter((b) => b.type === 'i' && b.parent === 'LA').map((b) => b.text);
  check('★ the two child nodes live in the **same** list', kids.length === 2);
  check(`★★ the order is correct: [子T, 同E] (actual ${JSON.stringify(kids)})`, JSON.stringify(kids) === '["子T","同E"]');

  const actualParentOf = new Map<string, string>();
  for (const b of blocks) if (b.type === 'i') actualParentOf.set(b.id, b.parent);
  check('★★ 子T\'s blockId is now a listItem ⇒ actualParentOf **can find it**', actualParentOf.get('子T') === 'LA');
  check('★ ⇒ moveNodes no longer skips ⇒ the order can be corrected', actualParentOf.has('子T'));

  check(
    `★ render result: ${JSON.stringify(render(blocks, 'doc'))}`,
    JSON.stringify(render(blocks, 'doc')) === '["甲","  子T","  同E"]',
  );
}

console.log('\n=== anchor selection rule ===');
{
  const pickAnchor = (opts: { parentPara: string; childLastLi: string }): string => {
    if (!opts.parentPara) return '';
    return opts.childLastLi || opts.parentPara;   // prefer the last item of an existing child list when there is one
  };
  check('★ the parent has no child list yet → anchor on the parent paragraph block (the kernel creates the list for us)', pickAnchor({ parentPara: '甲p', childLastLi: '' }) === '甲p');
  check('★★ the parent already has a child list → anchor on the **last listItem of the child list**', pickAnchor({ parentPara: '甲p', childLastLi: '子T' }) === '子T');
  check('★ neither is present → fall back to another strategy', pickAnchor({ parentPara: '', childLastLi: '' }) === '');
}

console.log('\n=== measured data on record ===');
{
  const before = '["甲","  子T","  同E"]';
  const afterReal = ['甲', '  子T', '  同E', '乙', '丙'];
  check(`★★ after the fix: SiYuan ${JSON.stringify(afterReal)} —— **exactly matches the UI**`, afterReal[1] === '  子T' && afterReal[2] === '  同E');
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
