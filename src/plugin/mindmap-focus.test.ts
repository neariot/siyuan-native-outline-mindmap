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
 *
 * ★ This file used to carry a `FocusModel` class —— a small state machine written inside the test —— and
 *   asserted on it, so the plugin could change freely while the test stayed green. The cases now read
 *   `src/mindmap/Mindmap.tsx`: every close path must call `focusCanvas()`, and both focus calls must
 *   **retry across frames**, because a single `requestAnimationFrame` may run before React commits the DOM
 *   (measured: with one attempt the next keystrokes were lost and extra empty nodes were created).
 */
export {};

import fs from 'node:fs';
import path from 'node:path';
import { callSites, fnBody } from './source-probe';

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

const src = fs.readFileSync(path.join(__dirname, '..', 'mindmap', 'Mindmap.tsx'), 'utf8');

console.log('=== every way out of the overlay gives focus back to the canvas ===');
{
  // A keyboard handler on the canvas only receives keys while the canvas has focus, so each of these paths
  // is "the keyboard dies" if it forgets the call.
  for (const [header, label] of [
    ['const commitEdit = (', 'committing the edit'],
    ['const cancelEdit = (', 'cancelling the edit'],
    ['const closeParagraphs = (', 'closing the paragraph panel'],
    ['const commitParagraphs = (', 'saving the paragraph edit (which closes the panel)'],
  ] as const) {
    const body = fnBody(src, header);
    check(`★★ ${label} returns focus to the canvas (${header.slice(6, -3)})`,
      body.includes('focusCanvas()'), body.slice(0, 100) || 'body not found');
  }

  // ★ Cancelling the paragraph **edit** is not a close path: the panel stays open, so focus belongs back in
  //   the panel (its own Escape / Ctrl+Enter must keep working), not on the canvas. It had no restore at all
  //   —— the autoFocus textarea unmounts, focus falls to BODY, and every shortcut is dead until a click.
  {
    const body = fnBody(src, 'const cancelParagraphs = (');
    check('★★★ cancelling the paragraph edit gives focus back to the panel that is still open',
      body.includes('paraPanelRef.current?.focus()'), body.slice(0, 120) || 'body not found');
    check('★ … and it really leaves the panel open (that is why the panel, not the canvas, takes focus)',
      !body.includes('setParaView(null)'), body.slice(0, 120));
  }

  const calls = callSites(src, /^focusCanvas$/);
  check('★★ the restore is not called from anywhere unexpected (4 close paths)', calls.length === 4,
    calls.join(', '));
}

console.log('\n=== both focus calls retry across frames ===');
{
  // ★ A single attempt is the measured defect: the rAF callback can run before React commits, the ref is
  //   still null, focus stays where it was, and every keystroke after that is swallowed.
  const canvasBody = fnBody(src, 'const focusCanvas = React.useCallback(');
  check('★ focusCanvas retries through animation frames',
    canvasBody.includes('requestAnimationFrame'), canvasBody.slice(0, 80));
  check('★★★ … with a bounded number of attempts, not a single one',
    /tries\+\+ < \d+/.test(canvasBody), 'measured: one attempt loses the next keystrokes');
  check('★ it focuses the canvas element itself', /el\.focus\(\)/.test(canvasBody), canvasBody.slice(0, 80));

  const editBody = fnBody(src, 'const beginEdit = (id: string, initial: string)');
  check('★ beginEdit retries too, for the same reason',
    editBody.includes('requestAnimationFrame') && /tries\+\+ < \d+/.test(editBody), editBody.slice(0, 80));
  check('★★ and selects the existing text, so typing replaces it',
    /el\.select\(\)/.test(editBody), editBody.slice(0, 120));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
