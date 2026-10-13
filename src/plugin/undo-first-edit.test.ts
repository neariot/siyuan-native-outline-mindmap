/**
 * **First-edit** semantics of the undo stack.
 *
 * See `docs/pitfalls/editor.md` §2.2 (the first edit after loading a document is not undoable).
 *
 * ★ Background: `pushUndo` is implemented as
 *     const src = before ?? prevTreeRef.current;
 *     if (!src) return;              ← silently skipped
 *   and every caller passes `pushUndo(prevTreeRef.current)`.
 *   If loading a document sets **only lastCommittedRef, not prevTreeRef**,
 *   the first edit passes null → silently skipped → undo stack stays empty →
 *   Ctrl+Z does nothing.
 *
 * ★ Measured evidence (create a document, type, then Ctrl+Z):
 *   after typing:  push=1, skip=1     ← called, but skipped
 *   Ctrl+Z:  undo=1, depth=0    ← the stack is empty
 *   after the second edit: push=2, skip=1, depth=1  ← normal only from the second one on
 *
 * ★ This file used to carry an `UndoStack` class —— a model of the behaviour described above, written inside
 *   the test —— and asserted on it, so neither half of the real defect could turn it red. Both halves are now
 *   read from `src/plugin/mount.ts`:
 *
 *   1. a null argument must not mean "silently push nothing": `pushUndo` falls back to the previous tree;
 *   2. the snapshot must be initialised **when the document is loaded**, or the first edit has nothing to
 *      push. Everything else is asserted too —— the callers' convention, and the push itself.
 */
export {};

import fs from 'node:fs';
import path from 'node:path';
import { assignmentsTo, callArgs, enclosingBody, fnBody } from './source-probe';

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

const src = fs.readFileSync(path.join(__dirname, 'mount.ts'), 'utf8');

console.log('=== a null argument must not be a silent no-push ===');
{
  const body = fnBody(src, 'const pushUndo = React.useCallback(');
  check('★ pushUndo exists (precondition)', body.length > 0);
  check('★★★ it falls back to the previous tree when the caller passes null',
    body.includes('?? prevTreeRef.current'), body.slice(0, 140));
  check('★★ the guard comes **after** the fallback (so "nothing to push" is decided on the fallback\'s result)',
    body.indexOf('?? prevTreeRef.current') < body.indexOf('if (!src) return'), body.slice(0, 140));
  check('★★ it really pushes a snapshot onto the stack', /\.push\(snapshot\(src\)\)/.test(body), body.slice(0, 140));
  check('★ the stack is bounded', body.includes('UNDO_LIMIT'), body.slice(0, 200));
}

console.log('\n=== the snapshot exists as soon as a document is loaded ===');
{
  // ★ This is the defect: `prevTreeRef` was left null at load time. The baseline assignment is the one whose
  //   value is the freshly loaded tree; every other assignment advances it after an edit.
  // ★ The baseline and the stack reset belong to the **same** body: the load path initialises the snapshot
  //   exactly where it clears the undo stack, which is what made "the first edit cannot be undone" go away.
  const loadBody = enclosingBody(src, 'prevTreeRef.current = tree;');
  check('★★ the snapshot is initialised in the load path, together with the undo stack',
    loadBody.includes('prevTreeRef.current = tree') && loadBody.includes('undoStackRef.current = []'),
    `len=${loadBody.length}`);

  const assigns = assignmentsTo(src, 'prevTreeRef.current');
  const fromLoad = assigns.filter((a) => a.value === 'tree');
  check('★★★ loading a document initialises the snapshot (`prevTreeRef.current = tree`)',
    fromLoad.length === 1, JSON.stringify(assigns.map((a) => a.value)));
  check('★★ the baseline is never reset to null —— that is the state the defect was in',
    !assigns.some((a) => a.value === 'null'), JSON.stringify(assigns.map((a) => `${a.value}@${a.line}`)));
  check('★ every other assignment advances it to the current tree',
    assigns.filter((a) => a.value !== 'tree').every((a) => a.value === 'nodesRef.current'),
    JSON.stringify(assigns.map((a) => `${a.value}@${a.line}`)));
}

console.log('\n=== the callers keep the convention ===');
{
  // Every caller passes the previous tree explicitly. If one passed a value that can be undefined, the
  // fallback above would still save it —— which is the point of asserting both halves.
  const calls = callArgs(src, /^pushUndo$/);
  check('★ the write paths call pushUndo (precondition)', calls.length >= 5, `got=${calls.length}`);
  check('★★ every call passes the previous tree, not a local that may be stale',
    calls.every((c) => c.args.length === 1 && c.args[0] === 'prevTreeRef.current'),
    calls.filter((c) => c.args[0] !== 'prevTreeRef.current').map((c) => `line ${c.line}: ${c.args.join(',')}`).join(' | '));
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
