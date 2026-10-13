/**
 * The mapping table points at "a block the kernel already destroyed" → silent data loss.
 *
 * Corresponds to `docs/pitfalls/data.md` §1.6 / §1.8 (a mapping to a destroyed block; a listItem mapping is what `moveNodes` needs).
 *
 * ★ Core point: a **mapping that points at a dead block** is far more dangerous than "no mapping".
 *   No mapping   → treated as a new node and re-inserted (idempotent);
 *   Dead mapping → every stage believes "it is already there", so nobody creates it and nobody errors.
 *
 * ★ Both directions of the decision are destructive, which is why it is not tested through a transcribed
 *   copy any more: declare too little dead and the node keeps a link to a destroyed block (present in the
 *   UI, absent in SiYuan, no error —— measured `total=7, only 4 alive`); declare too much dead and a live
 *   node is re-inserted as new (defect #54: `SiblingE` written at 22:32:58 and again at 22:33:15). The two
 *   predicates now live in `src/siyuan/store.ts` and are called by the write-back itself:
 *   `deadMappingSuspects()` and `suspectedStructuralChange()`.
 *
 * ★ This file used to hold `simulateWriteBack()` —— a three-line copy of the chain —— and asserted on that
 *   copy, so the plugin's own rule could be changed without turning anything red.
 */
export {};

import fs from 'node:fs';
import path from 'node:path';
import { callSites } from './source-probe';
import { deadMappingSuspects, suspectedStructuralChange } from '../siyuan/store';

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

const dead = (id: string) => `dead-${id}`;

console.log('=== §105 a mapping pointing at a destroyed block is a suspect ===');
{
  // 子T maps to a block the index never reported; 同E maps to a block that is alive.
  const blockMap = new Map([
    ['子T', dead('blk')],
    ['同E', 'live-blk'],
  ]);
  const freshlyInserted = new Set<string>();
  const suspects = deadMappingSuspects(blockMap, new Set(['live-blk', 'live-li']), freshlyInserted);

  check('★★ the dead mapping is reported (so it can be cleared and the node re-inserted)',
    suspects.length === 1 && suspects[0][0] === '子T', JSON.stringify(suspects));
  check('★ the live mapping is not touched', !suspects.some(([n]) => n === '同E'), JSON.stringify(suspects));
  check('★ a node with no mapping at all is not a suspect (it is a new node, not a dead link)',
    deadMappingSuspects(new Map(), new Set(), freshlyInserted).length === 0);
  check('★ an empty index is not "everything is dead"',
    deadMappingSuspects(new Map([['a', 'x']]), new Set(), new Set()).length === 1,
    'a block missing from an empty index is still only a suspect, never a verdict');
}

console.log('\n=== defect #54: a block we just inserted must never be declared dead ===');
{
  // The index lags 1~3 s behind an insert, so "SQL did not find it" says nothing about a fresh block.
  // Without this exemption the mapping of a just-inserted node is cleared and the next write-back inserts
  // it a **second time** —— the measured duplicate.
  const fresh = new Set([dead('blk')]);
  const blockMap = new Map([['子T', dead('blk')]]);
  check('★★★ a freshly inserted block is exempt, even though the index has not caught up',
    deadMappingSuspects(blockMap, new Set(['live-blk']), fresh).length === 0,
    JSON.stringify(deadMappingSuspects(blockMap, new Set(['live-blk']), fresh)));
  check('★ … and it stops being exempt as soon as the index reports it (no permanent immunity)',
    deadMappingSuspects(blockMap, new Set([dead('blk')]), fresh).length === 0,
    'alive ⇒ never a suspect, whatever the exemption set says');
}

console.log('\n=== §106/§53: only a structural change may confirm a death ===');
{
  // A pure text edit cannot destroy a sibling block: the node count equals the block count.
  check('★★ a pure text edit (node count === mapped count) may not confirm a death',
    suspectedStructuralChange(7, 7) === false);
  check('★★ a structural change (the counts differ) may',
    suspectedStructuralChange(7, 5) === true);
  check('★ one extra node in the tree also counts as structural',
    suspectedStructuralChange(8, 7) === true);
}

console.log('\n=== the write-back really uses these predicates ===');
{
  // ★ Precondition of everything above: a rule that nothing calls defends nothing. Read through the parser,
  //   because the names also appear in the comments that explain them.
  const src = fs.readFileSync(path.join(__dirname, '..', 'siyuan', 'store.ts'), 'utf8');
  const suspects = callSites(src, /^deadMappingSuspects$/);
  const structural = callSites(src, /^suspectedStructuralChange$/);
  check('★★ the liveness check asks deadMappingSuspects()', suspects.length === 1, suspects.join(', '));
  check('★★ the confirmation gate asks suspectedStructuralChange()', structural.length === 1,
    structural.join(', '));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
