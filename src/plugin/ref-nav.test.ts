/**
 * Parsing and navigation of backlinks / mentions.
 *
 * Corresponds to .logs/API-GOTCHAS.md §117, §118; defects #56, #57.
 *
 * ★ Both halves used to hold a **copy** of the thing they described, and the copy was the whole test:
 *
 *   · the reference regex was reproduced here, commented "kept identical to kramdownToHtml in
 *     src/core/map.ts" —— so the plugin's own regex could change freely and this file stayed green.
 *     It reads `kramdownToHtml` / `htmlToKramdown` now.
 *   · "nobody passes the callback, so clicking does nothing" was asserted with two local array literals
 *     (`declared.length === 2`, `wiredBefore.length === 0`), which say nothing about any file. That claim
 *     is enforced by `scripts/check-dead-props.ts` (gate `dead-props`: every optional callback a component
 *     invokes is supplied by a call site), so it is not repeated here.
 *   · the `openTab` argument shape and the "app must be the real application instance" table were modelled
 *     with local functions. The measurement is in `docs/kernel-api.md` §7.14, and what belongs in a test is
 *     the product's side of it: which value the plugin actually passes.
 */
export {};

import fs from 'node:fs';
import path from 'node:path';
import { htmlToKramdown, kramdownToHtml } from '../core/map';
import { callArgProps, callSites, stripComments } from './source-probe';

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

console.log('=== #56: SiYuan native references use double quotes ===');
{
  // Measured output of the kernel's /api/block/getBlockKramdown.
  const native = '见 ((20260101000000-aaaaaaa "目标文档"))';
  check('★★ a reference with double quotes becomes a node reference',
    kramdownToHtml(native).includes('data-noderef="20260101000000-aaaaaaa"'),
    kramdownToHtml(native));
  check('★ the visible text is the reference title, not the ID',
    /data-noderef="[^"]*">目标文档</.test(kramdownToHtml(native)), kramdownToHtml(native));
}

console.log('\n=== both quote styles parse (old data used single quotes) ===');
{
  check('★ single quotes still parse', kramdownToHtml("((id '标题'))").includes('data-noderef="id"'),
    kramdownToHtml("((id '标题'))"));
  check('★ a title containing spaces survives',
    kramdownToHtml('((id "标题 一"))').includes('>标题 一<'), kramdownToHtml('((id "标题 一"))'));
  check('★ ordinary text is left alone',
    !kramdownToHtml('普通 (()) 文本').includes('data-noderef'), kramdownToHtml('普通 (()) 文本'));
  check('★ an unclosed reference is not turned into one',
    !kramdownToHtml('((id "没闭合').includes('data-noderef'), kramdownToHtml('((id "没闭合'));
  check('★ its text is not damaged either',
    kramdownToHtml('((id "没闭合').includes('((id "没闭合'), kramdownToHtml('((id "没闭合'));
  const mixed = kramdownToHtml(`A ((i1 "标题A")) B ((i2 '标题B'))`);
  check('★ both quote styles mixed within one line → two references',
    (mixed.match(/data-noderef/g) || []).length === 2, mixed);
}

console.log('\n=== the write-back direction uses double quotes too ===');
{
  // A single-quoted reference read in, written back as double quotes: SiYuan's own form, so a document the
  // plugin rewrites does not keep the one style the kernel has stopped emitting.
  const html = '<span data-noderef="20260101000000-aaaaaaa">目标文档</span>';
  const back = htmlToKramdown(html);
  check('★ write-back produces the double-quoted form',
    back === '((20260101000000-aaaaaaa "目标文档"))', back);
  check('★ the round trip is stable (parsing it back yields the same reference)',
    kramdownToHtml(back).includes('data-noderef="20260101000000-aaaaaaa"'), kramdownToHtml(back));
}

console.log('\n=== the jump hands the kernel the application instance, with no substitute ===');
{
  // ★ The product's half of docs/kernel-api.md §7.14: `app` is the only variable that matters, and a plugin
  //   instance there leaves a blank tab while the error stays in the background. `appRef ?? plugin` did
  //   exactly that —— this reads what the call passes, so re-adding any substitute goes red.
  const mountSrc = fs.readFileSync(path.join(__dirname, 'mount.ts'), 'utf8');
  const appArgs = callArgProps(mountSrc, /^openTab$/, 'app');
  check('★ exactly one openTab call site declares `app`', appArgs.length === 1, JSON.stringify(appArgs));
  check('★★ that value is the application instance (`appRef`), never a fallback',
    appArgs[0]?.value === 'appRef', `value=${appArgs[0]?.value}`);
  check('★ the jump really happens (precondition of the check above: a call site exists)',
    callSites(mountSrc, /^openTab$/).length === 1,
    callSites(mountSrc, /^openTab$/).join(', '));
  // Without the precondition check, `appRef` may be undefined and the kernel receives undefined —— the same
  // blank page by another route. Asserted on comment-stripped source so the explanation above cannot satisfy it.
  check('★★ a missing application instance is reported instead of jumping',
    stripComments(mountSrc).includes('if (!appRef)'), 'no `if (!appRef)` guard around the call');
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
