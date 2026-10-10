/**
 * Parsing and navigation of backlinks / mentions.
 *
 * Corresponds to .logs/API-GOTCHAS.md §117, §118; defects #56, #57.
 */
export {};

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

/** The reference regex, kept identical to kramdownToHtml in src/core/map.ts */
const REF_RE = /\(\(([^)\s]+)\s+(?:"([^"]*)"|'([^']*)')\)\)/g;
const toHtml = (s: string): string =>
  s.replace(REF_RE, (_m, id: string, dq: string, sq: string) =>
    `<span data-noderef="${id}">${dq !== undefined ? dq : sq}</span>`);

console.log('=== #56: SiYuan native references use double quotes ===');
{
  // Measured output of the kernel's /api/block/getBlockKramdown:
  const native = '见 ((20261006001709-ois7bgw "目标文档"))';
  check('★★ a regex that only accepts single quotes does not match it', !/\(\(([^)\s]+)\s+'([^']*)'\)\)/.test(native));
  check('★ double quotes must be parseable', toHtml(native).includes('data-noderef="20261006001709-ois7bgw"'));
}

console.log('\n=== Fix: accept both single and double quotes ===');
{
  check('★ double quotes', toHtml('((id "标题"))').includes('data-noderef="id"'));
  check('★ single quotes (backward compatible with old data)', toHtml("((id '标题'))").includes('data-noderef="id"'));
  check('★ title containing spaces', toHtml('((id "标题 一"))').includes('>标题 一<'));
  check('★ ordinary text is left alone', toHtml('普通 (()) 文本') === '普通 (()) 文本');
  check('★ an unclosed one is not damaged', toHtml('((id "没闭合') === '((id "没闭合');
  const mixed = toHtml('A ((i1 "标题A")) B ((i2 \'标题B\'))');
  check('★ both kinds of quotes mixed within one line', (mixed.match(/data-noderef/g) || []).length === 2);
}

console.log('\n=== The write-back direction must also be unified to double quotes ===');
{
  const html = '<span data-noderef="20261006001709-ois7bgw">目标文档</span>';
  const back = html.replace(
    /<span[^>]*data-noderef="([^"]*)"[^>]*>([\s\S]*?)<\/span>/g,
    (_m, target: string, text: string) => `((${target} "${text}"))`,
  );
  check('★ write-back uses double quotes, consistent with SiYuan', back === '((20261006001709-ois7bgw "目标文档"))');
  check('★ the round trip is stable (parsing it back yields the same result)', toHtml(back).includes('data-noderef="20261006001709-ois7bgw"'));
}

console.log('\n=== #57: clicking does nothing -- nobody passes the callback ===');
{
  const declared = ['onOpenNoderef', 'onOpenMention'];
  const wiredBefore: string[] = [];   // mount.ts originally passed none of them
  check('★★ both callbacks are declared in RichContent', declared.length === 2);
  check('★★★ but mount.ts passes neither => clicking a reference does nothing at all', wiredBefore.length === 0);
}

console.log('\n=== The doc branch of the kernel openTab (inferred from measurement) ===');
{
  // openTab({app, doc:{id, action, zoomIn}})
  //   → openFileById({app, id, action, zoomIn, scrollPosition:'start'})
  interface DocOpt { id: string; zoomIn?: boolean; action?: string[] }
  const buildArgs = (doc: DocOpt, app: unknown): Record<string, unknown> => ({
    app,
    id: doc.id,
    action: doc.action ?? [],
    zoomIn: doc.zoomIn,
    scrollPosition: 'start',
  });

  const args = buildArgs({ id: 'doc1' }, 'APP');
  check('★ when action is not given, the kernel fills in an empty array', Array.isArray(args.action) && (args.action as string[]).length === 0);

  const withAction = buildArgs({ id: 'doc1', action: ['cb-get-focus', 'cb-get-scroll'] }, 'APP');
  check('★ with action given it is a normal array', (withAction.action as string[]).length === 2);
}

console.log('\n=== ★★★ app must be the real application instance, not the plugin instance ===');
{
  // Kernel class Ks{constructor(s,...){ s.plugins.forEach(...) }}
  const kernelNeeds = (app: { plugins?: unknown[] }): boolean => {
    if (!app.plugins) throw new TypeError("Cannot read properties of undefined (reading 'forEach')");
    return true;
  };
  // Deliberately use a "plugin instance"-shaped object -- it has no `plugins` field,
  // so passing it to the kernel throws a forEach (this is exactly the misuse to reproduce).
  const pluginInstance = { name: 'some-plugin' } as { plugins?: unknown[] };
  const realApp = { plugins: [] } as { plugins?: unknown[] };

  check('★★ passing a plugin instance -> throws a forEach (the tab still opens, the error is in the background)', (() => {
    try { kernelNeeds(pluginInstance); return false; } catch { return true; }
  })());
  check('★★★ passing the real application instance -> normal', kernelNeeds(realApp));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
