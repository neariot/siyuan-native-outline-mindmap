/**
 * Local view (zoom) wiring, and the two representations of a document title must stay in sync.
 *
 * Corresponds to .logs/API-GOTCHAS.md §96 / §97.
 */
export {};

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
};

// ------------------------------------------------------- §96 Optional props missing -> the whole UI silently breaks

interface OutlinerProps {
  nodes: string[];
  zoomId?: string | null;
  onZoomChange?: (id: string | null) => void;
}

/**
 * Replicates the zoom call in Outliner.
 * ★ The key is the **optional chaining** on `onZoomChange?.()` --
 *   when props are not passed it silently does nothing: no error, no trace.
 */
function enterZoom(props: OutlinerProps, id: string): void {
  props.onZoomChange?.(id);
}

/** Simulates whether mount.ts passes zoom props when rendering Outliner */
function renderOutliner(withZoomProps: boolean): OutlinerProps {
  const p: OutlinerProps = { nodes: ['甲', '节点一', '节点二', '乙'] };
  if (withZoomProps) {
    p.zoomId = null;
    p.onZoomChange = () => {};
  }
  return p;
}

console.log('=== §96 zoom silently fails when props are not passed ===');
{
  let called = false;
  const props = renderOutliner(false);
  props.onZoomChange = undefined; // not passed
  const spy: OutlinerProps = { ...props, onZoomChange: (id) => { called = true; void id; } };
  enterZoom(spy, '甲');
  check('onZoomChange passed -> callback is called', called);

  const missing: OutlinerProps = { nodes: ['甲'] }; // left out
  let threw = false;
  try {
    enterZoom(missing, '甲'); // optional chaining: silently skipped
  } catch {
    threw = true;
  }
  check('★ onZoomChange left out -> no throw (so the defect is completely silent)', !threw);
  check('★ when left out, zoomId stays undefined -> displayedNodes always shows everything', missing.zoomId === undefined);
}
{
  // Derivation of displayedNodes: only when zoomNode exists does it show just that one
  const displayed = (zoomId: string | null | undefined, all: string[]): string[] => {
    const zoomNode = zoomId ? all.find((x) => x === zoomId) : null;
    return zoomNode ? [zoomNode] : all;
  };
  const all = ['甲', '节点一', '节点二', '乙'];
  check('not wired (zoomId=undefined) -> always shows all nodes', displayed(undefined, all).length === 4);
  check('wired and zoomId="甲" -> shows only the "甲" subtree', displayed('甲', all).join(',') === '甲');
  check('wired and zoomId=null -> shows everything', displayed(null, all).length === 4);
}
{
  // Criterion for deciding whether the wiring is complete
  const isWired = (props: OutlinerProps): boolean =>
    props.zoomId !== undefined && typeof props.onZoomChange === 'function';
  check('★ wiring criterion: zoomId and onZoomChange must both be present', isWired(renderOutliner(true)));
  check('★ passing only one is not wiring (this is the shape of this round\'s defect)', !isWired({ nodes: [], zoomId: null }));
  check('★ passing neither is not wiring either', !isWired({ nodes: [] }));
}

// ------------------------------------------------------- §97 The two representations of the title

interface DocState {
  /** The document's own name (the one renameDocByID changes) */
  docName: string;
  /** The `# Title` block on the first body line (the one loadDoc trusts) */
  heading: string;
}

/** Replicates loadDoc's title parsing: only the body heading block counts */
function titleOnLoad(d: DocState): string {
  return d.heading;
}

/** Before the fix: only the document name is changed */
function changeTitleOld(d: DocState, next: string): DocState {
  return { ...d, docName: next };
}

/** After the fix: both places are written */
function changeTitleNew(d: DocState, next: string): DocState {
  return { docName: next, heading: next };
}

console.log('\n=== §97 The title must be synced in both places ===');
{
  const init: DocState = { docName: '标题二', heading: '标题二' };
  check('initially the two agree', init.docName === init.heading);

  const old1 = changeTitleOld(init, '标题二XYZ');
  check('★ before the fix: looks fine right after the change (the UI reads state)', old1.docName === '标题二XYZ');
  check('★ before the fix: after reopening, the heading block overwrites it with the old value -> the title is "lost"', titleOnLoad(old1) === '标题二');
  check('★ before the fix: the two diverge permanently', old1.docName !== old1.heading);

  const nu = changeTitleNew(init, '标题二XYZ');
  check('after the fix: reopening still keeps the new title', titleOnLoad(nu) === '标题二XYZ');
  check('after the fix: the two stay consistent', nu.docName === nu.heading);
}
{
  // Regression: renaming also rewrites the heading block, so the next load parses the new value
  let d: DocState = { docName: 'A', heading: 'A' };
  for (const t of ['B', 'C', 'D']) d = changeTitleNew(d, t);
  check('still consistent after repeated renames', d.docName === 'D' && d.heading === 'D');
  check('load parsing is correct', titleOnLoad(d) === 'D');
}
{
  // The load-parsing regex must handle every shape of `# Heading`
  const parse = (kramdown: string): string => {
    const m = /^#\s+(.+)$/m.exec(kramdown);
    return m ? m[1].trim() : '';
  };
  check('parses `# 标题`', parse('# 标题\n\n- 甲\n') === '标题');
  check('parses `#   多空格`', parse('#   多空格\n') === '多空格');
  check('★ does not treat `## 二级` as the document title', parse('## 二级\n') === '');
  check('★ does not mistake a `# ` in the body for the title (must be at line start)', parse('- 甲 # 不是标题\n') === '');
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
