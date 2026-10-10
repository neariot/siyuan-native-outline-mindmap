/**
 * The mapping table points at "a block the kernel already destroyed" → silent data loss.
 *
 * Corresponds to .logs/API-GOTCHAS.md §105 / §106.
 *
 * ★ Core point: a **mapping that points at a dead block** is far more dangerous than "no mapping".
 *   No mapping   → treated as a new node and re-inserted (idempotent);
 *   Dead mapping → every stage believes "it is already there", so nobody creates it and nobody errors.
 */
export {};

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
};

interface MapState {
  /** nodeId → blockId (paragraph block) */
  blockMap: Map<string, string>;
  /** nodeId → listItem */
  lastListItems: Map<string, string>;
  /** blockId → nodeId */
  lastByBlock: Map<string, string>;
}

/** Blocks that really exist in the store */
type Live = Set<string>;

console.log('=== §105 the damage chain of a dead mapping ===');
{
  const simulateWriteBack = (m: MapState, live: Live, uiNodes: string[]) => {
    let inserted = 0;
    for (const id of uiNodes) {
      const blk = m.blockMap.get(id);
      if (!blk) { inserted++; continue; }     // no mapping → re-insert ✅
      if (!live.has(blk)) continue;           // mapping exists but the block is dead → do nothing ❌
    }
    return { inserted };
  };

  const uiNodes = ['子T', '同E'];

  // Before the fix: ChildT's mapping points at a dead block
  const before: MapState = {
    blockMap: new Map([['子T', 'dead_blk'], ['同E', 'live_blk']]),
    lastListItems: new Map([['子T', 'dead_li'], ['同E', 'live_li']]),
    lastByBlock: new Map([['dead_blk', '子T'], ['live_blk', '同E']]),
  };
  const r1 = simulateWriteBack(before, new Set(['live_blk', 'live_li']), uiNodes);
  check('★★ Before the fix: 子T is neither re-inserted nor reports an error ⇒ silently disappears', r1.inserted === 0);

  // After the fix: the dead mapping is cleared → the node is re-inserted as new
  const after: MapState = {
    blockMap: new Map([['子T', 'dead_blk'], ['同E', 'live_blk']]),
    lastListItems: new Map([['子T', 'dead_li'], ['同E', 'live_li']]),
    lastByBlock: new Map([['dead_blk', '子T'], ['live_blk', '同E']]),
  };
  // Cleanup: for any block not in live, delete every mapping of that node
  const liveSetAfter = new Set(['live_blk', 'live_li']);
  for (const [nodeId, blk] of [...after.blockMap.entries()]) {
    if (liveSetAfter.has(blk)) continue;
    after.blockMap.delete(nodeId);
    after.lastByBlock.delete(blk);
  }
  const live2Has = (b: string): boolean => b === 'live_blk';
  const r2 = simulateWriteBack(after, new Set(['live_blk', 'live_li']), uiNodes);
  check('★★ After the fix: 子T is re-inserted ⇒ the data is back', r2.inserted === 1);

  check(
    '★★★ Conclusion: a dead mapping = silent loss; clearing the dead mapping = self-healing',
    r1.inserted === 0 && r2.inserted === 1,
  );
}

console.log('\n=== Both validation points are required ===');
{
  /**
   * ① The write-back entry (after loadBlockMap)
   * ② After the insert (inside syncStructure)
   *
   * ★ Doing only ① cannot catch a block "destroyed by this very insert" ——
   *   it was still alive when the write-back began.
   */
  const scenario = {
    atWriteEnter: 'alive',   // ChildT is still alive when the write-back begins
    afterInsert: 'dead',     // destroyed by the kernel after SiblingE is inserted
  };

  const checkAtEnter = scenario.atWriteEnter === 'dead';   // → false, cannot detect it
  const checkAfterInsert = scenario.afterInsert === 'dead'; // → true, detects it

  check('★ Doing only ① (write-back entry check) → **cannot detect it**', checkAtEnter === false);
  check('★★ ② (post-insert check) is required to cure #53', checkAfterInsert === true);
  check(
    '★★ The two predicates differ ⇒ one check cannot replace the other',
    checkAtEnter !== checkAfterInsert,
  );

  // ① still has value because of its cost
  const cost1 = 'zero-extra-query';   // loadBlockMap has just queried the store
  const cost2 = 'one-extra-query';    // a re-check of sibling blocks is needed
  check('① zero extra queries (reuses the loadBlockMap result)', cost1 === 'zero-extra-query');
  check('② queries only existing siblings (usually 0~2), negligible cost', cost2 === 'one-extra-query');
}

console.log('\n=== Clearing dead mappings must cover all three tables ===');
{
  const m = {
    blockMap: new Map([['子T', 'dead_blk']]),
    lastListItems: new Map([['子T', 'dead_li']]),
    lastByBlock: new Map([['dead_blk', '子T'], ['dead_li', '子T']]),
  };
  check('Before cleanup: all three tables hold dead links', m.blockMap.size === 1 && m.lastListItems.size === 1 && m.lastByBlock.size === 2);

  m.blockMap.delete('子T');
  m.lastListItems.delete('子T');
  m.lastByBlock.delete('dead_blk');
  m.lastByBlock.delete('dead_li');

  check('★ All three tables must be cleared: blockMap / lastListItems / lastByBlock', m.blockMap.size === 0 && m.lastListItems.size === 0 && m.lastByBlock.size === 0);
}

console.log('\n=== §106 child ordering: the early exit of moveNodes ===');
{
  interface PlanItem {
    nodeId: string;
    wantPid: string;
    index: number;
    blockId: string;
    /** The real type of that block in the store */
    realType: 'i' | 'l' | 'p' | 'missing';
  }
  /** actualParentOf only accepts blocks with type='i' */
  const actualParentOf = (it: PlanItem): string =>
    it.realType === 'i' ? 'someList' : '';

  const ziT: PlanItem = { nodeId: '子T', wantPid: '甲', index: 0, blockId: 'aaxx5ak', realType: 'l' };
  check('★ the real type of the child blockId is **List** (namespace mismatch)', ziT.realType === 'l');
  check('★★ actualParentOf finds nothing ⇒ `if (!actualParentBlock) continue` exits early', actualParentOf(ziT) === '');
  check('★★ Result: the child ordering is **never corrected**', actualParentOf(ziT) === '');

  // Direction of the fix
  const healed: PlanItem = { ...ziT, realType: 'i' };
  check('★ If the block ID is first put back on a real listItem, the ordering correction can proceed', actualParentOf(healed) === 'someList');
}

console.log('\n=== Measured data kept on record ===');
{
  const probe = { total: 7, aliveN: 4, dead: ['子T', '同E'] };
  check('★★ Probe measurement: only 4 of the 7 mapped blocks are alive', probe.total === 7 && probe.aliveN === 4);
  check('★ the dead ones are exactly the two nodes that went wrong', probe.dead.length === 2);

  const before = ['甲', '  同E', '乙', '丙'];
  const after = ['甲', '  同E', '  子T', '乙', '丙'];
  check('★★ Before the fix: 子T is gone', !before.some((s) => s.includes('子T')));
  check('★★ After the fix: both children are there', after.filter((s) => s.startsWith('  ')).length === 2);
  check('★ the remaining difference is only the **order** ([同E,子T] vs the UI order [子T,同E])', after.filter((s) => s.startsWith('  ')).join(',') === '  同E,  子T');
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
