/**
 * Parsing and navigation of backlinks / mentions.
 *
 * Corresponds to `docs/pitfalls/editor.md` §6.9cc (a reference the parser cannot read degrades to plain text) and `docs/pitfalls/plugin.md` §5.4 (`openTab` needs the real application instance).
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
import { callArgProps, stripComments } from './source-probe';

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
  //
  // ★★ The criterion is **every call site**, not "exactly one". Pinning the count made a correct change go
  //    red: adding a second jump that also passes `app: appRef` failed `appArgs.length === 1`, which is the
  //    same shape as the pinned `focusCanvas` count this repository already deleted (a count cannot tell
  //    "a new caller is correct" from "an unexpected caller appeared"). The property that matters is
  //    "nothing is substituted for the application instance", so every call site is required to pass the
  //    real one and at least one has to exist.
  // ★ The `openTab` call itself moved to the HAL driver (`native-driver.ts`), which now owns host
  //   navigation; `mount.ts` keeps the existence check and the user-visible guards and calls
  //   `driverRef.current?.openBlock(target)`. The invariant is about the call site wherever it lives, so
  //   it is asserted in the module that now holds it —— reading only `mount.ts` would find zero call
  //   sites and report "the jump does not happen" for a call that moved.
  //
  // ★★ The criterion is **every call site**, not "exactly one". Pinning the count made a correct change go
  //    red: adding a second jump that also passes `app: appRef` failed `appArgs.length === 1`, which is the
  //    same shape as the pinned `focusCanvas` count this repository already deleted (a count cannot tell
  //    "a new caller is correct" from "an unexpected caller appeared"). The property that matters is
  //    "nothing is substituted for the application instance", so every call site is required to pass the
  //    real one and at least one has to exist.
  const driverSrc = fs.readFileSync(path.join(__dirname, '..', 'siyuan', 'native-driver.ts'), 'utf8');
  const appArgs = callArgProps(driverSrc, /^openTab$/, 'app');
  check('★ at least one openTab call site declares `app` (otherwise the jump does not happen)',
    appArgs.length >= 1, JSON.stringify(appArgs));
  check('★★ every openTab call site passes the application instance (`appRef`), never a substitute',
    appArgs.every((a) => a.value === 'appRef'),
    JSON.stringify(appArgs.map((a) => a.value)));
  check('★ the call sites all pass it explicitly (a call with no `app` at all would be the same blank tab)',
    appArgs.every((a) => a.value.trim().length > 0),
    JSON.stringify(appArgs));
  // Without the guard, `appRef` may be undefined and the kernel receives undefined —— the same
  // blank page by another route. Asserted on comment-stripped source so the explanation above cannot satisfy it.
  check('★★ a missing application instance is reported instead of jumping',
    stripComments(driverSrc).includes('if (!appRef)'), 'no `if (!appRef)` guard around the call');
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
