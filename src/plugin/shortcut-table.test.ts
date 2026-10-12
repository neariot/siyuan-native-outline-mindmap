// The shortcut panel's table **shape** —— the check `docs/pitfalls/editor.md` 6.9bb says was missing.
//
// ## Why the check that existed could not see the defect
//
// The panel renders `SHORTCUTS` group by group. The only assertion about it compared "every key the help
// text names" against "every key the code implements" —— one list against one list. That is blind to both
// failures the entry records:
//
//   * **a count that drifts**: entries were added to the table after the case was written and nothing went
//     red, because the assertion never looked at how many there were;
//   * **a panel that renders nothing**: a table with entries but a broken render is invisible to an
//     assertion that only reads the table's key names and never compares the rendered surface.
//
// So this file pins the shape: the number of groups, the number of entries, and that every entry is
// well-formed (a non-empty `keys` and a non-empty `desc`, and no duplicate key set). Change the table and
// this goes red —— which is the point, because the alternative is a number in a document going stale
// without failing anything.
//
// ★ The counts are a **measurement with a date, not a constant**: measured 2026-10-12, 5 groups / 26
//   entries. When the table legitimately grows, update both here and `docs/SHORTCUTS.md` —— the failure
//   message says so, so the next person is not left guessing whether the test or the table is wrong.
//
// Run: node .tmp/t28/out/plugin/shortcut-table.test.js

import { SHORTCUTS } from './outline/Outliner';

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

// ---------------------------------------------------------------- the shape

check('the table is not empty', SHORTCUTS.length > 0);

check(
  'group count matches the measurement',
  SHORTCUTS.length === 5,
  `expected 5 groups (measured 2026-10-12), got ${SHORTCUTS.length}. If the table legitimately changed, ` +
    'update this number and docs/SHORTCUTS.md together.',
);

const entries = SHORTCUTS.flatMap((g) => g.items);

check(
  'entry count matches the measurement',
  entries.length === 26,
  `expected 26 entries (measured 2026-10-12), got ${entries.length}. If the table legitimately changed, ` +
    'update this number and docs/SHORTCUTS.md together.',
);

// ---------------------------------------------------------------- every entry is renderable

const namelessGroups = SHORTCUTS.filter((g) => !g.group || !g.group.trim());
check(
  'every group has a non-empty label',
  namelessGroups.length === 0,
  `${namelessGroups.length} group(s) with an empty label —— the panel renders the label as a heading`,
);

const badKeys = entries.filter((it) => !it.keys || !it.keys.trim());
check(
  'every entry names a key',
  badKeys.length === 0,
  `${badKeys.length} entry/entries with empty \`keys\` —— the panel would render a blank key cell`,
);

const badDesc = entries.filter((it) => !it.desc || !it.desc.trim());
check(
  'every entry has a description',
  badDesc.length === 0,
  `${badDesc.length} entry/entries with an empty \`desc\` —— the panel would render an empty cell`,
);

// ★ A group with no items renders as a heading with nothing under it, which is what "correct but renders
//   nothing" looks like at the group level.
const emptyGroups = SHORTCUTS.filter((g) => g.items.length === 0);
check(
  'no group is empty',
  emptyGroups.length === 0,
  `${emptyGroups.length} group(s) with no entries: ${emptyGroups.map((g) => g.group).join(', ')}`,
);

// ---------------------------------------------------------------- the labels are translated, not literals

// ★ Every label is routed through `t()`, and in a unit test that is *visible*: SiYuan is not there, so
//   `lookup` is unset and `t()` returns the key itself (measured —— see the first run of this file, where
//   every label came back as `skGroupEdit`, `skNewSibling`, …). So the values here looking like keys is the
//   expected, correct outcome, not a defect, and an assertion that they are "real text" would be testing the
//   wrong layer.
//
//   What this layer can prove is the shape of the routing: each label is a single `sk…` catalogue key, which
//   is what `t()` was called with. That the key **exists in both catalogues** is a different question, and
//   `scripts/check-i18n-keys.py` answers it against the real JSON —— one gate per layer, neither guessing at
//   the other's job.
const labels = [...SHORTCUTS.map((g) => g.group), ...entries.flatMap((it) => [it.desc])];
const notCatalogueKeys = labels.filter((s) => !/^sk[A-Za-z0-9]+$/.test(s));
check(
  'every label is an `sk…` catalogue key (the shape `t()` is called with)',
  notCatalogueKeys.length === 0,
  `these do not look like catalogue keys: ${notCatalogueKeys.join(', ')}`,
);

// ---------------------------------------------------------------- duplicates

// Two entries with the same key set within one group is almost always a copy-paste that lost its meaning.
const perGroupDupes: string[] = [];
for (const g of SHORTCUTS) {
  const seen = new Set<string>();
  for (const it of g.items) {
    const k = `${g.group}::${it.keys}`;
    if (seen.has(k)) perGroupDupes.push(k);
    seen.add(k);
  }
}
check(
  'no duplicate key inside a group',
  perGroupDupes.length === 0,
  `duplicated: ${perGroupDupes.join(', ')}`,
);

// ---------------------------------------------------------------- report

console.log(`shortcut-table: ${pass} passed, ${fail} failed`);
if (fail) {
  console.error(failures.map((f) => `  ✘ ${f}`).join('\n'));
  process.exit(1);
}
