// ★★★ A re-read must not overtake a write that has not been sent yet.
//
// ## The defect
//
// `handleOutlineChange` schedules a text edit through a **250 ms debounce**; nothing is enqueued
// until the timer fires. The kernel-transaction handler's re-read waits before it reads:
//
//     const waitForOwnWrite = pendingWriteRef.current ?? Promise.resolve();
//
// `pendingWriteRef` is only set once `writeLatest` has **enqueued** a job — so a debounced edit
// is not covered by the wait. The read returns the document's content, replaces the tree that
// held the edit, and the timer then writes the document's own text back. The keystroke is gone,
// with no error anywhere.
//
// Measured in a browser with the outgoing requests logged, typing into a document that contains
// a table (extra transactions on load, so a re-read lands inside the window):
//
//     t+500ms   outline=[]            ← the re-read arriving
//     t+1500ms  outline=ABC丁  kramdown=…ABC丁
//
// ## Why this file is a unit and not an E2E case
//
// The defect is a **timing race**: reproducing it end to end needs a transaction to land inside a
// 250 ms window, so an E2E case would be green or red depending on the machine — exactly the
// "passes in isolation, fails in the full suite" shape that proves nothing. What is wrong is the
// **decision rule**, and that is a pure function once it is named. The E2E case stays for the
// whole path; this pins the rule.
//
// Runs offline: python3 scripts/run-tests.py own-write-barrier

import { ownWriteBarrier } from './sync';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(`${name} ${extra}`);
  }
}

async function main(): Promise<void> {
  // ① nothing pending: the barrier must be a no-op, not a flush. A re-read on a quiet document
  //    must not cost a write.
  {
    let flushed = 0;
    await ownWriteBarrier({
      pendingWrite: null,
      debouncePending: false,
      flushDebounced: async () => {
        flushed++;
      },
    });
    check('① a quiet document is not written to', flushed === 0, `flushed=${flushed}`);
  }

  // ② ★★ A debounced edit has enqueued nothing, so waiting for `pendingWrite` is a no-op and
  //    the read overtakes it. This is the defect.
  {
    let flushed = 0;
    await ownWriteBarrier({
      pendingWrite: null,
      debouncePending: true,
      flushDebounced: async () => {
        flushed++;
      },
    });
    check('② a debounced edit is flushed before the read', flushed === 1, `flushed=${flushed}`);
  }

  // ③ a write is already running: the barrier must wait for it, not flush on top of it.
  {
    let released = false;
    let flushed = 0;
    const p = ownWriteBarrier({
      pendingWrite: new Promise<void>((r) => setTimeout(() => {
        released = true;
        r();
      }, 20)),
      debouncePending: false,
      flushDebounced: async () => {
        flushed++;
      },
    });
    await p;
    check('③ a running write is awaited', released, `released=${released}`);
    check('③ nothing is flushed on top of a running write', flushed === 0, `flushed=${flushed}`);
  }

  // ④ both: the debounced edit is flushed (which itself waits for the running write), and the
  //    barrier still ends only after everything has settled.
  {
    const order: string[] = [];
    await ownWriteBarrier({
      pendingWrite: (async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push('write');
      })(),
      debouncePending: true,
      flushDebounced: async () => {
        order.push('flush');
      },
    });
    order.push('read');
    check('④ the flush happens before the read', order[0] === 'flush', order.join('>'));
    check('④ the read happens last', order[order.length - 1] === 'read', order.join('>'));
  }

  // ⑤ ★ A failing flush must not block the re-read forever: the document is what it is, and a
  //    read is still better than a panel frozen on a stale tree.
  {
    let settled = false;
    await ownWriteBarrier({
      pendingWrite: null,
      debouncePending: true,
      flushDebounced: async () => {
        throw new Error('the write failed');
      },
    }).then(() => {
      settled = true;
    });
    check('⑤ a failed flush does not block the read', settled);
  }

  console.log(`own-write-barrier: ${pass} passed, ${fail} failed`);
  if (fail) {
    console.error(failures.map((f) => `  ✘ ${f}`).join('\n'));
    process.exit(1);
  }
}

void main();