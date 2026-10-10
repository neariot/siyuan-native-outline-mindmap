/**
 * Note persistence semantics.
 *
 * A note is **not carried by any attribute** -- the body paragraphs are the data,
 * carried by the **native attached paragraphs** under the listItem (multiple `NodeParagraph`s).
 *
 * This file guards two semantics:
 *   ① attached paragraphs must really be written into the document (not merely exist in the in-memory model);
 *   ② the write-merge fingerprint must **include `paragraphs`** -- otherwise, when "only the
 *      attached paragraphs change but not the body", the catch-up write is skipped and the content is silently truncated.
 */
export {};

/** Fields in this plugin's model that this file cares about */
interface Node {
  id: string;
  text: string;
  paragraphs?: string[];
  summaryData?: unknown[];
  linkLines?: unknown[];
  children_?: Node[];
}

/**
 * Replicates the **non-body fields** part of `serializeTree` in mount (the fixed version).
 *
 * ★ Key: `paragraphs` must be part of the fingerprint, otherwise "only the attached paragraphs changed" is undetectable.
 */
function serializeTree(tree: Node[], includeAttrs: boolean): string {
  const parts: string[] = [];
  const walk = (l: Node[]): void => {
    for (const n of l) {
      parts.push(`${n.id}:${n.text ?? ''}`);
      if (includeAttrs) {
        parts.push(`${n.id}:paras=${JSON.stringify(n.paragraphs ?? [])}`);
        parts.push(`${n.id}:sum=${n.summaryData ? JSON.stringify(n.summaryData) : ''}`);
        parts.push(`${n.id}:lnk=${n.linkLines ? JSON.stringify(n.linkLines) : ''}`);
      }
      if (n.children_) walk(n.children_);
    }
  };
  walk(tree);
  return parts.join('\u0001');
}

/**
 * Replicates `syncParagraphs`' "should this paragraph be written" criterion.
 *
 * Only indexes **present on both sides** are compared; deleting the tail when the target is shorter is the caller's job.
 */
function parasToWrite(want: string[], existing: string[]): number[] {
  const norm = (s: string | undefined): string => (s ?? '').replace(/\u200b/g, '').trim();
  const out: number[] = [];
  const n = Math.min(existing.length, want.length);
  for (let i = 0; i < n; i++) {
    if (norm(existing[i]) === norm(want[i])) continue; // no change → do not write
    out.push(i);
  }
  return out;
}

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
};

console.log('=== Defect 3: the write-merge fingerprint must include attached paragraphs ===');
{
  // only the attached paragraphs change, the body stays the same -- before the fix the fingerprints matched and the catch-up write was skipped
  const before: Node[] = [{ id: 'n1', text: '甲', paragraphs: ['备'] }];
  const after: Node[] = [{ id: 'n1', text: '甲', paragraphs: ['备注文本一ABC'] }];

  check(
    '★ the fingerprint includes paragraphs → a "only the paragraphs changed" difference is detected',
    serializeTree(before, true) !== serializeTree(after, true),
  );
  // reverse control: the old fingerprint without the field detects nothing (this was exactly the original bug)
  check(
    '(control) the fingerprint without paragraphs → the change is not detected (regression case)',
    serializeTree(before, false) === serializeTree(after, false),
  );
  check(
    'a body change is of course detected',
    serializeTree([{ id: 'n1', text: '甲' }], true) !==
      serializeTree([{ id: 'n1', text: '乙' }], true),
  );
  check(
    'adding and removing paragraphs is detected as well',
    serializeTree([{ id: 'n1', text: '甲', paragraphs: ['a'] }], true) !==
      serializeTree([{ id: 'n1', text: '甲', paragraphs: ['a', 'b'] }], true),
  );
  check(
    'a paragraph change inside a child node is detected as well',
    serializeTree([{ id: 'p', text: 'P', children_: [{ id: 'c', text: 'C', paragraphs: ['1'] }] }], true) !==
      serializeTree([{ id: 'p', text: 'P', children_: [{ id: 'c', text: 'C', paragraphs: ['2'] }] }], true),
  );
}

console.log('\n=== Write-back criterion for paragraph blocks (write only the ones that differ) ===');
{
  check('same content → do not write (saves a transaction)', parasToWrite(['甲'], ['甲']).length === 0);
  check('different content → write', parasToWrite(['甲'], ['乙']).length === 1);
  check(
    'a zero-width placeholder counts as empty (SiYuan stores an empty paragraph as \\u200b)',
    parasToWrite([''], ['\u200b']).length === 0,
  );
  check('leading and trailing whitespace does not affect equality', parasToWrite(['  甲  '], ['甲']).length === 0);
  check(
    'a double zero-width placeholder also counts as empty',
    parasToWrite(['', ''], ['\u200b', '\u200b']).length === 0,
  );
  check(
    '★ an empty paragraph is not filtered out (empty attached paragraphs must be supported)',
    parasToWrite(['', '甲'], ['\u200b', '乙']).length === 1,
  );
}

console.log('\n=== Adding and removing multiple paragraphs (position alignment) ===');
{
  check('2→3 paragraphs: no rewrite when the first two do not differ', parasToWrite(['甲', '乙', '丙'], ['甲', '乙']).length === 0);

  const w2 = parasToWrite(['A', 'B', 'C'], ['甲', '乙']);
  check('the two paragraphs that differ are listed', w2.length === 2 && w2[0] === 0 && w2[1] === 1, JSON.stringify(w2));

  check(
    '3→1 paragraphs: only paragraph 1 is handled (the rest is deleted from the tail by the caller)',
    parasToWrite(['A'], ['甲', '乙', '丙']).length === 1,
  );
  check(
    'order-sensitive: a positional mismatch must be rewritten (no dedupe as a set)',
    parasToWrite(['乙', '甲'], ['甲', '乙']).length === 2,
  );
}

console.log('\n=== No attribute may carry a note any more ===');
{
  const fs = require('fs');
  const strip = (x: string): string =>
    x.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  const store = strip(fs.readFileSync('src/siyuan/store.ts', 'utf8'));
  const mount = strip(fs.readFileSync('src/plugin/mount.ts', 'utf8'));
  const map = strip(fs.readFileSync('src/core/map.ts', 'utf8'));

  check('store.ts no longer writes a memo attribute', !/['"]memo['"]/.test(store));
  check('store.ts no longer reads a memo attribute', !/name === ['"]memo['"]/.test(store));
  check('map.ts no longer writes a memo= attribute', !/memo=/.test(map));
  check('the mount.ts fingerprint now uses paragraphs', /paras=/.test(mount));
  check('mount.ts no longer uses a note= fingerprint', !/:note=/.test(mount));
}

console.log('\n=== Merge operations must be symmetric forwards and backwards ===');
{
  // ★ A pair of reverse operations must both be checked for branch completeness (a defect class this project has hit repeatedly).
  //   The two directions of merging a node: mergeWithPrev (Backspace at line start, swallowed by the previous one)
  //   and mergeWithNext (Delete at line end, swallowing the next one).
  //   If mergeWithNext merges **only text/children**,
  //   then "merging forward" **silently discards** the next node's note while "merging backward" keeps it --
  //   the same action loses data when the direction changes.
  const fs = require('fs');
  const strip = (x: string): string =>
    x.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  /** Take the body of a merge function (up to the next top-level const) */
  const bodyOf = (src: string, fn: string): string => {
    const i = src.indexOf(`const ${fn} = (`);
    if (i < 0) return '';
    const rest = src.slice(i + 10);
    let end = rest.length;
    for (const mark of ['\n  const ', '\n  /**', '\n  // ----']) {
      const k = rest.indexOf(mark);
      if (k > 0 && k < end) end = k;
    }
    return strip(rest.slice(0, end));
  };

  // Only the plugin's outline implementation is checked here,
  //   but that file has been deleted as dead code (it is not in the plugin's reference chain). Only this one implementation is left.
  //   If a second implementation shows up in the future, be sure to add it back to this list -- otherwise the same
  //   "asymmetric reverse operation" bug silently reappears in the new implementation.
  for (const file of ['src/plugin/outline/Outliner.tsx']) {
    const src = fs.readFileSync(file, 'utf8');
    const prev = bodyOf(src, 'mergeWithPrev');
    const next = bodyOf(src, 'mergeWithNext');
    const label = file.replace('src/', '');

    check(`${label}: mergeWithPrev merges paragraphs`, /paragraphs/.test(prev));
    check(`${label}: mergeWithNext merges paragraphs`, /paragraphs/.test(next));
    check(
      `${label}: both merge text`,
      /\.text = \(/.test(prev) && /\.text = \(/.test(next),
    );
    check(
      `${label}: both merge children`,
      /children\.push/.test(prev) && /children\.push/.test(next),
    );
  }
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
