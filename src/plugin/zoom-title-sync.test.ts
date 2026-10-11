/**
 * Local view (zoom) wiring, and the two representations of a document title must stay in sync.
 *
 * Corresponds to .logs/API-GOTCHAS.md §96 / §97.
 *
 * ★ Both defects are the same shape: **a callback that is never given a value** (`onZoomChange` missing from
 *   the props, the heading block never written), where the optional chain or the missing write swallows the
 *   failure silently —— the menu opens and clicking does nothing, or the new title is visible until the
 *   document is reopened and then the old one is back.
 *
 * ★ This file used to model both: an `OutlinerProps` interface written inside the test plus
 *   `renderOutliner(withZoomProps: boolean)` deciding the wiring **from its own boolean**, and a
 *   `changeTitleNew(d, next)` that "writes both places". Its own inputs were its own answer, so the real
 *   question —— does `mount.ts` pass these props, and does the rename write the heading block —— could not be
 *   asked. It is asked here: the props are read off the two `React.createElement` call sites, and both title
 *   writes are driven through the real `SiYuanStore` over a recording fake client.
 */
export {};

import fs from 'node:fs';
import path from 'node:path';
import { SiYuanClient } from '../siyuan/api';
import { SiYuanStore, titleFromKramdown } from '../siyuan/store';
import { callArgProps, createElementProps, enclosingBody } from './source-probe';

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

const mountSrc = fs.readFileSync(path.join(__dirname, 'mount.ts'), 'utf8');

console.log('=== §96 a view without the zoom props has dead zoom UI ===');
{
  // ★★ Both views, because that is how this defect presented twice: `Outliner` was wired, `Mindmap` was
  //    missed, and the optional chain made the miss silent (measured: the menu opened, nothing moved).
  for (const component of ['Outliner', 'Mindmap'] as const) {
    const els = createElementProps(mountSrc, component);
    check(`★★ ${component} is rendered once (precondition)`, els.length === 1, `got=${els.length}`);
    check(`★★★ ${component} receives both zoom props`,
      els[0]?.props.includes('zoomId') === true && els[0]?.props.includes('onZoomChange') === true,
      JSON.stringify(els[0]?.props.filter((p) => /zoom/i.test(p))));
    check(`★ ${component} does not receive them through a spread (so the list above is the whole story)`,
      els[0]?.spreads.length === 0, JSON.stringify(els[0]?.spreads));
  }

  // …and both are handed the **same** state, so switching view keeps the local view.
  const values = callArgProps(mountSrc, /createElement$/, 'zoomId').map((v) => v.value);
  check('★★ both views are given the same zoom state, not a copy',
    values.length === 2 && values.every((v) => v === 'zoomId'), JSON.stringify(values));

  // Why a missing prop is silent rather than loud: the call site is optional.
  const outlinerSrc = fs.readFileSync(path.join(__dirname, 'outline', 'Outliner.tsx'), 'utf8');
  check('★★ the call site is optional, which is exactly why the wiring has to be checked',
    outlinerSrc.includes('onZoomChange?.('), 'a missing prop would otherwise raise');
}

console.log('\n=== §97 the title lives in two places, and a rename must write both ===');
{
  const body = enclosingBody(mountSrc, 'await store?.renameDoc(docId, name);');
  check('★ the rename path was found (precondition)', body.length > 100, `len=${body.length}`);
  check('★★★ it writes the heading block as well, or the new title survives only until the next load',
    body.includes('setHeadingTitle'), body.slice(0, 160));
  check('★ the document name is changed through the kernel rename API (not an attribute write)',
    body.includes('renameDoc('));
}

const H1 = '20260101000000-h000001';

/** Records what the store asks the kernel to do. */
class RecordingClient {
  calls: Array<{ method: string; args: unknown[] }> = [];
  headingId: string | null = H1;
  async sql<T>(stmt: string, _limit?: number): Promise<T[]> {
    this.calls.push({ method: 'sql', args: [stmt] });
    if (stmt.includes("type='h'")) return (this.headingId ? [{ id: this.headingId }] : []) as unknown as T[];
    return [];
  }
  async renameDoc(id: string, title: string): Promise<null> {
    this.calls.push({ method: 'renameDoc', args: [id, title] });
    return null;
  }
  async updateBlock(id: string, data: string): Promise<null> {
    this.calls.push({ method: 'updateBlock', args: [id, data] });
    return null;
  }
  async setBlockAttrs(id: string, attrs: Record<string, string>): Promise<null> {
    this.calls.push({ method: 'setBlockAttrs', args: [id, attrs] });
    return null;
  }
  async getBlockDOM(_id: string): Promise<{ dom: string }> {
    return { dom: '' };
  }
  async getBlockKramdown(_id: string): Promise<string> {
    return '';
  }
}

const mkStore = (c: RecordingClient): SiYuanStore =>
  new SiYuanStore({ client: c as unknown as SiYuanClient, notebook: 'nb', basePath: '/x' });

async function main(): Promise<void> {
  {
    const c = new RecordingClient();
    await mkStore(c).renameDoc('doc1', 'NewName');
    check('★★ renaming goes through the kernel\'s rename API',
      c.calls.length === 1 && c.calls[0].method === 'renameDoc' && c.calls[0].args[1] === 'NewName',
      JSON.stringify(c.calls));
    // ★ The measured defect this guards: `setBlockAttrs(id, {title})` leaves an "untitled document" residue,
    //   because the kernel treats a title attribute change as a rename event.
    check('★★★ … and never by writing a title attribute',
      !c.calls.some((x) => x.method === 'setBlockAttrs'), JSON.stringify(c.calls.map((x) => x.method)));
  }
  {
    const c = new RecordingClient();
    await mkStore(c).setHeadingTitle('doc1', 'NewName');
    const writes = c.calls.filter((x) => x.method === 'updateBlock');
    check('★★★ the heading block is rewritten with the new title, as markdown',
      writes.length === 1 && writes[0].args[0] === H1 && writes[0].args[1] === '# NewName',
      JSON.stringify(writes));
  }
  {
    // ★ A document with no heading block (hand-written, untitled) must not gain one: the plugin is not the
    //   author of that document's structure.
    const c = new RecordingClient();
    c.headingId = null;
    await mkStore(c).setHeadingTitle('doc1', 'NewName');
    check('★★ when there is no heading block, nothing is written at all',
      !c.calls.some((x) => x.method === 'updateBlock'), JSON.stringify(c.calls.map((x) => x.method)));
  }

  console.log('\n=== §97 the load path reads the title from the heading block ===');
  {
    // ★ The reason both writes are needed: this is what the title box shows after a reopen.
    check('★★ `# Title` is the title', titleFromKramdown('# 标题二\n\n- 甲\n') === '标题二');
    check('★ surrounding spaces are trimmed', titleFromKramdown('#   多空格   \n') === '多空格');
    check('★★ `## Sub` is not the document title', titleFromKramdown('## 二级\n') === '');
    check('★★★ and a `#` inside body text is not one either (the match is anchored to a line start)',
      titleFromKramdown('- 甲 # not a title\n') === '', JSON.stringify(titleFromKramdown('- 甲 # not a title\n')));
    check('★ a document with no heading yields an empty title, not a guess',
      titleFromKramdown('- 甲\n- 乙\n') === '');
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
}

void main();
