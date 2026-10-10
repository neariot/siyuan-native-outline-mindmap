/**
 * The **order** of the structure dropdown must agree with the default value (regression test).
 *
 * ──────────────────────────────────────────────────────────────────
 * Why the order matters
 * ──────────────────────────────────────────────────────────────────
 *
 *  The default structure was changed from `'balanced'` (思维导图（左右）) to `'right'`
 * (逻辑图（向右）), but in the dropdown 「向右」 originally sat in **second** place.
 *
 * So an awkward state appeared: the first dropdown item read 「思维导图（左右）」,
 * while what actually took effect was the second item 「逻辑图（向右）」 ——
 * **the list order does not match the actual behavior**, so the user has to look at the dropdown every time to see which one is in use.
 *
 * This kind of inconsistency has no functional consequence, so no behavioral test would ever catch it,
 * and the order itself is the only thing that can be pinned down.
 */

export {};

import * as fs from 'node:fs';

import { layoutOrg, layoutHorizontal, type MmStructure } from '../core/layout';
import type { OutlineNode } from '../model/types';

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

const src = fs.readFileSync('src/mindmap/Mindmap.tsx', 'utf8');

/** Extract the order of the option values in the structure dropdown */
function structureOptionOrder(): string[] {
  const sel = src.indexOf('<select value={structure}');
  if (sel < 0) return [];
  const end = src.indexOf('</select>', sel);
  const block = src.slice(sel, end);
  return [...block.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
}

const order = structureOptionOrder();

console.log('① the structure dropdown can be located');

check('★ structure dropdown found', order.length > 0, 'select value={structure} not found');
check('★ the dropdown has 5 structure options', order.length === 5, `got ${order.length}: ${order.join(',')}`);

console.log('\n★★ 「向右」 comes first');

check(
  '★★ the first item is right (逻辑图（向右）)',
  order[0] === 'right',
  `got ${order[0]} —— order ${order.join(' → ')}`,
);

check(
  '★★ the former first item default (左右) moved down to second',
  order[1] === 'balanced',
  `got ${order[1]}`,
);

console.log('\n③ order agrees with the default');

{
  // Read the default value of initialStructure
  const m = src.match(/initialStructure\s*=\s*'([^']+)'/);
  const def = m?.[1] ?? '';
  check('★ default structure readable', !!def, 'initialStructure default value not found');
  check(
    '★★★ list first item === default structure (order agrees with behavior)',
    def === order[0],
    `default ${def} vs first item ${order[0]}`,
  );
}

console.log('\n④ all five options present, order sensible');

{
  const expect = ['right', 'balanced', 'left', 'org', 'timeline'];
  check(
    '★ the order is 向右 → 左右 → 向左 → 向下 → 交替',
    JSON.stringify(order) === JSON.stringify(expect),
    `got ${order.join(' → ')}`,
  );
  check('★ no duplicate items', new Set(order).size === order.length, order.join(','));
}

console.log('\n⑤ no two options may render identically (measured: treeRight ≡ right)');

{
  // ★  Measured: the former 「树形图（向右）」 (`treeRight`) and
  //   「逻辑图（向右）」 (`right`) had **identical per-box** layout fingerprints, i.e. two menu items with one effect,
  //   `treeRight` has been removed. This guards against another same-effect option sneaking in later.
  //
  //   The criterion is the **layout fingerprint** (each box id/x/y/w/h), not the name ——
  //   different names with the same fingerprint is the real duplication.
  // Build the tree with the helper: `modified` is a required field of OutlineNode,
  // hand-written literals easily omit it (tsc caught it twice; the tsx runtime does not check, so the test stayed green then).
  const N = (id: string, text: string, children: OutlineNode[] = []): OutlineNode =>
    ({ id, text: `<span>${text}</span>`, children, modified: 0 });
  const tree: OutlineNode[] = [
    N('root', '根', [
      N('a', '甲', [N('a1', '节点一'), N('a2', '节点二')]),
      N('b', '乙'),
      N('c', '丙', [N('c1', '节点十'), N('c2', '节点十一')]),
    ]),
  ];

  // ★ modes comes from the **real dropdown**, not a hand-written list ——
  //   hardcoding it means a structure added later (say treeRight coming back) never enters this check at all,
  //   so the "duplicate layout" check would miss exactly that one —— which is how it was missed during injection verification.
  const modes = order as MmStructure[];
  check('★ structure values read from the dropdown (for the duplicate check)', modes.length > 0, 'order is empty');
  const fp: Record<string, string> = {};
  for (const m of modes) {
    // ★ the production dispatch must be copied verbatim (Mindmap.tsx:427):
    //     structure === 'org' ? layoutOrg(...) : layoutHorizontal(...)
    //   Feeding 'org' straight into layoutHorizontal falls into its else branch and
    //   behaves like balanced, producing a **false duplicate** of "balanced ≡ org".
    const r = m === 'org' ? layoutOrg(tree, new Set()) : layoutHorizontal(tree, m, new Set());
    fp[m] = JSON.stringify(r.boxes.map((b) => [b.id, b.x, b.y, b.w, b.h]));
  }
  const ks = Object.keys(fp);
  let dup = '';
  for (let i = 0; i < ks.length; i++) {
    for (let j = i + 1; j < ks.length; j++) {
      if (fp[ks[i]] === fp[ks[j]]) dup = `${ks[i]} ≡ ${ks[j]}`;
    }
  }
  check('★★ no two structures render an identical layout', dup === '', dup || 'all pairwise distinct');

  check(
    '★ the removed treeRight no longer appears in the type',
    !/'treeRight'/.test(fs.readFileSync('src/core/layout.ts', 'utf8')),
  );
  check(
    '★ treeRight is absent from the dropdown too',
    !order.includes('treeRight'),
    order.join(','),
  );
}

console.log('\n⑥ labels must spell out the behavior, not lean on a chart-kind name');

{
  // ★ the former labels were compound chart names ("Mindmap (left/right) / Logic (left) / Logic (right)"),
  //   dressed up as three **chart kinds** when they are only growth directions of the same tree ——
  //   What exactly is the difference between "Logic chart" and "Mind map"? None.
  //
  //   They are now split into two groups by what the name is based on:
  //     one-way: right / left / down        —— it states the **direction**
  //     two-side: balanced / alternate      —— it states the **split rule**
  //
  //   Balanced and Alternate are a pair (both expand on two sides, differing only in how they split):
  //     balanced: find the split by child size (calcSplitIndex)
  //     timeline: alternate by index parity (idx % 2)
  //
  //   The assertion is about the **naming scheme**, not the exact wording —— swapping in a synonym should not turn the test red.
  const zh = JSON.parse(fs.readFileSync('src/plugin/i18n/zh_CN.json', 'utf8')) as Record<string, string>;
  const labels: Record<string, string> = {};
  for (const m of src.matchAll(/<option value="([^"]+)">\{t\('([^']+)'\)\}/g)) {
    labels[m[1]] = zh[m[2]];
  }
  const expect: Record<string, string> = {
    right: '向右', balanced: '平衡', left: '向左', org: '向下', timeline: '交替',
  };
  for (const [k, v] of Object.entries(expect)) {
    check(`★ the Chinese label for ${k} is "${v}"`, labels[k] === v, `got "${labels[k]}"`);
  }

  // No more chart-kind style names (mindmap/logic/tree/org...)
  // ★ only the **label text itself** is scanned, not the whole file ——
  //   a comment mentioning an old name is legitimate history,
  //   a whole-file scan would flag such remarks as violations too (hit before: that comment spot was a false positive).
  const kindWords = /思维导图|逻辑图|树形图|组织结构图|时间轴|鱼骨图/;
  const offending = Object.entries(labels).filter(([, v]) => kindWords.test(v));
  check(
    '★ none of the five labels uses a "XX图" chart-kind name',
    offending.length === 0,
    offending.map(([k, v]) => `${k}="${v}"`).join(', '),
  );
  check(
    '★ the five labels are pairwise distinct (otherwise indistinguishable options come back)',
    new Set(Object.values(expect)).size === 5,
  );
}

console.log('\n⑦ the structure value must no longer be named default (it also means "the default value", which misleads)');

{
  // ★ the name `'default'` carries two meanings: "left-right layout" and "the default value".
  //    The default is now `'right'`, so calling it default is purely misleading ——
  //   When writing this test I first assumed "default = the one that is default".
  // ★ This file is not in the list —— the detection regex below has to spell out that literal,
  //   so scanning itself would always match.
  const files = [
    'src/core/layout.ts',
    'src/core/layout.test.ts',
    'src/mindmap/Mindmap.tsx',
    'src/mindmap/structure-order.test.ts',
    'src/perf/baseline.test.ts',
  ];
  for (const f of files) {
    // Skip this file: the detection pattern itself writes that literal (see the comment on the files list).
    if (f === 'src/mindmap/structure-order.test.ts') continue;
    const txt = fs.readFileSync(f, 'utf8');
    check(
      `★ ${f} no longer contains the structure value 'default'`,
      !/'default'|value="default"/.test(txt),
      'the structure value should be named balanced',
    );
  }
  check(
    '★ the type definition lists balanced',
    /MmStructure\s*=\s*'balanced'\s*\|/.test(fs.readFileSync('src/core/layout.ts', 'utf8')),
  );
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nFailed checks:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}