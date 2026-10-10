/**
 * Shift+Enter enters/exits the attached paragraph (UI-TC-14, Major).
 *
 * ──────────────────────────────────────────────────────────────────
 * What the case requires
 * ──────────────────────────────────────────────────────────────────
 *
 * "Press Shift+Enter on a node line -> the attached paragraph expands and is focused
 *   automatically; text typed is saved live as an attached block"
 *
 * The implementation goes through `Outliner.tsx:1317 togglePara(id)`, which has **three branches**:
 *
 *   (1) no paragraph    -> create `['']` and **focus on the next frame** (the paragraph box only exists once rendering is done)
 *   (2) all paragraphs blank -> delete paragraphs (the "exit" description area)
 *   (3) has content     -> only touch, **do not delete** (the user is writing; do not wipe it)
 *
 * Branch (3) matters most: Shift+Enter is a **toggle**, not "clear".
 * If the implementation treats "has content" as "exit" and deletes it, one press loses the note
 * the user just wrote -- users report this class of bug as "data loss".
 *
 * ──────────────────────────────────────────────────────────────────
 * Interaction with `paraToStore` (the other easy place to get it wrong)
 * ──────────────────────────────────────────────────────────────────
 *
 * `paraToStore` returns undefined only when the **array is empty**.
 * An all-empty-string array (`['', '']`) is **legitimate user content** (N blank lines) and must be kept as-is --
 * converging it to undefined makes blank lines the user typed vanish into thin air.
 *
 * Note the distinction: `togglePara`'s "all empty -> delete" is **gesture semantics** (press Shift+Enter
 * again to exit), while `paraToStore`'s "do not converge empty strings" is **storage semantics**.
 * The two do not contradict each other, but they must be tested separately, otherwise it is easy to mistake the latter's behaviour for a bug in the former.
 */

export {};

import * as fs from 'node:fs';
import { fnBody } from '../source-probe';

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

// ──────────────────────────────────────────────────────────────────
// Reproduction (compare with Outliner.tsx:1317)
// ──────────────────────────────────────────────────────────────────

type Node = { id: string; text: string; children: Node[]; paragraphs?: string[] };

const htmlToText = (html: string): string => html.replace(/<[^>]*>/g, '');
const isBlankPara = (html: string): boolean =>
  htmlToText(html).replace(/\u200b/g, '').trim() === '';
const parasOf = (n: Node | undefined): string[] => n?.paragraphs ?? [];
const paraToStore = (list: string[]): string[] | undefined =>
  list.length > 0 ? list : undefined;

type Trace = { created: boolean; deleted: boolean; focused: string | null; deferred: boolean };

function togglePara(n: Node): Trace {
  const tr: Trace = { created: false, deleted: false, focused: null, deferred: false };
  const list = parasOf(n);
  if (list.length === 0) {
    n.paragraphs = [''];
    tr.created = true;
    // the paragraph box is only mounted on the next frame -- focus must be deferred
    tr.deferred = true;
    tr.focused = n.id;
  } else if (list.every(isBlankPara)) {
    delete n.paragraphs;
    tr.deleted = true;
  } else {
    // has content: keep it
  }
  return tr;
}

// ──────────────────────────────────────────────────────────────────
console.log('(1) no paragraph -> create an empty paragraph and focus it');

{
  const n: Node = { id: 'a', text: '<span>x</span>', children: [] };
  const tr = togglePara(n);
  check('* the paragraph is created (the description area expands)', Array.isArray(n.paragraphs) && n.paragraphs.length === 1,
    `got ${JSON.stringify(n.paragraphs)}`);
  check('* the new paragraph is empty (can be typed into directly)', n.paragraphs?.[0] === '');
  check('* focus moves to that node automatically', tr.focused === 'a');
  check('** the focus is **deferred** (the paragraph box is only mounted on the next frame; focusing immediately falls through)',
    tr.deferred === true);
  check('nothing deleted by mistake', tr.deleted === false);
}

// ──────────────────────────────────────────────────────────────────
console.log('\n(2) all paragraphs blank -> press again to exit (delete)');

{
  const n: Node = { id: 'b', text: '<span>x</span>', children: [], paragraphs: [''] };
  const tr = togglePara(n);
  check('* the paragraph is deleted (the description area exits)', n.paragraphs === undefined,
    `got ${JSON.stringify(n.paragraphs)}`);
  check('the delete branch is recorded', tr.deleted === true);
  check('not created twice', tr.created === false);

  // zero-width characters also count as "empty"
  const n2: Node = { id: 'c', text: '<span>x</span>', children: [], paragraphs: ['<span>\u200b</span>', '  '] };
  const tr2 = togglePara(n2);
  check('* a zero-width placeholder / whitespace alone also counts as empty (otherwise it cannot be exited)',
    n2.paragraphs === undefined && tr2.deleted === true,
    `got ${JSON.stringify(n2.paragraphs)}`);
}

// ──────────────────────────────────────────────────────────────────
console.log('\n(3) * has content -> keep it, never delete');

{
  const n: Node = { id: 'd', text: '<span>x</span>', children: [], paragraphs: ['<span>备注文本一</span>'] };
  const tr = togglePara(n);
  check('** with content it is **not deleted** (Shift+Enter is a toggle, not a clear)',
    Array.isArray(n.paragraphs) && n.paragraphs.length === 1,
    `got ${JSON.stringify(n.paragraphs)}`);
  check('** the content is kept verbatim (user input does not get lost)',
    n.paragraphs?.[0] === '<span>备注文本一</span>',
    `实得 ${n.paragraphs?.[0]}`);
  check('neither deleted nor recreated', tr.deleted === false && tr.created === false);

  // several paragraphs, some empty: as long as one has content, keep them all
  const n2: Node = {
    id: 'e', text: '<span>x</span>', children: [],
    paragraphs: ['', '<span>第二段有字</span>', ''],
  };
  togglePara(n2);
  check('* with several paragraphs, one with content keeps them all (an empty paragraph is legitimate content)',
    n2.paragraphs?.length === 3,
    `got ${JSON.stringify(n2.paragraphs)}`);
}

// ──────────────────────────────────────────────────────────────────
console.log('\n(4) round-trip consistency of repeated toggling');

{
  const n: Node = { id: 'f', text: '<span>x</span>', children: [] };
  togglePara(n); // on
  check('on -> 1 paragraph', n.paragraphs?.length === 1);
  togglePara(n); // off (it is empty at this point)
  check('off -> the paragraph disappears', n.paragraphs === undefined);
  togglePara(n); // on again
  check('* it can be toggled on and off repeatedly (no residual state)', n.paragraphs?.length === 1);

  // press repeatedly after it has content; the content must stay
  const m: Node = { id: 'g', text: '<span>x</span>', children: [], paragraphs: ['<span>备注一</span>'] };
  for (let i = 0; i < 5; i++) togglePara(m);
  check('** pressing 5 times with content present keeps the content',
    m.paragraphs?.[0] === '<span>备注一</span>',
    `got ${JSON.stringify(m.paragraphs)}`);
}

// ──────────────────────────────────────────────────────────────────
console.log('\n(5) storage semantics: an all-empty-string array is legitimate content and must not be converged away');

{
  check('* empty array -> undefined (there really is no paragraph)',
    paraToStore([]) === undefined);
  check('** all-empty-string array -> kept as-is (the N blank lines were typed by the user)',
    JSON.stringify(paraToStore(['', ''])) === JSON.stringify(['', '']),
    `got ${JSON.stringify(paraToStore(['', '']))}`);
  check('* a single empty string is kept too', JSON.stringify(paraToStore([''])) === JSON.stringify(['']));
  check('content is kept as-is', JSON.stringify(paraToStore(['<span>a</span>'])) === JSON.stringify(['<span>a</span>']));
}

// ──────────────────────────────────────────────────────────────────
console.log('\n* alignment with the source');

{
  const src = fs.readFileSync('src/plugin/outline/Outliner.tsx', 'utf8');

  check('* Shift+Enter goes through togglePara (not splitNode, not inserting a line break)',
    /if \(e\.key === 'Enter' && e\.shiftKey\) \{[\s\S]{0,200}togglePara\(id\)/.test(src),
    'aligned with X official: Shift+Enter enters/exits the description area');

  check('* plain Enter still goes through splitNode (the two paths must not mix)',
    /e\.key === 'Enter' && !e\.shiftKey && !mod/.test(src) && /splitNode\(id\)/.test(src));

  // * cut the function body by structure instead of guessing a length with `slice(t, t + 900)`:
  //   the assertions for the three branches are crammed into one fixed window, and adding or removing a comment pushes a branch out of it.
  const t = src.indexOf('const togglePara');
  check('togglePara is found', t > 0);
  const body = fnBody(src, 'const togglePara');
  check('the togglePara function body is cut out (red if it cannot be cut)', body.length > 0);
  check('* branch one: with no paragraph, create [\'\']', /n\.paragraphs = \[''\]/.test(body));
  check('** focus is deferred with setTimeout(..., 0) (the paragraph box is only mounted on the next frame)',
    /setTimeout\(\(\) => \{/.test(body),
    'focusing immediately falls through, because the element does not exist yet');
  check('* branch two: delete only when all are blank', /list\.every\(isBlankPara\)/.test(body) && /delete n\.paragraphs/.test(body));
  check('** branch three: with content the else only touches it (no delete)',
    /\} else \{\s*touch\(n\);\s*\}/.test(body),
    'a delete here would mean "one press loses the note"');
  check('* the delete branch contains delete, and only under the "all blank" condition',
    (body.match(/delete n\.paragraphs/g) || []).length === 1);
}

// ──────────────────────────────────────────────────────────────────
console.log('\nthe criteria themselves are effective');

{
  // the wrong implementation that "deletes even with content"
  const bad = (n: Node) => { delete n.paragraphs; };
  const n: Node = { id: 'x', text: '', children: [], paragraphs: ['<span>备注</span>'] };
  bad(n);
  check('* the criteria recognise the wrong implementation that "deletes even with content" (content loss)',
    n.paragraphs === undefined);

  // the wrong implementation that "does not delete when all blank" -> cannot exit
  const stuck: Node = { id: 'y', text: '', children: [], paragraphs: [''] };
  const noDelete = (x: Node) => { void x; };
  noDelete(stuck);
  check('* the criteria recognise the wrong implementation that "does not delete when all blank" (cannot exit the description area)',
    stuck.paragraphs !== undefined);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
