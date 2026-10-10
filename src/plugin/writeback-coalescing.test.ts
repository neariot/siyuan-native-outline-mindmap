/**
 * Coalescing semantics of the write-back queue (see section 3.3 of `.logs/perf-test-design.md`).
 *
 * ──────────────────────────────────────────────────────────────────
 * The questions this section answers
 * ──────────────────────────────────────────────────────────────────
 *
 * "30 keystrokes in a row - how many low-level write-backs are actually issued?"
 * "10 nodes created in a row - does it really write only twice?"
 *
 * The design doc worries that write coalescing fails: if every keystroke really issued a write-back, a 2,000-node document
 * would instantly crush the kernel and the UI would sit at "Saving..." forever.
 *
 * ──────────────────────────────────────────────────────────────────
 * Why replicate instead of calling mount.ts directly
 * ──────────────────────────────────────────────────────────────────
 *
 * `mount.ts`'s logic is bound to React refs, closures and the store, so it cannot be called on its own.
 * So here we **copy its algorithmic skeleton** (`enqueue` serialization + `pendingWriteRef` coalescing +
 * re-check after waiting), counting with a fake store.
 *
 * The risk is that the replica drifts —— copy it wrong and the test measures nothing. So:
 *   · the algorithm is copied line by line against `mount.ts:295`(enqueue), `mount.ts:497`(writeLatest);
 *   · and two **bugs that really happened** are replicated as negative criteria (see below),
 *     to make sure this model can really tell a "correct implementation" from a "wrong" one.
 *
 * ──────────────────────────────────────────────────────────────────
 * The two historical bugs this must catch
 * ──────────────────────────────────────────────────────────────────
 *
 * ★ bug A (measured; recorded in the comment at mount.ts:509):
 *   a write-back reads the tree at t0; later keystrokes enqueue at t1..t3 and, seeing
 *   "a write-back is already queued", return immediately, assuming it will carry their edits ——
 *   but that one **already read the tree**. So the text from t1..t3 is never written back.
 *   Measured symptom: typing a replacement string into a selection in one go leaves only its first character in SiYuan.
 *
 * ★ bug B (fixed in the same batch):
 *   the tree is captured **in the closure** at enqueue time (instead of reading the latest when it runs),
 *   which mismatches the live block map that `syncDeletions` reads → blocks just written to disk get deleted.
 *
 * So the criteria cannot just count "how many writes happened"; they must also assert that **the last edit definitely lands on disk**.
 */

export {};

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

/** Fingerprint isomorphic to mount.ts:413 (body text only; that is enough here) */
function serializeTree(tree: string[]): string {
  return tree.join('\u0001');
}

/**
 * Replica of the write-back queue. `variant` switches between the "correct implementation" and the two historical bugs,
 * to prove that this file's criteria really can tell them apart.
 */
function makeQueue(
  getTree: () => string[],
  store: { writes: string[][]; delayMs: number },
  variant: 'correct' | 'bugA' | 'bugB' = 'correct',
) {
  let queue: Promise<void> = Promise.resolve();
  let pending: Promise<void> | null = null;
  let lastWritten = '';

  /** enqueue: purely serial, mount.ts:295 */
  function enqueue(task: () => Promise<void>): Promise<void> {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function doWrite(): Promise<void> {
    await new Promise((r) => setTimeout(r, store.delayMs));
    const tree = getTree();
    store.writes.push([...tree]);
    lastWritten = serializeTree(tree);
  }

  function writeLatest(): Promise<void> {
    const prev = pending;
    if (prev) {
      if (variant === 'bugA') {
        // 🔴 bug A: assume the queued write-back will carry my edits and return immediately
        return Promise.resolve();
      }
      return prev.then(async () => {
        const again = pending;
        if (again) await again;
        if (serializeTree(getTree()) !== lastWritten) {
          await writeLatest();
        }
      });
    }
    const p = enqueue(async () => {
      if (variant === 'bugB') {
        // 🔴 bug B: freeze the tree at enqueue time (the correct implementation reads it when it runs)
        const frozen = [...getTree()];
        await new Promise((r) => setTimeout(r, store.delayMs));
        store.writes.push(frozen);
        lastWritten = serializeTree(frozen);
        return;
      }
      await doWrite();
    });
    pending = p;
    void p.finally(() => {
      if (pending === p) pending = null;
    });
    return p;
  }

  return { writeLatest, getWrites: () => store.writes };
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Type at a realistic pace: wait `gapMs` after each key before the next.
 *
 * ★ Why you cannot stuff all 30 writeLatest calls into one synchronous for loop:
 *   then they all sit in **the same macrotask**, while enqueue's task runs asynchronously ——
 *   by the time the task actually runs and reads `getTree()`, all 30 edits are already in it.
 *   so even the bug A variant that "returns as soon as something is queued" writes correct content,
 *   and the negative criterion fails (measured: the bug A variant writes 30 x's and looks perfectly fine).
 *
 *   In reality keystrokes are **spread out in time** and a write-back may be in flight,
 *   and only then does "assume the queued one carries my edits" really drop characters.
 */
async function typeKeys(
  n: number,
  gapMs: number,
  applyEdit: (i: number) => void,
  fire: () => Promise<void>,
): Promise<void> {
  const ps: Promise<void>[] = [];
  for (let i = 1; i <= n; i++) {
    applyEdit(i);
    ps.push(fire());
    if (gapMs > 0) await settle(gapMs);
  }
  await Promise.all(ps);
  await settle(200);
}

// ──────────────────────────────────────────────────────────────────
async function main() {
  // ★★ Read this before going further ★★
  //
  // The section below runs **the algorithm skeleton replicated in this file**, not `mount.ts` itself.
  // It proves the **design fact** that "this algorithm coalesces under the given timing",
  // and it **cannot** prove that the product code really wires this algorithm up.
  //
  // Measured lesson: delete the write-coalescing criterion in `mount.ts` (change it to `const prev = null`),
  // and this section still prints "30 keystrokes → 7 write-backs" with 13/13 green ——
  // because `makeQueue` never reads `mount.ts`; it tests itself.
  //
  // Whether the product code really coalesces is guarded by the **static assertions** in the later section (which read mount.ts source).
  // Only both sections together are complete: the skeleton gives order-of-magnitude intuition, the static assertions give regression protection.
  console.log('Write coalescing: merge effect of the algorithm skeleton under the given timing (see the note above, not product code)');

  {
    // Simulate continuous typing: each keystroke changes the tree once, then triggers one write-back
    let text = '';
    const store = { writes: [] as string[][], delayMs: 25 };
    const q = makeQueue(() => [text], store);

    // Keystroke pace: one every 6ms (far faster than the 25ms write-back,
    // so new keystrokes really do arrive while a write-back is in flight)
    await typeKeys(30, 6, (i) => { text = 'x'.repeat(i); }, () => q.writeLatest());

    const writes = q.getWrites();
    console.log(`     30 keystrokes → ${writes.length} write-backs`);

    check(
      '★ 30 keystrokes produce far fewer write-backs than keystrokes (coalescing works)',
      writes.length < 30,
      `got ${writes.length}`,
    );
    // ★ The threshold is computed, not guessed.
    //
    //   The design doc says "strictly coalesced to 1~2", but that is the ideal **under no load**: it assumes
    //   the write-back finishes instantly with no new keystrokes in between. A real write-back takes time, and keystrokes during it
    //   each trigger another one (that is necessary —— guard A exists precisely so these edits are not lost).
    //
    //   In this model a write-back takes 25ms and keystrokes are 6ms apart ⇒ about 4 keystrokes per write-back
    //   ⇒ 30 / 4 ≈ 7. **That is the correct coalescing result, not a defect.**
    //   It was once treated as a failure and "fixed" - that would have broken things.
    //
    //   So what is asserted here is "coalescing really happens by an order of magnitude": 30 keystrokes should not produce
    //   close to 30 write-backs. A hard number like <=5 would go falsely red if the write-back cost changes.
    check(
      'Algorithm skeleton: write-backs for 30 keystrokes ≤ half',
      writes.length <= 15,
      `got ${writes.length}`,
    );
    check(
      'Algorithm skeleton: write-backs do not grow linearly with keystrokes (a broken model would give 30)',
      writes.length < 30 / 3,
      `got ${writes.length}`,
    );

    // ★★ The most critical one: the last edit must land on disk
    const last = writes[writes.length - 1];
    check(
      'Algorithm skeleton: the content of the last keystroke must reach the backend (losing it means bug A)',
      last !== undefined && last[0] === 'x'.repeat(30),
      `the last content written is ${JSON.stringify((last ?? [''])[0].slice(0, 12))}, expected 30 x's`,
    );
  }

  // ────────────────────────────────────────────────────────────────
  console.log('\n10 nodes created in a row (the design doc says: only ~2 write-backs)');

  {
    const nodes: string[] = [];
    const store = { writes: [] as string[][], delayMs: 25 };
    const q = makeQueue(() => [...nodes], store);

    await typeKeys(10, 6, (i) => { nodes.push(`节点${i}`); }, () => q.writeLatest());

    const writes = q.getWrites();
    console.log(`     10 creations → ${writes.length} write-backs`);
    check(
      'Algorithm skeleton: write-backs for 10 nodes in a row ≤ 4',
      writes.length <= 4,
      `got ${writes.length}`,
    );
    check(
      'Algorithm skeleton: all 10 nodes appear in the last write-back (no node is lost)',
      (writes[writes.length - 1] ?? []).length === 10,
      `got ${(writes[writes.length - 1] ?? []).length}`,
    );
  }

  // ────────────────────────────────────────────────────────────────
  console.log('\nGuard the two anti-character-loss guards in the real source (static assertions)');

  {
    // ★ Why not keep using "build a bug variant and see whether the model drops characters" as negative verification:
    //
    //   It was tried, but those two historical bugs cannot be reproduced —— my replica differs from mount.ts's real
    //   timing (when enqueue's task reads the tree, when the React ref updates -
    //   none of that a setTimeout model can reproduce). If the negative criterion cannot be reproduced,
    //   it proves nothing: a criterion that cannot catch a known bug is empty.
    //
    //   Instead use what this repo already does (see section ⑨ of paragraphs-ui.test.ts):
    //   **read the source directly and assert on its structure**. That is deterministic, with no timing-model drift,
    //   and it asserts exactly "is this guard code still there" —— touching it in a regression turns it red.
    const fs = require('node:fs');
    const mount = fs.readFileSync('src/plugin/mount.ts', 'utf8');
    const wl = mount.slice(
      mount.indexOf('const writeLatest = React.useCallback'),
      mount.indexOf('writeLatestRef.current = writeLatest'),
    );

    check('writeLatest implementation is found', wl.length > 0);

    // Guard A: after waiting for the previous write-back, it must **re-check once more**
    //(otherwise "return as soon as something is queued" leaves later edits never written back —— measured character loss)
    check(
      '★ Guard A: after waiting, compare the fingerprint again and write the missing part (so later edits are not swallowed)',
      /prev\.then\(/.test(wl) &&
        /serializeTree\(nodesRef\.current[^)]*\)\s*!==\s*lastWrittenTreeRef\.current/.test(wl) &&
        /await writeLatestRef\.current\(\)/.test(wl),
      'needs the chain "prev.then → compare serializeTree(nodesRef.current) → call writeLatest again"',
    );

    // Guard B: the task body must read nodesRef.current **when it executes**,
    // rather than freezing the tree into a closure variable copy at enqueue time
    const taskBody = wl.slice(wl.indexOf('const p = enqueue'));
    check(
      '★ Guard B: read nodesRef.current at execution time (do not freeze the tree as of enqueue)',
      /const tree = nodesRef\.current/.test(taskBody),
      'nodesRef.current must be read inside the enqueue task body',
    );

    // ★★ Write coalescing itself: the pendingWriteRef "a write-back is already queued" criterion must exist.
    //
    //   This is the **only assertion in the whole file that really guards product write coalescing**.
    //   The behavioural assertions in the earlier section cannot catch it —— measured: changing the
    //   `const prev = pendingWriteRef.current` here to `const prev = null`
    //   (which turns write coalescing off entirely) still prints "30 keystrokes → 7 write-backs",
    //   and everything stays green, because it tests its own replica.
    const readPrev = /const prev = pendingWriteRef\.current/.test(wl);
    check(
      '★★ Write coalescing: read "is a write-back already queued" from pendingWriteRef',
      readPrev,
      'must be `const prev = pendingWriteRef.current`; writing null there turns coalescing off',
    );
    check(
      '★★ Write coalescing: the code path "if queued, take the waiting branch" exists',
      /if \(prev\) \{/.test(wl),
      'without the if (prev) branch ⇒ every keystroke really issues a write-back',
    );

    // enqueue must be serial (concurrent write-backs scramble block operations)
    // ★ Both ends are anchored on **code**.
    //   Anchoring on comment text fails silently: change the comment and indexOf returns -1,
    //   while slice(start, -1) does not complain —— it takes the whole tail of the file as the region,
    //   and the assertion still goes green on the wrong text.
    const enqStart = mount.indexOf('const enqueue = React.useCallback');
    const enqEnd = mount.indexOf('}, []);', enqStart);
    const enq = mount.slice(enqStart, enqEnd);
    check(
      '★ enqueue region located successfully (a broken anchor must go red, never pass silently)',
      enqStart >= 0 && enqEnd > enqStart && enq.length < 2000,
      `enq length ${enq.length} —— slice anchor is broken`,
    );
    check(
      '★ enqueue serial: the queue chains on, instead of firing concurrently',
      /queueRef\.current\.then\(task, task\)/.test(enq),
    );
    check(
      '★ enqueue swallows exceptions: one failure does not stall every later write-back',
      /queueRef\.current = run\.then\(/.test(enq),
    );
  }

  // ────────────────────────────────────────────────────────────────
  console.log('\nserializeTree fingerprint cost (the hotspot 3.3-① worried about; replicated implementation, not product code)');

  {
    // Replicate the DFS + template-string concatenation of mount.ts:413
    interface N { id: string; text: string; children_: N[] }
    const build = (n: number, depth = 0): N[] => {
      const out: N[] = [];
      for (let i = 0; i < n; i++) {
        out.push({
          id: `n${depth}-${i}`,
          text: 'x'.repeat(30),
          children_: depth < 3 ? build(Math.max(1, Math.floor(n / 8)), depth + 1) : [],
        });
      }
      return out;
    };
    const serialize = (tree: N[]): string => {
      const parts: string[] = [];
      const walk = (l: N[]): void => {
        for (const n of l) {
          parts.push(`${n.id}:${n.text ?? ''}`);
          if (n.children_.length) walk(n.children_);
        }
      };
      walk(tree);
      return parts.join('\n');
    };

    const count = (t: N[]): number =>
      t.reduce((a, n) => a + 1 + count(n.children_), 0);

    const big = build(200);
    const total = count(big);

    serialize(big);
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      serialize(big);
      const dt = performance.now() - t0;
      if (dt < best) best = dt;
    }
    console.log(`     serializing ${total} nodes once takes ${best.toFixed(2)}ms`);
    check(
      '★ Fingerprinting ~2000 nodes < 50ms (it will not become a bottleneck on every keystroke)',
      best < 50,
      `measured ${best.toFixed(2)}ms`,
    );
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

void main();
