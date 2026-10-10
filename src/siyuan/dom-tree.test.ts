import { parseDomToTree } from './dom-tree';

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

console.log('=== dom-tree: DOM parsing tests ===');

{
  const html = `
    <div data-node-id="list-root" data-type="NodeList">
      <div data-node-id="li-1" data-type="NodeListItem">
        <div class="protyle-action"></div>
        <div data-node-id="p-1" data-type="NodeParagraph">
          <div contenteditable="true">节点1</div>
        </div>
        <div data-node-id="list-sub" data-type="NodeList">
          <div data-node-id="li-1-1" data-type="NodeListItem">
            <div data-node-id="p-1-1" data-type="NodeParagraph">
              <div>子节点1-1</div>
            </div>
          </div>
          <div data-node-id="li-1-2" data-type="NodeListItem">
            <div data-node-id="p-1-2" data-type="NodeParagraph">
              <div>子节点1-2</div>
            </div>
          </div>
        </div>
      </div>
      <div data-node-id="li-2" data-type="NodeListItem">
        <div data-node-id="p-2" data-type="NodeParagraph">
          <div>节点2</div>
        </div>
      </div>
    </div>
  `;

  const tree = parseDomToTree(html, 'doc-1');

  check('top-level list recognised', tree.topListId === 'list-root');
  check('paragraph block mapping recognised: li-1 -> p-1', tree.itemToParagraph.get('li-1') === 'p-1');
  check('paragraph block mapping recognised: li-1-1 -> p-1-1', tree.itemToParagraph.get('li-1-1') === 'p-1-1');
  check('paragraph block mapping recognised: li-1-2 -> p-1-2', tree.itemToParagraph.get('li-1-2') === 'p-1-2');
  check('paragraph block mapping recognised: li-2 -> p-2', tree.itemToParagraph.get('li-2') === 'p-2');

  check('child list recognised: li-1 -> list-sub', tree.itemToChildList.get('li-1') === 'list-sub');
  check('node without a child list: li-2 is empty', tree.itemToChildList.get('li-2') === undefined);

  check('parent mapping: list-root -> doc-1', tree.parentOf.get('list-root') === 'doc-1');
  check('parent mapping: li-1 -> list-root', tree.parentOf.get('li-1') === 'list-root');
  check('parent mapping: li-2 -> list-root', tree.parentOf.get('li-2') === 'list-root');
  check('parent mapping: list-sub -> li-1', tree.parentOf.get('list-sub') === 'li-1');
  check('parent mapping: li-1-1 -> list-sub', tree.parentOf.get('li-1-1') === 'list-sub');
  check('parent mapping: li-1-2 -> list-sub', tree.parentOf.get('li-1-2') === 'list-sub');

  const rootChildren = tree.childrenOf.get('list-root');
  check('top-level child order is correct', JSON.stringify(rootChildren) === JSON.stringify(['li-1', 'li-2']));

  const subChildren = tree.childrenOf.get('list-sub');
  check('child list item order is correct', JSON.stringify(subChildren) === JSON.stringify(['li-1-1', 'li-1-2']));

  check('the alive set is complete', tree.aliveIds.has('li-1') && tree.aliveIds.has('p-1-2') && tree.aliveIds.has('list-sub'));
}

{
  const empty = parseDomToTree('', 'doc-empty');
  check('an empty DOM does not throw', empty.topListId === '');
  check('empty DOM: aliveIds is empty', empty.aliveIds.size === 0);
  check('empty DOM: emptyRootParagraphs is empty', empty.emptyRootParagraphs.length === 0);
}

{
  // The real structure of a freshly created empty SiYuan document: one NodeParagraph with no content
  const blankDocDom = `<div data-node-id="p-empty-1" data-node-index="1" data-type="NodeParagraph" class="p"><div contenteditable="true"></div><div class="protyle-attr">​</div></div>`;
  const tree = parseDomToTree(blankDocDom, 'doc-blank');
  check('the blank paragraph of a freshly created SiYuan document is recognised', tree.emptyRootParagraphs.length === 1 && tree.emptyRootParagraphs[0] === 'p-empty-1');
  check('with no list, topListId is empty', tree.topListId === '');
}

{
  // A paragraph with real body text must not be recognised as a blank paragraph
  const textDocDom = `<div data-node-id="p-text-1" data-node-index="1" data-type="NodeParagraph" class="p"><div contenteditable="true">已有正文</div></div>`;
  const tree = parseDomToTree(textDocDom, 'doc-text');
  check('a paragraph with body text does not count as a blank paragraph', tree.emptyRootParagraphs.length === 0);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nfailures:');
  failures.forEach((f) => console.log('  ❌ ' + f));
  process.exit(1);
}
