/**
 * The **classification** semantics of the undo merge window.
 *
 * Corresponds to .logs/API-GOTCHAS.md §88.
 *
 * ★ The core distinction:
 *   · continuous typing (kind='text' / undefined) -> **merge** (otherwise Ctrl+Z has to walk back one character at a time)
 *   · structural operations (kind='struct')        -> **each becomes its own step** (they are independent user decisions)
 *
 * Replicates the decision in mount.ts `handleOutlineChange` to pin this semantics down.
 */
export {};

const MERGE_MS = 1200;

interface Step {
  inWindow: boolean;
  pushed: boolean;
  key: string;
  at: number;
}

/** Replicates the merge decision in mount.ts */
class MergeModel {
  private key = '';
  private at = 0;
  readonly steps: Step[] = [];

  edit(mergeKey: string, kind: 'struct' | 'text' | undefined, now: number): boolean {
    const isStruct = kind === 'struct';
    const inWindow =
      !isStruct && mergeKey !== '' && this.key === mergeKey && now - this.at < MERGE_MS;
    let pushed = false;
    if (!inWindow) {
      pushed = true;
      // Clear the key after a structural operation so an immediately following text edit does not "join" the previous window
      this.key = isStruct ? '' : mergeKey;
      this.at = now;
    } else {
      this.at = now;
    }
    this.steps.push({ inWindow, pushed, key: this.key, at: this.at });
    return pushed;
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

console.log('=== Continuous typing: should merge ===');
{
  const m = new MergeModel();
  let pushes = 0;
  for (let i = 0; i < 6; i++) if (m.edit('node-A', undefined, i * 250)) pushes++;
  check('6 typing events (250ms apart) -> merged into 1 undo point', pushes === 1);
}
{
  const m = new MergeModel();
  let pushes = 0;
  for (let i = 0; i < 10; i++) if (m.edit('node-A', 'text', i * 300)) pushes++;
  check('explicit text 6~10 times -> still merged into 1', pushes === 1);
}

console.log('\n=== Structural operations: each should be its own step ===');
{
  const m = new MergeModel();
  let pushes = 0;
  for (let i = 0; i < 3; i++) if (m.edit('node-A', 'struct', i * 500)) pushes++;
  check('★ three indents (500ms apart) -> 3 separate undo points', pushes === 3);
}
{
  const m = new MergeModel();
  let pushes = 0;
  for (let i = 0; i < 3; i++) if (m.edit('node-A', 'struct', i * 100)) pushes++;
  check('★ very fast consecutive structural operations (100ms apart) -> still 3', pushes === 3);
}
{
  const m = new MergeModel();
  let pushes = 0;
  if (m.edit('node-A', 'struct', 0)) pushes++;
  if (m.edit('node-A', 'struct', 30000)) pushes++;
  check('structural operations far apart in time -> each becomes its own step', pushes === 2);
}

console.log('\n=== Mixed sequence ===');
{
  const m = new MergeModel();
  let pushes = 0;
  if (m.edit('node-A', undefined, 0)) pushes++;      // typing -> push
  if (m.edit('node-A', undefined, 200)) pushes++;    // typing -> merge
  if (m.edit('node-A', 'struct', 400)) pushes++;     // structural -> push
  check('typing x2 + structural x1 -> 2 undo points', pushes === 2);
}
{
  const m = new MergeModel();
  let pushes = 0;
  if (m.edit('node-A', 'struct', 0)) pushes++;
  if (m.edit('node-A', undefined, 100)) pushes++;    // typing right after a structural operation
  if (m.edit('node-A', undefined, 200)) pushes++;    // keep typing
  check('★ typing after a structural operation does not merge with it -> 2 undo points', pushes === 2);
}
{
  const m = new MergeModel();
  let pushes = 0;
  if (m.edit('node-A', 'struct', 0)) pushes++;
  if (m.edit('node-B', 'struct', 100)) pushes++;
  check('structural operations on different nodes -> each becomes its own step', pushes === 2);
}

console.log('\n=== Boundaries ===');
{
  const m = new MergeModel();
  let pushes = 0;
  if (m.edit('node-A', undefined, 0)) pushes++;
  if (m.edit('node-A', undefined, 2000)) pushes++;
  check('typing more than 1.2 seconds apart -> split into 2 undo points', pushes === 2);
}
{
  const m = new MergeModel();
  const p1 = m.edit('node-A', undefined, 0);
  m.edit('node-A', undefined, 500);
  const p3 = m.edit('node-A', undefined, 2000);
  check('no push inside the window, push again once past it', p1 === true && p3 === true);
}
{
  const m = new MergeModel();
  const pushed = m.edit('', 'struct', 0);
  check('a structural operation pushes onto the stack even when mergeKey is empty', pushed === true);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
