/**
 * Full ConflictTracker semantics + its interaction with deletion.
 *
 * These are **deterministic unit tests** for the "a conflict appears inside the write-back window" path --
 * hitting a 0.7-second race window exactly through the UI is not reproducible,
 * while ConflictTracker is a pure class and its logic is fully testable.
 */
import { ConflictTracker } from './sync';

let pass = 0, fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
};

// ══ Scenario replay: local edited and outside edited inside the write-back window ══
{
  const c = new ConflictTracker();
  // 1. Load the document: every node matches SiYuan
  c.noteAllSynced([{ id: 'a', text: '甲' }, { id: 'b', text: '乙' }]);
  check('after loading: local == baseline, the external change is accepted', !c.check('b', '乙', 'external 乙'));

  // 2. b was edited in the mind map (the local value changed but the write-back has not finished → the baseline is still the old value)
  //    meanwhile the outside edited b too
  const isConflict = c.check('b', '导图侧节点', '内核侧节点');
  check('★ local diverged from the baseline + external change → conflict', isConflict);
  c.record({ nodeId: 'b', blockId: 'bb', mine: '导图侧节点', theirs: '内核侧节点', at: 1 });
  check('★ the conflict is recorded and the UI would show "1 item"', c.list().length === 1);

  // 3. The user deletes the conflicting node
  c.forget(['b']);
  check('★ after deletion the conflicts are gone', c.list().length === 0);
}

// ══ forget affects only the given node ══
{
  const c = new ConflictTracker();
  c.noteAllSynced([{ id: 'a', text: '甲' }, { id: 'b', text: '乙' }, { id: 'd', text: '丁' }]);
  c.record({ nodeId: 'b', blockId: 'bb', mine: 'x', theirs: 'y', at: 1 });
  c.record({ nodeId: 'd', blockId: 'bd', mine: 'p', theirs: 'q', at: 2 });
  c.forget(['b']);
  check('forget removes only the given node', c.list().length === 1 && c.list()[0].nodeId === 'd');
}

// ══ forget also clears that node's baseline (other nodes are untouched) ══
{
  const c = new ConflictTracker();
  c.noteAllSynced([{ id: 'a', text: '甲' }, { id: 'b', text: '乙' }]);
  c.forget(['b']);
  // a still has a baseline → the external change is accepted
  check('forget does not affect the baseline of other nodes', !c.check('a', '甲', '外部节点三'));
  // b has no baseline → the local value no longer equals the baseline → treated as a conflict
  check('after forget the node has no baseline, so the local value counts as diverged', c.check('b', '乙', '外部节点二'));
}

// ══ forgetting a node that does not exist is safe ══
{
  const c = new ConflictTracker();
  c.forget(['nope']);
  check('forgetting a nonexistent node does not throw', c.list().length === 0);
  c.forget([]);
  check('forgetting an empty set does not throw', c.list().length === 0);
}

// ══ a conflict clears itself once the content converges ══
{
  const c = new ConflictTracker();
  c.noteAllSynced([{ id: 'b', text: '乙' }]);
  c.record({ nodeId: 'b', blockId: 'bb', mine: '甲', theirs: '丙', at: 1 });
  // the user edits the local value back to match the outside → converged
  c.check('b', '丙', '丙');
  check('the conflict clears itself after the content converges', c.list().length === 0);
}

// ══ noteSynced also clears a conflict ══
{
  const c = new ConflictTracker();
  c.record({ nodeId: 'b', blockId: 'bb', mine: '甲', theirs: '丙', at: 1 });
  c.noteSynced('b', '丙');
  check('the conflict clears after a successful write-back (content matches theirs)', c.list().length === 0);
}

// ══ ★ An external change arrives while the write-back is in flight → it must be recorded as a conflict (the silently swallowed bug seen in practice) ══
//
// Scenario:
//   t0  the outline is changed to "mindmap" → the baseline advances to "mindmap" → the write-back departs (in flight)
//   t1  the API changes the same block to "changed externally"
//       base='mindmap', current='mindmap' → the old logic judged "no local intent" → it accepted the external value
//   t2  the still in-flight write-back writes the block back to "mindmap" → the external change is overwritten with no warning at all
{
  const c = new ConflictTracker();
  c.noteAllSynced([{ id: 'b', text: '乙' }]);

  // baseline advances (registering the new local value when the write-back starts) -- the write-back is not finished
  c.noteSynced('b', '导图');
  check(
    '★ the baseline has advanced to "mindmap"',
    c.check('b', '导图', '导图') === false,
  );

  // t1: an external value arrives while the write-back is in flight (writeInFlight=true)
  const isConflict = c.check('b', '导图', '外部节点一', true);
  check('★★ write-back in flight + external change → judged a conflict (otherwise it is silently overwritten)', isConflict);

  // Control: with the write-back **not in flight**, the same values must be judged "no local intent, accept the external change"
  const c2 = new ConflictTracker();
  c2.noteAllSynced([{ id: 'b', text: '乙' }]);
  c2.noteSynced('b', '导图');
  check(
    'control: write-back not in flight → the external change is accepted (no false positive)',
    c2.check('b', '导图', '外部节点一', false) === false,
  );
}

// ══ writeInFlight does not disturb the existing semantics ══
{
  const c = new ConflictTracker();
  c.noteAllSynced([{ id: 'a', text: '甲' }]);
  // once the content has converged there is no conflict even in flight (avoid noise)
  check(
    '★ identical content + in flight → still no conflict (no fabricated conflicts)',
    c.check('a', '甲', '甲', true) === false,
  );
  check('the conflict table is empty after convergence', c.list().length === 0);
}

// ══ When the incoming external value equals the baseline (typed locally, unchanged outside) no conflict is reported ══
{
  const c = new ConflictTracker();
  // establish an empty-string baseline (e.g. a newly created empty node)
  c.noteAllSynced([{ id: 'n1', text: '' }]);
  // the user types "hello" locally while the kernel echoes back the previous empty-string baseline
  const isConflict = c.check('n1', 'hello', '', false);
  check('no conflict is reported when the external value equals the baseline (unchanged outside)', isConflict === false);
}

// ══ noteAllSynced registers child baselines recursively ══
{
  const c = new ConflictTracker();
  c.noteAllSynced([
    {
      id: 'root',
      text: '根',
      children: [
        { id: 'c1', text: '子1', children: [{ id: 'c1-1', text: '孙1' }] },
      ],
    },
  ]);
  // the grandchild got its baseline registered directly, so an external value equal to the baseline is not a conflict
  check('child baselines are registered recursively: an external edit to the grandchild with no local change is accepted', c.check('c1-1', '孙1', '孙1外部') === false);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
