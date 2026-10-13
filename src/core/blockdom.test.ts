/**
 * `src/core/blockdom.ts` unit tests.
 *
 * The **reason this module exists** is "never produce a blank line", so the tests focus on:
 *   ① whether paragraphs map one to one to `NodeParagraph` (not separated by blank lines)
 *   ② whether the hierarchy is complete (NodeList > NodeListItem > NodeParagraph)
 *   ③ whether every block has a valid ID
 *   ④ whether empty paragraphs / empty nodes / task state are produced correctly
 */
import type { OutlineNode } from '../model/types';
import { treeToBlockDom, paragraphBlockFragment } from './blockdom';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const n = (id: string, text: string, paragraphs?: string[], children: OutlineNode[] = [], taskStatus?: number): OutlineNode => ({
  id,
  modified: 1,
  text,
  paragraphs,
  children,
  taskStatus,
});

/** Count how many times a given data-type appears */
const count = (html: string, t: string): number =>
  (html.match(new RegExp(`data-type="${t}"`, 'g')) ?? []).length;

console.log('=== blank-line rule: never produce a blank line ===');
{
  const dom = treeToBlockDom([n('a', '根', ['附属段一', '附属段二'])]);
  // ★ This is the core promise of this module: the DOM must not contain blank lines used for separation
  check('DOM contains no consecutive newlines (no blank line)', !/\n\s*\n/.test(dom), JSON.stringify(dom.slice(0, 120)));
  check('DOM contains no newline at all', !dom.includes('\n'));
}

console.log('=== paragraphs map one to one ===');
{
  const dom = treeToBlockDom([n('a', '根', ['附属段一', '附属段二', '附属段三'])]);
  check('1 first paragraph + 3 attachment paragraphs = 4 NodeParagraph', count(dom, 'NodeParagraph') === 4, String(count(dom, 'NodeParagraph')));
  check('paragraph order is correct', dom.indexOf('根') < dom.indexOf('附属段一') && dom.indexOf('附属段一') < dom.indexOf('附属段二') && dom.indexOf('附属段二') < dom.indexOf('附属段三'));
}

console.log('=== hierarchy is complete (NodeList > NodeListItem > NodeParagraph) ===');
{
  const dom = treeToBlockDom([n('a', '根', ['附'])]);
  check('has an outer NodeList', count(dom, 'NodeList') === 1);
  check('has a NodeListItem', count(dom, 'NodeListItem') === 1);
  // NodeList must wrap NodeListItem (order criterion: List comes before ListItem)
  check('NodeList wraps NodeListItem', dom.indexOf('data-type="NodeList"') < dom.indexOf('data-type="NodeListItem"'));
}

console.log('=== every block has a valid ID ===');
{
  const dom = treeToBlockDom([n('a', '根', ['附'], [n('b', '子')])]);
  const ids = [...dom.matchAll(/data-node-id="([^"]*)"/g)].map((m) => m[1]);
  check('ID count == block count (List+ListItem+2 paragraphs+child List+child ListItem+child paragraph)', ids.length === 7, String(ids.length));
  check('no empty ID', ids.every((i) => i !== ''), ids.join(','));
  check('every ID matches the SiYuan format yyyyMMddHHmmss-7 chars', ids.every((i) => /^\d{14}-[0-9a-z]{7}$/.test(i)), ids.join(','));
}

console.log('=== empty paragraph / empty node ===');
{
  const emptyPara = treeToBlockDom([n('a', '根', [''])]);
  check('an empty attachment paragraph still produces NodeParagraph', count(emptyPara, 'NodeParagraph') === 2);
  check('an empty paragraph is filled with a zero-width placeholder', emptyPara.includes('\u200b'));

  const emptyNode = treeToBlockDom([n('a', '', ['空节点附属'])]);
  check('an empty node still produces NodeParagraph', count(emptyNode, 'NodeParagraph') === 2);
  check('an empty first paragraph is also filled with a placeholder', (emptyNode.match(/\u200b/g) ?? []).length >= 1);
}

console.log('=== nesting ===');
{
  const dom = treeToBlockDom([
    n('a', '根', ['根附属'], [n('b', '子', ['子附属'], [n('c', '孙', ['孙附属'])])]),
  ]);
  check('3 levels of nesting → 3 NodeList', count(dom, 'NodeList') === 3, String(count(dom, 'NodeList')));
  check('3 levels of nesting → 3 NodeListItem', count(dom, 'NodeListItem') === 3);
  check('3 levels of nesting → 6 NodeParagraph', count(dom, 'NodeParagraph') === 6, String(count(dom, 'NodeParagraph')));
  check('order: root → root-attachment → child → child-attachment → grandchild → grandchild-attachment',
    dom.indexOf('根附属') < dom.indexOf('子') &&
    dom.indexOf('子附属') < dom.indexOf('孙'));
}

console.log('=== sibling nodes ===');
{
  const dom = treeToBlockDom([n('a', '甲'), n('b', '乙'), n('c', '丙')]);
  check('3 siblings → 3 NodeListItem', count(dom, 'NodeListItem') === 3);
  check('only 1 NodeList (shared by siblings)', count(dom, 'NodeList') === 1);
  check('order: first→second→third', dom.indexOf('甲') < dom.indexOf('乙') && dom.indexOf('乙') < dom.indexOf('丙'));
}

console.log('=== task state (shape taken from the real kernel getBlockDOM output) ===');
{
  // ★ Once written wrong: assumed it had to produce a div with data-type="NodeTaskListItemMarker".
  //   It is actually expressed as "the listItem's data-task attribute + the protyle-action--task icon",
  //   See protyle.go:1620 (the atom.Input branch) on the Lute side.
  const todo = treeToBlockDom([n('a', '待办', ['说明'], [], 1)]);
  check('taskStatus=1 → data-task=" " (a space)', todo.includes('data-task=" "'));
  check('taskStatus=1 → subtype="t"', todo.includes('data-subtype="t"'));
  check('taskStatus=1 → has protyle-action--task', todo.includes('protyle-action--task'));
  check('taskStatus=1 → uses #iconUncheck', todo.includes('#iconUncheck'));
  check('taskStatus=1 → produces no NodeTaskListItemMarker div', !todo.includes('NodeTaskListItemMarker'));

  const done = treeToBlockDom([n('a', '完成', [], [], 2)]);
  check('taskStatus=2 → data-task="X"', done.includes('data-task="X"'));
  check('taskStatus=2 → uses #iconCheck', done.includes('#iconCheck'));
  check('taskStatus=2 → class contains protyle-task--done', done.includes('protyle-task--done'));

  const plain = treeToBlockDom([n('a', '普通')]);
  check('no taskStatus → no data-task attribute', !/data-task=/.test(plain));
  check('no taskStatus → subtype="u"', plain.includes('data-subtype="u"'));
  check('no taskStatus → uses #iconDot', plain.includes('#iconDot'));

  // Mixed: both tasks and plain items → the whole list is treated as non-task (subtype=u),
  // but a task item itself still keeps data-subtype="t"
  const mixed = treeToBlockDom([n('a', '普通'), n('b', '任务', [], [], 1)]);
  check('mixed → list subtype="u"', mixed.includes('data-subtype="u"'));
  check('mixed → the task item itself is still subtype="t"', mixed.includes('data-subtype="t"'));
}

console.log('=== inline styles (through htmlToSiyuanDom) ===');
{
  const dom = treeToBlockDom([n('a', '<b>粗</b>', ['<i>斜</i>'])]);
  check('the b tag becomes SiYuan strong', dom.includes('data-type="strong"'));
  check('the i tag becomes SiYuan em', dom.includes('data-type="em"'));
  check('no bare HTML tags are left behind', !/<b>|<i>/.test(dom));
}

console.log('=== single paragraph fragment (for updateBlock / insertParagraphAfter) ===');
{
  const p = paragraphBlockFragment('正文');
  check('produces NodeParagraph', p.includes('data-type="NodeParagraph"'));
  check('carries NO block ID —— the fragment is not a whole block', !p.includes('data-node-id'));
  const empty = paragraphBlockFragment('');
  check('empty content is filled with a placeholder', empty.includes('\u200b'));
  check('★ the fragment and a tree paragraph agree on the paragraph element',
    p.startsWith('<div data-type="NodeParagraph">') && p.endsWith('</div>'));
}

console.log('=== empty tree ===');
{
  const dom = treeToBlockDom([]);
  check('an empty array still produces a valid empty NodeList', dom.includes('data-type="NodeList"'));
  check('an empty array has no NodeListItem', count(dom, 'NodeListItem') === 0);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
