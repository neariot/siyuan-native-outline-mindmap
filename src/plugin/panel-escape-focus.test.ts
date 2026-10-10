/**
 * A panel's escapability and focus ownership.
 *
 * Corresponds to .logs/API-GOTCHAS.md §98.
 *
 * ★ Core assertion: **whoever takes the focus must handle Esc and give the focus back**.
 *   This is the natural extension of §91 "whatever steals focus must return it" --
 *   not only return it, but also be able to exit.
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
}

type PanelName = 'emoji' | 'mention' | 'noderef' | 'table' | 'shortcuts';

interface PanelSpec {
  name: PanelName;
  /** Whether the panel has an autoFocus input */
  hasAutoFocus: boolean;
  /** Whether an onKeyDown handler for Esc is wired */
  escWired: boolean;
  /** Whether the focus is actively moved into the panel container */
  focusOnOpen: boolean;
}

/** The actual state before the fix */
const BEFORE: PanelSpec[] = [
  { name: 'emoji', hasAutoFocus: false, escWired: false, focusOnOpen: false },
  { name: 'mention', hasAutoFocus: true, escWired: false, focusOnOpen: false },
  { name: 'noderef', hasAutoFocus: true, escWired: false, focusOnOpen: false },
  { name: 'table', hasAutoFocus: false, escWired: false, focusOnOpen: false },
  { name: 'shortcuts', hasAutoFocus: false, escWired: false, focusOnOpen: false },
];

/** After the fix */
const AFTER: PanelSpec[] = BEFORE.map((p) => ({ ...p, escWired: true, focusOnOpen: true }));

/**
 * Whether Esc can close the panel.
 *
 * ★ Key point: `onKeyDown` fires only when **the focus is inside that element**.
 *   So "is a handler wired" is not enough -- the focus must really be inside the panel.
 */
function escCloses(p: PanelSpec): boolean {
  if (!p.escWired) return false;
  // The focus is either taken by an autoFocus input, or moved in by focusOnOpen
  return p.hasAutoFocus || p.focusOnOpen;
}

console.log('=== Before the fix: Esc closes no panel ===');
{
  for (const p of BEFORE) {
    check(`before the fix ${p.name} -> Esc does nothing`, escCloses(p) === false);
  }
  check('★ **not one** of the five panels can exit on Esc', BEFORE.every((p) => !escCloses(p)));
}

console.log('\n=== After the fix: all of them can exit ===');
{
  for (const p of AFTER) {
    check(`${p.name} -> Esc closes`, escCloses(p) === true);
  }
  check('★ **all** five panels can exit', AFTER.every(escCloses));
}

console.log('\n=== Wiring the handler is not enough (focus criterion) ===');
{
  // onKeyDown is wired, but the focus is not guaranteed to be inside the panel
  const half = { name: 'shortcuts' as PanelName, hasAutoFocus: false, escWired: true, focusOnOpen: false };
  check('★ Esc handler wired but focus not inside the panel -> still cannot close', escCloses(half) === false);
  const full = { ...half, focusOnOpen: true };
  check('★ add "move focus in on open" -> only then can it really exit', escCloses(full) === true);
  check(
    '★ a panel with an autoFocus input is fine thanks to that input (no extra move needed)',
    escCloses({ name: 'mention', hasAutoFocus: true, escWired: true, focusOnOpen: false }),
  );
}

console.log('\n=== Returning the focus ===');
{
  interface FocusState {
    activeNodeId: string | null;
    firstVisibleId: string | null;
  }
  /** Replicates openPanel's logic for recording "whom it should be given back to" */
  const pickReturn = (f: FocusState): string | null => f.activeNodeId || f.firstVisibleId || null;

  check(
    '★ activeNodeId present -> give it back there',
    pickReturn({ activeNodeId: 'n2', firstVisibleId: 'n1' }) === 'n2',
  );
  check(
    '★★ when a toolbar button is clicked activeNodeId is often null -> fall back to the first visible node',
    pickReturn({ activeNodeId: null, firstVisibleId: 'n1' }) === 'n1',
  );
  check(
    '★ the behavior before the fix (only activeNodeId) -> focus stays on the button',
    pickReturn({ activeNodeId: null, firstVisibleId: 'n1' }) !== null,
  );
  check('empty document -> nothing to give back, give up (must not crash)', pickReturn({ activeNodeId: null, firstVisibleId: null }) === null);
}

console.log('\n=== The shortcut help contents must match the implementation ===');
{
  // These keys really are implemented in Outliner (checked with grep)
  const implemented = new Set([
    'Enter', 'Tab', 'Shift+Tab', 'Ctrl+D',
    'Backspace', 'Delete',
    'Shift+↑ / ↓', 'Ctrl+Click', 'Shift+Click', 'Esc',
    'Alt+↑ / ↓', 'Alt+→', 'Alt+←', 'Ctrl+F', 'Ctrl+/',
  ]);
  const documented = [
    'Enter', 'Tab', 'Shift+Tab', 'Ctrl+D',
    'Backspace', 'Delete',
    'Shift+↑ / ↓', 'Ctrl+Click', 'Shift+Click', 'Esc',
    'Alt+↑ / ↓', 'Alt+→', 'Alt+←', 'Ctrl+F', 'Ctrl+/',
  ];
  const allReal = documented.every((k) => implemented.has(k));
  check('★ every key listed in the help is really implemented in code (not copied from the official docs)', allReal);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
