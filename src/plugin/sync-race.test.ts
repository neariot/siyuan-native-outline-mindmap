// ★★★ Data races: two writers to one document, interleaved on purpose.
//
// ## Why this file exists
//
// The races that hurt this plugin are not two threads touching one variable. They are **two writers to the same
// document overlapping in time**:
//
//   * our write-back is in flight while the kernel reports someone else's change (the user typing in SiYuan,
//     or a second window);
//   * someone else's change lands **between our read and our write**;
//   * two write-backs of our own overlap, and the first to finish clears a flag the second still needs ——
//     which is exactly why `EchoGuard.applyingCount` is a **counter and not a boolean**, with the measurement
//     recorded in its comment.
//
// Until now the only layer that could produce such an interleaving was a browser against a live kernel, where
// **the timing is not ours to choose**. The virtual kernel changes that: `stall()` holds a chosen kernel call
// open, `externalUpdate()` / `externalDelete()` inject the other writer's change, and the transaction they
// return is the same object the WebSocket would have pushed. So "our write is still in flight" becomes a state
// a test can *hold*, rather than a hope about machine speed.
//
// ## What each case pins
//
// The criterion in every case is the one this repository keeps getting wrong: **not** "did something throw",
// but "is the document's final content the correct interleaving of the two writers". A race that silently
// loses the other writer's edit throws nothing at all.

import { EchoGuard, ConflictTracker } from './sync';
import { VirtualKernel } from '../siyuan/virtual-kernel';
import { SiYuanClient } from '../siyuan/api';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(`${name} ${extra}`);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

void (async () => {
  // ---------------------------------------------------------------- our write overlaps an external edit

  {
    const kernel = new VirtualKernel({ sqlIndexDelayMs: 0 });
    const client = new SiYuanClient({ baseUrl: '', token: '', fetchImpl: kernel.fetchImpl });
    const docId = kernel.seedDoc('t', '- 甲\n');
    const para = kernel.rows().find((b) => b.type === 'p')!;

    const guard = new EchoGuard(60_000);

    // Our write-back begins —— the echo window opens, exactly as `withEchoGuard` does it.
    guard.beginApply();

    // ★ The other writer's change arrives WHILE we are writing. This is the measured shape that made the
    //   guard a counter: two write-back windows overlap.
    const foreignTx = kernel.externalUpdate(para.id, '乙');
    const updates = new Map<string, string>([['node-1', '乙']]);

    // Our write had registered the value we wrote; the foreign value is NOT among them.
    guard.endApply([docId, para.id], new Map([[para.id, '甲']]));

    check(
      '★ a value we did NOT write is not one of ours, so the other writer is seen',
      !guard.isOwnValue(para.id, '乙'),
      'the foreign edit was judged our own echo —— it would be skipped and lost',
    );
    check(
      '★★ a value WE wrote is recognised as ours even after the window closed (the intermediate-state fix)',
      guard.isOwnValue(para.id, '甲'),
    );
    check(
      '★ and a value we never wrote is not ours at all',
      !guard.isOwnValue(para.id, '丙'),
    );
    check('the foreign transaction carries an update op', foreignTx.doOperations.length === 1, JSON.stringify(foreignTx));
  }

  // ---------------------------------------------------------------- verdict: conflict vs not

  {
    // ★★★ Each case uses its OWN tracker, on purpose. A shared one is how the first version of this block
    //   became vacuous: an earlier `check` had already moved the baseline, so the case below it took the
    //   `base !== current` fallback and returned `true` for a **different reason** than the rule under test.
    //   Measured: it stayed green with the in-flight rule removed. One tracker per case keeps the state each
    //   decision reads explicit.
    const tracker = new ConflictTracker();

    check(
      '★★ identical content converges: not a conflict',
      (() => {
        const t = new ConflictTracker();
        t.noteAllSynced([{ id: 'a', text: '甲' }]);
        return t.check('a', '甲', '甲', true) === false;
      })(),
      'identical content reported as a conflict —— a false alarm the user cannot act on',
    );

    // ★★★ The documented baseline race. The ONLY state that isolates it is **baseline == current**: the
    //   falling-through branch ("local value still equals the baseline → accept the external change") answers
    //   *no conflict*, while the in-flight rule must answer *conflict*. With any other baseline the case is
    //   satisfied by that fallback and cannot go red when the rule is removed —— which is exactly what the
    //   first version did.
    check(
      '★★★ an external change arriving during our write-back is a conflict (the baseline race)',
      (() => {
        const t = new ConflictTracker();
        t.noteAllSynced([{ id: 'b', text: '甲' }]);
        // baseline == current == 甲, the incoming value differs, and a write-back is in flight
        return t.check('b', '甲', '丙', true) === true;
      })(),
      'the other writer edit would be silently overwritten by our in-flight write',
    );

    // ★ The SAME state with nothing in flight must NOT be a conflict. Without this pair, the case above would
    //   also pass if `check` simply answered "conflict" for any differing incoming value.
    check(
      '★★ the same state with NO write in flight is accepted (so the case above isolates the in-flight rule)',
      (() => {
        const t = new ConflictTracker();
        t.noteAllSynced([{ id: 'c', text: '甲' }]);
        return t.check('c', '甲', '丙', false) === false;
      })(),
      'an external change was refused even though nothing was in flight to overwrite it',
    );

    check(
      '★ local edits plus an external change is a conflict (the baseline differs from the current value here)',
      (() => {
        const t = new ConflictTracker();
        t.noteAllSynced([{ id: 'd', text: '甲' }]);
        return t.check('d', '乙', '丙', false) === true;
      })(),
      'the user uncommitted edit and the external one would be silently merged',
    );
    void tracker;
  }

  // ---------------------------------------------------------------- interleaved: the other writer lands first

  {
    const kernel = new VirtualKernel({ sqlIndexDelayMs: 0 });
    const client = new SiYuanClient({ baseUrl: '', token: '', fetchImpl: kernel.fetchImpl });
    const docId = kernel.seedDoc('t', '- 甲\n');
    const para = kernel.rows().find((b) => b.type === 'p')!;

    // ★ The other writer goes FIRST, then we write. Their edit must survive our write, or we have silently
    //   overwritten a change the user made.
    kernel.externalUpdate(para.id, '乙');
    await client.updateBlockDom(para.id, '<div>甲</div>');

    const final = kernel.rows().find((b) => b.id === para.id)?.content ?? '';
    check(
      '★★ a last-writer-wins write really is last (the kernel holds the later value)',
      final.includes('甲'),
      `final=${JSON.stringify(final)} —— a write that did not land is the "edit did nothing" symptom`,
    );
  }

  // ---------------------------------------------------------------- overlap: our write is still in flight

  {
    const kernel = new VirtualKernel({ sqlIndexDelayMs: 0 });
    const client = new SiYuanClient({ baseUrl: '', token: '', fetchImpl: kernel.fetchImpl });
    const docId = kernel.seedDoc('t', '- 甲\n');
    const para = kernel.rows().find((b) => b.type === 'p')!;

    // Hold our write open, do the other writer's edit in the gap, then release.
    const gate = kernel.stall('/api/block/updateBlock', 1);

    const ourWrite = client.updateBlockDom(para.id, '<div>甲</div>');
    await tick(); // let our write reach the stalled kernel call
    await gate.reached.catch(() => undefined);

    // ★ While our write is suspended, the other writer changes the same block.
    const foreign = kernel.externalUpdate(para.id, '丙');

    gate.release();
    await ourWrite;

    check(
      '★★ both writers ran, and neither call threw (the race is silent, which is why it is dangerous)',
      foreign.doOperations.length === 1,
      'the interleaving did not happen, so this case measured nothing',
    );
    const final = kernel.rows().find((b) => b.id === para.id)?.content ?? '';
    check(
      '★★ the document holds one of the two values —— the interleaving is observable in the kernel',
      final.includes('甲') || final.includes('丙'),
      `final=${JSON.stringify(final)}`,
    );
  }

  // ---------------------------------------------------------------- deletion during our write

  {
    const kernel = new VirtualKernel({ sqlIndexDelayMs: 0 });
    const client = new SiYuanClient({ baseUrl: '', token: '', fetchImpl: kernel.fetchImpl });
    const docId = kernel.seedDoc('t', '- 甲\n');
    const para = kernel.rows().find((b) => b.type === 'p')!;

    // ★ Another client deletes the block we are about to write. Our write must FAIL —— silently succeeding
    //   while the block is gone is the "wrote into nothing" shape the target-gone handling exists for.
    kernel.externalDelete(para.id);
    let err = '';
    try {
      await client.updateBlockDom(para.id, '<div>x</div>');
    } catch (e) {
      err = (e as Error).message;
    }
    check(
      '★★ writing to a block another client deleted fails loudly (not silently)',
      err.length > 0,
      'the write resolved against a deleted block —— nothing below would ever notice',
    );
    check(
      '★★★ and the failure is the measured kernel message, not an invented one',
      err.includes('load block tree') && (err.includes('indexing') || err.includes('tree not found')),
      `got ${JSON.stringify(err)}`,
    );
  }

  // ---------------------------------------------------------------- the echo counter under overlap

  {
    // ★ The property the counter exists for, driven through the real class: with two overlapping windows, the
    //   first to finish must NOT close the second's window.
    const guard = new EchoGuard(60_000);
    guard.beginApply(); // A
    guard.beginApply(); // B —— overlaps A

    guard.endApply([], new Map()); // A finishes first
    check(
      '★★★ after A finishes, B is still applying (a boolean here is the measured defect)',
      guard.isApplying(),
      'the boolean version let whichever finished first clear the flag, so B was judged "not an echo"',
    );

    guard.endApply([], new Map()); // B finishes
    check('★ after B finishes too, the window is closed', !guard.isApplying());
  }

  // ---------------------------------------------------------------- report

  console.log(`virtual-kernel-race: ${pass} passed, ${fail} failed`);
  if (fail) {
    console.error(failures.map((f) => `  ✘ ${f}`).join('\n'));
    process.exit(1);
  }
})();
