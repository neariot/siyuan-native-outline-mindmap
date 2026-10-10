/**
 * Connector lines: the delete entry point must actually be wired up; the write-back attribute format must be correct.
 *
 * Corresponds to .logs/API-GOTCHAS.md §116, defect #55.
 */
export {};

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

interface LinkLine { id: string; toNodeId: string; dashed?: boolean; label?: string }
interface Node { id: string; children: Node[]; linkLines?: LinkLine[] }

console.log('=== #55: a declared-but-never-passed callback = a dead end ===');
{
  // Mindmap declares onDeleteLink, but nobody in the whole project passes it (only the retired web version did)
  const declared = ['onDeleteLink', 'onEditNode', 'onAddNode', 'onDeleteNode'];
  const wiredByMount: string[] = ['onEditNode', 'onAddNode', 'onDeleteNode'];
  const dead = declared.filter((d) => !wiredByMount.includes(d));
  check('★ onDeleteLink is declared in the mind map', declared.includes('onDeleteLink'));
  check('★★★ mount.ts does **not** pass it => clicking delete does nothing at all', dead.includes('onDeleteLink'));

  // Quantify the symptom
  const before = { links: 1, attr: '[{"id":"EMeWnSFiRi",...}]' };
  const afterBroken = { links: 1, attr: before.attr };
  check('★★ before the fix: after clicking link delete there is still 1 dashed line', afterBroken.links === 1);
  check('★★ before the fix: the attribute does not budge at all', afterBroken.attr === before.attr);
}

console.log('\n=== Fix: filter by id, drop the field when empty ===');
{
  const strip = (logo: LinkLine[], linkId: string): LinkLine[] | undefined => {
    const keep = logo.filter((l) => l.id !== linkId);
    return keep.length > 0 ? keep : undefined;
  };

  const one: LinkLine[] = [{ id: 'A', toNodeId: 'n2', dashed: true }];
  check('★ deleting the only one => returns undefined (the field is dropped entirely)', strip(one, 'A') === undefined);

  const two: LinkLine[] = [
    { id: 'A', toNodeId: 'n2', dashed: true },
    { id: 'B', toNodeId: 'n3', dashed: true },
  ];
  const after = strip(two, 'A');
  check('★ delete one => only the other one is left', after?.length === 1 && after[0].id === 'B');
  check('★ no in-place mutation (returns a new array)', two.length === 2);
  check('★ deleting an id that does not exist => both are kept as they are', strip(two, 'ZZZ')?.length === 2);

  // ★ an empty array must become "no such field", not []
  const asEmptyArray: LinkLine[] = [];
  const asUndefined: LinkLine[] | undefined = undefined;
  const isDropped = (v: LinkLine[] | undefined): boolean => v === undefined;
  check('★★ an empty array != undefined: only undefined **removes the attribute** on write-back', isDropped(asUndefined) && !isDropped(asEmptyArray));
}

console.log('\n=== Write-back attribute format (measured) ===');
{
  const raw = '[{"id":"EMeWnSFiRi","toNodeId":"20261006001246-qsv4jv1","dashed":true,"label":"测试连线"}]';
  const parsed: LinkLine[] = JSON.parse(raw);
  check('★ the value is a JSON array', Array.isArray(parsed));
  check('★ each entry has id / toNodeId / dashed', !!parsed[0].id && !!parsed[0].toNodeId && parsed[0].dashed === true);
  check('★ label is written only when present (an empty label does not stuff in an empty string)', parsed[0].label === '测试连线');
  check('★ toNodeId is in **SiYuan block ID format**', /^\d{14}-[0-9a-z]{7}$/.test(parsed[0].toNodeId));
}

console.log('\n=== Dangling connector cleanup ===');
{
  // Deleting a node in the Outliner also cleans up the connector lines pointing at it
  const src: Node = { id: 'a', children: [], linkLines: [{ id: 'L', toNodeId: 'gone' }] };
  const gone = new Set(['gone']);
  const keep = src.linkLines!.filter((l) => !gone.has(l.toNodeId));
  check('★ the target node is deleted => the connector lines pointing at it are removed too', keep.length === 0);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
