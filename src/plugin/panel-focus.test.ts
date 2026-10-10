/**
 * **Focus restoration** semantics for panels / overlays.
 *
 * See .logs/API-GOTCHAS.md §91.
 *
 * ★ The same pattern appears in four places:
 *   · mind map edit overlay (textarea)
 *   · "@ reference a document" panel (autoFocus input)
 *   · "backlinks" panel (autoFocus input)
 *   · find & replace bar (autoFocus input)
 *
 *   Common trait: **it steals focus when opening, and nobody gives it back on close**.
 *   Focus lands on BODY → all subsequent typing is lost.
 *
 *   Contrast: the "Emoji" and "table" panels have no autoFocus, focus stays on the node,
 *   and they never had this problem — so this is not a "panel" disease,
 *   it is "**whatever steals focus must give it back**".
 */
export {};

interface Ctx {
  active: 'node' | 'overlay' | 'body';
  nodeId: string | null;
  returnTo: string | null;
  typed: string;
}

class PanelModel {
  public ctx: Ctx = { active: 'node', nodeId: null, returnTo: null, typed: '' };

  /** The user clicks a node */
  clickNode(id: string): void {
    this.ctx.active = 'node';
    this.ctx.nodeId = id;
  }

  /** Open the panel. fixed=false is the variant that does not remember a return target */
  openPanel(stealsFocus: boolean, fixed: boolean): void {
    if (fixed) this.ctx.returnTo = this.ctx.nodeId;
    if (stealsFocus) this.ctx.active = 'overlay';
  }

  /** Close the panel */
  closePanel(fixed: boolean): void {
    if (fixed && this.ctx.returnTo) {
      this.ctx.nodeId = this.ctx.returnTo;
      this.ctx.returnTo = null;
      this.ctx.active = 'node';
      return;
    }
    // ★ With no "return target" we **must not** touch focus:
    //   if focus was never stolen there is nothing to give back (the Emoji / table panels
    //   are that case; forcing setActive='body' would actually lose the healthy focus).
    if (this.ctx.returnTo === null && this.ctx.active === 'node') return;
    this.ctx.active = 'body';
  }

  /** Typing: only takes effect when focus is on a node */
  type(ch: string): boolean {
    if (this.ctx.active !== 'node') return false;
    this.ctx.typed += ch;
    return true;
  }
}

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

console.log('=== Panels that do not steal focus (Emoji / table): they work anyway ===');
{
  const m = new PanelModel();
  m.clickNode('甲');
  m.openPanel(false, false);
  check('focus is still on the node after opening', m.ctx.active === 'node');
  m.closePanel(false);
  check('focus is still on the node after closing', m.ctx.active === 'node');
  check('typing takes effect', m.type('Z') === true && m.ctx.typed === 'Z');
}

console.log('\n=== A focus-stealing panel: before the fix ===');
{
  const m = new PanelModel();
  m.clickNode('甲');
  m.openPanel(true, false);
  check('focus is stolen to the overlay on open', m.ctx.active === 'overlay');
  m.closePanel(false);
  check('★ after closing, focus lands on body (no return target)', m.ctx.active === 'body');
  check('★ typing is lost', m.type('Z') === false && m.ctx.typed === '');
}

console.log('\n=== A focus-stealing panel: after the fix ===');
{
  const m = new PanelModel();
  m.clickNode('甲');
  m.openPanel(true, true);
  check('focus is stolen to the overlay on open', m.ctx.active === 'overlay');
  check('the return target is recorded', m.ctx.returnTo === '甲');
  m.closePanel(true);
  check('★ focus returns to the node after closing', m.ctx.active === 'node');
  check('★ it returns to the original node', m.ctx.nodeId === '甲');
  check('★ typing takes effect', m.type('Z') === true && m.ctx.typed === 'Z');
}

console.log('\n=== Opening a panel with no node selected must not focus blindly ===');
{
  const m = new PanelModel();
  m.clickNode('甲');
  m.ctx.nodeId = null; // simulate having no active node
  m.openPanel(true, true);
  check('with no return target it is recorded as null', m.ctx.returnTo === null);
  m.closePanel(true);
  check('after closing it does not force focus (focus on body is acceptable)', m.ctx.active === 'body');
}

console.log('\n=== Toggling a panel repeatedly must not leak state ===');
{
  const m = new PanelModel();
  m.clickNode('甲');
  m.openPanel(true, true);
  m.closePanel(true);
  check('after the first toggle it returns to 甲', m.ctx.nodeId === '甲');
  m.clickNode('乙');
  m.openPanel(true, true);
  check('the second toggle records the new target', m.ctx.returnTo === '乙');
  m.closePanel(true);
  check('after the second toggle it returns to 乙', m.ctx.nodeId === '乙');
}

console.log('\n=== How pendingFocus consumption depends on its deps ===');
{
  // reproduces the dependency behavior of useLayoutEffect
  const shouldRun = (
    prev: { nodes: number; panel: string | null; findOpen: boolean },
    next: { nodes: number; panel: string | null; findOpen: boolean },
    deps: string[],
  ): boolean => deps.some((d) => (prev as never)[d] !== (next as never)[d]);

  const base = { nodes: 1, panel: null as string | null, findOpen: false };
  const panelClosed = { nodes: 1, panel: null as string | null, findOpen: false };

  check(
    '★ depending only on nodes → the effect does not run when closing the panel (focus never comes back)',
    shouldRun(base, panelClosed, ['nodes']) === false,
  );
  check(
    '★ depending on nodes+panel → it does run when opening the panel',
    shouldRun(base, { nodes: 1, panel: 'emoji', findOpen: false }, ['nodes', 'panel']) === true,
  );
  check(
    '★ deps without find.open → the effect does not run when closing the find bar (focus never comes back)',
    shouldRun({ nodes: 1, panel: null, findOpen: true }, panelClosed, ['nodes', 'panel']) === false,
  );
  check(
    '★ deps with find.open → it does run when closing the find bar',
    shouldRun({ nodes: 1, panel: null, findOpen: true }, panelClosed, [
      'nodes',
      'panel',
      'findOpen',
    ]) === true,
  );
  check(
    'unrelated state changes still do not trigger it while the deps are complete',
    shouldRun(base, panelClosed, ['nodes', 'panel', 'findOpen']) === false,
  );
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
