/**
 * Behavior verification for `extractDeletions`.
 *
 * Background: only update transactions used to be parsed, **delete was not handled at all** ——
 * the user deletes a list item in SiYuan, the node does not disappear from the mind map (ghost node),
 * and clicking it again writes that ghost back into SiYuan.
 *
 * The message shape is taken from a measured capture (.tmp/t31/capture-del.py):
 * {"action":"delete","data":null,"id":"<listItem block ID>","rootID":""}
 */
import { extractDeletions, extractUpdates } from './sync';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
};

const tx = (ops: unknown[]): unknown => ({ transactions: [{ doOperations: ops }] });

// ── basic: parse the block ID of a delete ──
{
  const raw = tx([{ action: 'delete', data: null, id: 'blk-1', rootID: '' }]);
  const d = extractDeletions(raw);
  check('a single delete: block ID is parsed out', d.size === 1 && d.has('blk-1'));
}

// ── several deletes ──
{
  const raw = tx([
    { action: 'delete', data: null, id: 'b1' },
    { action: 'delete', data: null, id: 'b2' },
  ]);
  const d = extractDeletions(raw);
  check('several deletes: all are parsed', d.size === 2 && d.has('b1') && d.has('b2'));
}

// ── ★ an update must not be taken for a delete ──
{
  const raw = tx([{ action: 'update', data: '<div contenteditable="true">x</div>', id: 'b9' }]);
  const d = extractDeletions(raw);
  check('★ an update transaction does not count as a deletion', d.size === 0);
}

// ── ★ a delete must not be taken for an update either (data is null) ──
{
  const raw = tx([{ action: 'delete', data: null, id: 'b7' }]);
  const u = extractUpdates(raw);
  check('★ a delete transaction produces no text update', u.size === 0);
}

// ── mixed transaction ──
{
  const raw = tx([
    { action: 'update', data: '<div contenteditable="true">甲改</div>', id: 'p1' },
    { action: 'delete', data: null, id: 'i1' },
    { action: 'insert', data: '<div>新</div>', id: 'n1' },
  ]);
  const d = extractDeletions(raw);
  const u = extractUpdates(raw);
  check('mixed transaction: only deletes are taken', d.size === 1 && d.has('i1'));
  check('mixed transaction: only updates are taken', u.size === 1 && u.has('p1'));
}

// ── string form (the kernel sometimes pushes a JSON string) ──
{
  const raw = JSON.stringify({ transactions: [{ doOperations: [{ action: 'delete', data: null, id: 'sb' }] }] });
  const d = extractDeletions(raw);
  check('a message in string form is parsed too', d.size === 1 && d.has('sb'));
}

// ── array form ──
{
  const raw = [{ doOperations: [{ action: 'delete', data: null, id: 'ab' }] }];
  const d = extractDeletions(raw);
  check('a message in array form is parsed too', d.size === 1 && d.has('ab'));
}

// ── robustness ──
{
  check('null does not crash', extractDeletions(null).size === 0);
  check('an invalid JSON string does not crash', extractDeletions('{不是 json').size === 0);
  check('an empty object does not crash', extractDeletions({}).size === 0);
  check('a null doOperations does not crash', extractDeletions({ transactions: [{ doOperations: null }] }).size === 0);
  check('a delete without an id is ignored', extractDeletions(tx([{ action: 'delete', data: null }])).size === 0);
}

// ── repeated deletes of the same block are deduplicated ──
{
  const raw = tx([
    { action: 'delete', data: null, id: 'dup' },
    { action: 'delete', data: null, id: 'dup' },
  ]);
  check('repeated deletes are deduplicated', extractDeletions(raw).size === 1);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
