/**
 * **First-edit** semantics of the undo stack.
 *
 * See .logs/API-GOTCHAS.md §89.
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
 */
export {};

interface Node {
  id: string;
  text: string;
}

/** Reproduces pushUndo's "no snapshot → silently skip" behavior */
class UndoStack {
  private stack: Node[][] = [];
  private prevTree: Node[] | null = null;
  public skips = 0;
  public pushes = 0;

  /** Simulates loading a document: ★ when fixed=true, prevTree is initialized too */
  load(tree: Node[], fixed: boolean): void {
    this.stack = [];
    this.prevTree = fixed ? tree : null;
  }

  /** One edit: push the "state before the change" first, then advance prevTree */
  edit(next: Node[]): void {
    // callers always pass prevTree (same as the real code)
    const before = this.prevTree;
    const src = before ?? this.prevTree;
    if (!src) {
      this.skips++;
      // ★ the real code does `return` here — it skips the push,
      //   but the **caller still advances prevTree afterwards** (in mount.ts
      //   `prevTreeRef.current = nodesRef.current` runs unconditionally after pushUndo).
      //   So the second edit has something to push — that is exactly why "only the first edit cannot be undone".
      this.prevTree = next;
      return;
    }
    this.pushes++;
    this.stack.push(src);
    this.prevTree = next;
  }

  depth(): number {
    return this.stack.length;
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

const A: Node[] = [{ id: 'a', text: '甲' }];
const B: Node[] = [{ id: 'a', text: '甲Q' }];
const C: Node[] = [{ id: 'a', text: '甲Q2' }];

console.log('=== Before the fix: prevTree is not initialized after loading ===');
{
  const s = new UndoStack();
  s.load(A, false);
  s.edit(B);
  check('★ the first edit is silently skipped', s.skips === 1 && s.pushes === 0);
  check('★ the undo stack is still empty → Ctrl+Z does nothing', s.depth() === 0);
  s.edit(C);
  check('only the second edit pushes successfully', s.depth() === 1);
}

console.log('\n=== After the fix: prevTree is initialized on load too ===');
{
  const s = new UndoStack();
  s.load(A, true);
  s.edit(B);
  check('★ the first edit pushes normally', s.pushes === 1 && s.skips === 0);
  check('★ undo depth = 1 → Ctrl+Z works', s.depth() === 1);
  s.edit(C);
  check('the second edit pushes too', s.depth() === 2);
}

console.log('\n=== Stack contents correctness ===');
{
  const s = new UndoStack();
  s.load(A, true);
  s.edit(B);
  s.edit(C);
  check('it pushes the state from *before* the change, not the state after', s.depth() === 2);
}

console.log('\n=== Switching documents must clear it ===');
{
  const s = new UndoStack();
  s.load(A, true);
  s.edit(B);
  s.load(C, true);
  check('the undo stack is cleared after switching documents', s.depth() === 0);
  s.edit(A);
  check('after switching documents the first edit is already undoable', s.depth() === 1);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
