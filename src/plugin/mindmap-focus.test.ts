/**
 * The **focus lifecycle** of mind map keyboard handling.
 *
 * Corresponds to .logs/API-GOTCHAS.md §90.
 *
 * ★ Defect: after the edit overlay (textarea) closes, focus goes back to BODY,
 *   and **does not** return to `.mm-canvas` on its own, while the mind map keyboard
 *   handling hangs off the canvas's `onKeyDown` → Tab/Enter/Delete/F2/Ctrl+Z
 *   **only work the first time after clicking a node**, then all of them die.
 *
 * ★ Typical pattern: **focus migrates one way only** —— entering the overlay is carefully focused,
 *   leaving it nobody gives focus back.
 */
export {};

/** A canvas that only receives keys while it holds focus */
class FocusModel {
  /** The element currently holding focus */
  public active: 'canvas' | 'overlay' | 'body' = 'body';
  public received: string[] = [];

  /** The user clicks a node: focus lands on the canvas (measured, it really does) */
  clickNode(): void {
    this.active = 'canvas';
  }

  /** Open the edit overlay: focus goes into the textarea */
  openOverlay(): void {
    this.active = 'overlay';
  }

  /** Close the edit overlay. ★ restore decides whether focus goes back to the canvas */
  closeOverlay(restore: boolean): void {
    this.active = restore ? 'canvas' : 'body';
  }

  /** A key press: handled only while the canvas holds focus */
  key(k: string): boolean {
    if (this.active !== 'canvas') {
      this.received.push(`${k}@${this.active}(ignored)`);
      return false;
    }
    this.received.push(`${k}@canvas(handled)`);
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

console.log('=== Before the fix: closing the overlay does not give focus back ===');
{
  const m = new FocusModel();
  m.clickNode();
  check('the 1st Enter works', m.key('Enter') === true);
  m.openOverlay();
  m.closeOverlay(false);
  check('★ after the overlay closes focus is on body', m.active === 'body');
  check('★ the 2nd Enter is ignored (the bug symptom)', m.key('Enter') === false);
  check('★ the 3rd Enter is ignored too', m.key('Enter') === false);
}

console.log('\n=== After the fix: closing the overlay gives focus back to the canvas ===');
{
  const m = new FocusModel();
  m.clickNode();
  check('the 1st Enter works', m.key('Enter') === true);
  m.openOverlay();
  m.closeOverlay(true);
  check('★ after the overlay closes focus is back on the canvas', m.active === 'canvas');
  check('★ the 2nd Enter still works', m.key('Enter') === true);
  check('★ the 3rd Enter still works', m.key('Enter') === true);
}

console.log('\n=== Cancelling the edit must give focus back too ===');
{
  const m = new FocusModel();
  m.clickNode();
  m.openOverlay();
  m.closeOverlay(true); // cancelEdit calls focusCanvas too
  check('after cancelling the edit Enter still works', m.key('Enter') === true);
}

console.log('\n=== Consecutive creation: the order is decided by afterId ===');
{
  // Reproduce addSibling's semantics: insert right after afterId
  interface N {
    id: string;
  }
  const insertAfter = (list: N[], afterId: string, nid: string): N[] => {
    const out: N[] = [];
    for (const n of list) {
      out.push(n);
      if (n.id === afterId) out.push({ id: nid });
    }
    return out;
  };

  // When focus is broken: afterId stays "甲" forever
  let broken: N[] = [{ id: '甲' }, { id: '乙' }];
  let sel = '甲';
  for (const nm of ['S1', 'S2', 'S3']) {
    broken = insertAfter(broken, sel, nm);
    // focus was not given back to the canvas → later keys are dead → sel never updates
    if (false) sel = nm;
  }
  check(
    '★ Broken focus → reversed order: ' + broken.map((n) => n.id).join(','),
    broken.map((n) => n.id).join(',') === '甲,S3,S2,S1,乙',
  );

  // When focus is fine: sel follows the new node
  let good: N[] = [{ id: '甲' }, { id: '乙' }];
  let gsel = '甲';
  for (const nm of ['S1', 'S2', 'S3']) {
    good = insertAfter(good, gsel, nm);
    gsel = nm; // after creating, the selection moves to the new node
  }
  check(
    '★ Focus fine → correct order: ' + good.map((n) => n.id).join(','),
    good.map((n) => n.id).join(',') === '甲,S1,S2,S3,乙',
  );
}

console.log('\n=== The selected state must have a visual marker ===');
{
  const cls = (collapsed: boolean, selected: boolean, fixed: boolean): string => {
    let c = 'mm-node';
    if (collapsed) c += ' mm-collapsed';
    if (fixed && selected) c += ' mm-selected';
    return c;
  };
  check('before the fix the selection has no style', cls(false, true, false) === 'mm-node');
  check('after the fix there is mm-selected', cls(false, true, true) === 'mm-node mm-selected');
  check('collapsed and selected stack', cls(true, true, true) === 'mm-node mm-collapsed mm-selected');
  check('a non-selected node does not wrongly get the style', cls(false, false, true) === 'mm-node');
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
