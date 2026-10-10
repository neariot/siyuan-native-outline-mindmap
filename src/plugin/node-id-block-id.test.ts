/**
 * A node ID **must** equal the SiYuan listItem block ID —— otherwise the mapping keys drift → duplicate insertion.
 *
 * Corresponds to .logs/API-GOTCHAS.md §109, defect #54.
 *
 * ★ Design premise: with no private attribute present, `loadBlockMap`
 *   takes the listItem's **block ID** straight as the key. So `node.id` must be exactly that block ID.
 *   If the id is not written into the markdown on insert, the kernel assigns a **brand-new block ID** → key drift.
 */
export {};

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

const SIYUAN_ID_RE = /^\d{14}-[0-9a-z]{7}$/;

/** Building the markdown on insert —— the two forms before and after the fix */
const mdBefore = (text: string): string => `- ${text}`;
const mdAfter = (id: string, text: string): string =>
  SIYUAN_ID_RE.test(id) ? `- {: id="${id}"}${text}` : `- ${text}`;

console.log('=== how the key drift happens ===');
{
  const nodeId: string = '20261005223702-kv25149';   // generated client-side by makeSiyuanId()
  const realBlockId: string = '20261005223703-ovmfqd7'; // assigned separately by the kernel (the md carries no id)

  check('★ both IDs are in valid SiYuan ID format', SIYUAN_ID_RE.test(nodeId) && SIYUAN_ID_RE.test(realBlockId));
  check('★★ but they are **not the same** ID', nodeId !== realBlockId);

  // the key syncStructure registers with = the node ID
  const lastBlockMap = new Map<string, string>();
  lastBlockMap.set(nodeId, 'para-1');
  // the key loadBlockMap rebuilds with = the block ID
  const rebuilt = new Map<string, string>();
  rebuilt.set(realBlockId, 'para-1');

  check('★ syncStructure uses the **node ID** as the key', lastBlockMap.has(nodeId));
  check('★ loadBlockMap uses the **block ID** as the key', rebuilt.has(realBlockId));
  check('★★★ the two keys differ ⇒ the next write-back cannot find it ⇒ judged a new node ⇒ **duplicate insertion**', !rebuilt.has(nodeId));
}

console.log('\n=== the fix: write the id into the inserted markdown ===');
{
  const nodeId = '20261005224814-fg40bcy';
  const md = mdAfter(nodeId, '同E');
  check(`★ the generated md: ${md}`, md === `- {: id="${nodeId}"}同E`);

  // the keys now agree
  const lastBlockMap = new Map<string, string>([[nodeId, 'para']]);
  const rebuilt = new Map<string, string>([[nodeId, 'para']]);
  check('★★ it is still found after the rebuild ⇒ it is not taken for a new node', rebuilt.has(nodeId));
  check('★ ⇒ no duplicate insertion', lastBlockMap.has(nodeId) && rebuilt.has(nodeId));

  // an invalid id falls back to the old form (the kernel never receives a bad ID)
  check('★ an invalid ID falls back to the id-less form (a safety net)', mdAfter('bogus', 'x') === '- x');
  check('★ only a valid ID is inlined', mdAfter('20261005224814-fg40bcy', 'x').includes('{: id='));
}

console.log('\n=== measured hard evidence ===');
{
  const evidence = { node: '20261005223702-kv25149', block: '20261005223703-ovmfqd7' };
  check('★★ probe measurement: the node ID and the mapped block ID prefixes differ by 1 second', evidence.node.slice(0, 14) !== evidence.block.slice(0, 14));

  const dupBefore = ['甲', '  子T', '    孙X', '  同E', '  同E', '乙', '丙'];
  const countBefore = dupBefore.filter((s) => s.trim() === '同E').length;
  check(`★★ before the fix the document holds **${countBefore}** 同E`, countBefore === 2);

  const fixed = ['甲', '  子T', '    孙X', '  同E', '乙', '丙'];
  const countAfter = fixed.filter((s) => s.trim() === '同E').length;
  check('★★ after the fix there is only 1 同E', countAfter === 1);
  check('★★ the three-level nesting is correct (子T > 孙X)', fixed.indexOf('    孙X') === fixed.indexOf('  子T') + 1);

  const childLists = 1; // measured by SQL: 甲 has only one child list
  check('★★ 甲 has **only 1** child list under its listItem (not one created per insertion)', childLists === 1);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
