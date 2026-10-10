/**
 * **Anchor choice** when Tab/Enter adds a node on the mind map.
 *
 * See .logs/API-GOTCHAS.md §100 / §101.
 *
 * ★ Core: `insertBlock`'s anchor decides whether the new node is a "sibling" or a "child",
 *   and **the two semantics are exactly opposite** — the parent level needs a paragraph block, the sibling level must not have one.
 */
import * as fs from 'node:fs';
import { fnBody } from './source-probe';

export {};

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail?: string): void => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    // a failure without the observed value is just a name
    console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`);
  }
};

/** The kind of anchor stored in blockMap */
type AnchorKind = 'listItem' | 'paragraph' | 'none';

interface AnchorTrial {
  /** Goal: make the new node a child of the "parent node" */
  parentKind: AnchorKind;
  /** Which field carries it */
  via: 'previousID' | 'parentID';
  /** Experiment result: did it really become a child */
  nested: boolean;
  /** Did it corrupt the parent node's text */
  corruptsParent: boolean;
  /** Did the kernel reject it outright */
  code: number;
}

/** The §100 measured matrix (clean document `- 甲 / - 乙 / - 丙`) */
const TRIALS: AnchorTrial[] = [
  { parentKind: 'listItem',  via: 'previousID', nested: false, corruptsParent: false, code: 0 },
  { parentKind: 'paragraph', via: 'previousID', nested: true,  corruptsParent: false, code: 0 },
  { parentKind: 'listItem',  via: 'parentID',   nested: true,  corruptsParent: true,  code: 0 },
  { parentKind: 'paragraph', via: 'parentID',   nested: false, corruptsParent: false, code: -1 },
];

console.log('=== §100 anchor matrix: making the new node a child of the "parent" ===');
{
  for (const t of TRIALS) {
    const label = `${t.via}=parent's ${t.parentKind === 'listItem' ? 'listItem' : 'paragraph block'}`;
    check(`${label} → code ${t.code}`, t.code === (t.parentKind === 'paragraph' && t.via === 'parentID' ? -1 : 0));
  }

  const good = TRIALS.filter((t) => t.nested && !t.corruptsParent && t.code === 0);
  check('★ exactly one combination works', good.length === 1);
  check(
    '★★ and it = previousID + the parent **paragraph block**',
    good[0].via === 'previousID' && good[0].parentKind === 'paragraph',
  );
  check('★★ using the parent listItem as previousID → same level (this is the cause of #52)', !TRIALS[0].nested);
  check(
    '★★ using the parent listItem as parentID → nested but **swallows the parent text** (worse)',
    TRIALS[2].nested && TRIALS[2].corruptsParent,
  );
  check('★ using the parent paragraph block as parentID → the kernel answers -1 outright', TRIALS[3].code === -1);
}

console.log('\n=== Child-level anchor: converting the parent listItem → the parent paragraph block ===');
{
  /**
   * Reproduces the value chain after the fix:
   *   parentAnchor is the parent's listItem
   *   → lastByBlock looks the parent node ID back up
   *   → lastBlockMap takes the parent's paragraph block
   */
  const lastByBlock = new Map([['LI_jia', 'n_jia']]);
  const lastBlockMap = new Map([['n_jia', 'P_jia']]);
  const resolve = (parentAnchor: string): string => {
    const nodeId = parentAnchor ? lastByBlock.get(parentAnchor) || '' : '';
    return nodeId ? lastBlockMap.get(nodeId) || '' : '';
  };

  check('the parent listItem → the parent paragraph block', resolve('LI_jia') === 'P_jia');
  check('★ top level (no parent anchor) → empty string, falling back to parentID=the document', resolve('') === '');
  check('★ the node cannot be looked up → empty string (no crash)', resolve('LI_unknown') === '');

  // fallback chain: when the paragraph block is unavailable it must still fall back to listItem, not pass nothing at all
  const fallback = (parentAnchor: string, hasPara: boolean): string =>
    hasPara ? resolve(parentAnchor) : (parentAnchor || '');
  check('★ falling back to listItem when the paragraph block is missing (at least it inserts)', fallback('LI_jia', false) === 'LI_jia');
  check('the paragraph block is preferred when available', fallback('LI_jia', true) === 'P_jia');
}

console.log('\n=== §101 adding a sibling at child level overwrites the previous sibling ===');
{
  interface Node {
    id: string;
    block: string;
  }
  /** UI state: addSibling correctly inserted newNode after afterId */
  const uiAfterEnter: Node[] = [
    { id: 'n_ziT', block: 'b_ziT' },
    { id: 'n_new', block: 'b_new' },
  ];
  check('★ the UI shows two **different** node IDs (the tree is right)', uiAfterEnter[0].id !== uiAfterEnter[1].id);
  check('★ in the UI the two nodes are bound to **different** block IDs', uiAfterEnter[0].block !== uiAfterEnter[1].block);

  /** What SiYuan really has: only one block is left, holding the new node's content */
  const siyuanAfterEnter = [{ id: 'n_new', block: 'b_ziT' }];
  check(
    '★★ only one block is left in SiYuan ⇒ the new node **reused its sibling\'s block**',
    siyuanAfterEnter.length === 1 && siyuanAfterEnter[0].block === uiAfterEnter[0].block,
  );
  check(
    '★★ so this is a **write-back** defect, not a tree-building defect',
    uiAfterEnter.length === 2 && siyuanAfterEnter.length === 1,
  );
  check(
    '★ the ratio between UI IDs and bound block IDs is the criterion (2 to 2 vs 1 to 1)',
    new Set(uiAfterEnter.map((n) => n.block)).size === 2 &&
      new Set(siyuanAfterEnter.map((n) => n.block)).size === 1,
  );
}

console.log('\n=== The measurement must stay written down in the source ===');
{
  // ★ This section used to assert on a string the test itself declared four
  //   lines above (`const oldClaim = '…'` then `oldClaim.includes('一律')`), so
  //   it could never go red no matter what the implementation said, and the
  //   word it looked for disappeared the moment the source was translated into
  //   English. Assert on the **real** source instead: the anchor chain below is
  //   the one this file's replica mirrors.
  //
  //   ★★ What must survive in the code is the *distinction*: a child level
  //   anchors on the parent's paragraph block, while a sibling level must not.
  //   Collapsing the two into one rule is the defect (§100: the two semantics
  //   are exactly opposite).
  const store = fs.readFileSync('src/siyuan/store.ts', 'utf8');
  const walk = fnBody(store, 'const walk = async (list: OutlineNode[], parentAnchor: string)');
  check('the child-level anchor chain is in syncStructure', walk.length > 0);

  check(
    '★★ a child level resolves listItem → node → **paragraph block** (lastByBlock then lastBlockMap)',
    /this\.lastByBlock\.get\(\s*parentAnchor\s*\)/.test(walk) &&
      /this\.lastBlockMap\.get\(\s*subAnchor\s*\)/.test(walk),
    'the chain that turns the parent listItem into the parent paragraph block is gone',
  );
  check(
    '★★ the parent paragraph block is tried **before** any sibling fallback',
    /parentPara\s*\?[\s\S]{0,400}?prevExisting\s*\?/.test(walk),
    'prevExisting is consulted before the parent paragraph block -- that is the overwrite defect of §101',
  );
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
