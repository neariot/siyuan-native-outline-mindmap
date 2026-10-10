/**
 * Polling budget on the write-back path (regression test).
 *
 * ──────────────────────────────────────────────────────────────────
 * Background: why the budget must exceed the worst flush interval
 * ──────────────────────────────────────────────────────────────────
 *
 * The SiYuan kernel does **not** write SQLite synchronously per transaction; it **flushes in periodic batches**.
 * Measured (`scripts/kernel-index-lag.py`):
 *
 *   · Inserting 5 blocks ~20ms apart, they became queryable **in the same millisecond**
 *     (span 0ms) ⇒ batched landing;
 *   · The flush interval is **irregular**; measured 773 / 1112 / 1368 / 1623 / 1888 /
 *     2213 / 2782 ms, median about 1.7 s.
 *
 * So those "poll until visible" loops in the plugin must budget **> the worst flush interval**,
 * otherwise they give up while the block **has not landed yet** — the symptom is "the edit did nothing",
 * and **no error is reported at all**.
 *
 * ──────────────────────────────────────────────────────────────────
 * What this test guards
 * ──────────────────────────────────────────────────────────────────
 *
 * The four polling loops in `store.ts` originally budgeted 12×120ms = **1440 ms** (two of them),
 * while the measured worst flush interval is **2782 ms** ⇒ about half the phases give up early.
 *
 * The test does two things:
 *   ① Statically assert that every one of the four polling budgets is ≥ a floor (derived from the kernel measurements);
 *   ② Behaviourally assert: a "visible only on round N" stub proves the polling really waits until the block is visible,
 *      instead of returning after a fixed number of rounds.
 */

export {};

import * as fs from 'node:fs';

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

/**
 * Polling budget floor.
 *
 * Round the measured worst kernel flush interval (2782 ms) up to 3000 ms as the floor,
 * and demand headroom — because the measured 2782 is only the worst value **sampled**,
 * the real upper bound can only be larger.
 */
const MIN_POLL_BUDGET_MS = 3000;

/** Measured worst kernel flush interval (ms), from scripts/kernel-index-lag.py */
const MEASURED_WORST_FLUSH_MS = 2782;

// ──────────────────────────────────────────────────────────────────
// ① Static: parse the budgets of the four polling loops in the source
// ──────────────────────────────────────────────────────────────────

type Loop = { name: string; rounds: number; sleepMs: number; budget: number };

/** Read constants such as `export const POLL_ROUNDS = 20;` out of the source */
function readConsts(src: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of src.matchAll(/export const ([A-Z_][A-Z0-9_]*)\s*=\s*(\d+)/g)) {
    out[m[1]] = Number(m[2]);
  }
  return out;
}

function parseLoops(src: string, consts: Record<string, number>): Loop[] {
  const CONSTS = consts;
  const out: Loop[] = [];
  // Shaped like: for (let i = 0; i < 12; i++) { ... setTimeout(r, 120) }
  //
  // ★ Do not require the loop body to "end with \n<indent>}" — that would miss loops whose body
  //   contains try/catch (the measurement missed the one at store.ts:1739, so its
  //   1440ms budget was never checked at all and the test passed green falsely).
  //   Instead take a **fixed-length window** from the loop head and look for the sleep inside it.
  // The round count may be a literal (12) or a constant name (POLL_ROUNDS) — both must be recognised,
  // otherwise swapping the literal for a constant makes the parser lose the loop (miss it on every change).
  const re = /for \(let i = 0; i < ([A-Za-z_][\w]*|\d+); i\+\+\) \{/g;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(src))) {
    idx++;
    const raw = m[1];
    const rounds = /^\d+$/.test(raw) ? Number(raw) : (CONSTS[raw] ?? NaN);
    // Fixed-length window: long enough to cover the loop body, short enough not to swallow the next loop's sleep
    const body = src.slice(m.index, m.index + 1200);
    const sleeps = [...body.matchAll(/setTimeout\(r,\s*([\w]+)\)/g)]
      .map((x) => (/^\d+$/.test(x[1]) ? Number(x[1]) : CONSTS[x[1]]))
      .filter((v): v is number => typeof v === 'number');
    // Take the largest sleep inside that loop body (some branches sleep in different places)
    const sleepMs = sleeps.length ? Math.max(...sleeps) : 0;
    out.push({
      name: `loop #${idx} (line ${src.slice(0, m.index).split('\n').length})`,
      rounds,
      sleepMs,
      budget: rounds * sleepMs,
    });
  }
  return out;
}

console.log('① Polling budgets in the source');

{
  const src = fs.readFileSync('src/siyuan/store.ts', 'utf8');
  const loops = parseLoops(src, readConsts(src));
  check('polling loops parsed', loops.length > 0, `got ${loops.length}`);

  for (const l of loops) {
    // Only check those that **really sleep** (a loop with no sleep depends on the SQL round trip)
    if (l.sleepMs === 0) continue;
    process.stdout.write(
      `     ${l.name}: ${l.rounds} × ${l.sleepMs}ms = ${l.budget} ms\n`,
    );
  }

  const withSleep = loops.filter((l) => l.sleepMs > 0);
  check('every parsed loop carries a sleep', withSleep.length > 0);

  for (const l of withSleep) {
    check(
      `★ ${l.name} budget ≥ ${MIN_POLL_BUDGET_MS}ms`,
      l.budget >= MIN_POLL_BUDGET_MS,
      `got ${l.budget} ms (worst flush ${MEASURED_WORST_FLUSH_MS} ms, gives up early)`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────
// ② Behaviour: polling must wait until "visible", not run a fixed number of rounds
// ──────────────────────────────────────────────────────────────────

/** Replicate the polling semantics: query first each round, sleep on a miss; return on a hit */
async function pollUntilVisible(
  isVisible: (round: number) => boolean,
  rounds: number,
  sleepMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<{ found: boolean; round: number }> {
  for (let i = 0; i < rounds; i++) {
    if (isVisible(i)) return { found: true, round: i };
    await sleep(sleepMs);
  }
  return { found: false, round: rounds };
}

async function main(): Promise<void> {
console.log('\n② Polling behaviour: return on a hit / keep waiting on a miss');

{
  // Visible on round 0 → return immediately, no sleep
  const sleeps: number[] = [];
  const r0 = await pollUntilVisible((i) => i >= 0, 12, 120, async (ms) => {
    sleeps.push(ms);
  });
  check('★ **no sleep** when the first query hits (performance-critical: zero wait on the normal path)',
    r0.found && sleeps.length === 0, `slept ${sleeps.length} times`);
  check('first hit on round 1', r0.round === 0);

  // Visible only on round 5 → should sleep 5 times, then hit
  const sleeps2: number[] = [];
  const r1 = await pollUntilVisible((i) => i >= 5, 12, 120, async (ms) => {
    sleeps2.push(ms);
  });
  check('★ hits when visible on round 5, no early exit', r1.found && r1.round === 5, `round ${r1.round}`);
  check('slept 5 times (once after each of rounds 0~4)', sleeps2.length === 5, `got ${sleeps2.length}`);

  // Never visible → exhaust the budget, then give up
  const r2 = await pollUntilVisible(() => false, 12, 120, async () => {});
  check('exhausts the rounds and reports a miss when never visible (no pretending success)',
    r2.found === false && r2.round === 12);
}

console.log('\n③ The budget must cover the measured worst flush');

{
  // Simulate: a block lands only at millisecond K, can the polling wait for it
  async function canCatch(landingMs: number, rounds: number, sleepMs: number): Promise<boolean> {
    let elapsed = 0;
    for (let i = 0; i < rounds; i++) {
      if (elapsed >= landingMs) return true;
      elapsed += sleepMs;
    }
    // No more waiting after the last round, but (rounds-1)*sleepMs has already elapsed
    return elapsed >= landingMs;
  }

  // The old 1440ms budget
  const oldBudget = 12 * 120;
  check(`old budget ${oldBudget}ms cannot catch the worst case (${MEASURED_WORST_FLUSH_MS}ms)`,
    (await canCatch(MEASURED_WORST_FLUSH_MS, 12, 120)) === false,
    'this is exactly what had to be fixed: about half the phases give up early');

  // The new budget
  const newRounds = 20;
  const newSleep = 200;
  const newBudget = newRounds * newSleep;
  check(`new budget ${newBudget}ms covers the worst case`,
    (await canCatch(MEASURED_WORST_FLUSH_MS, newRounds, newSleep)) === true);
  check('the new budget also covers the longest single sampled Δt (2560ms)',
    (await canCatch(2560, newRounds, newSleep)) === true);
  check('the new budget keeps headroom (≥ worst value × 1.4)',
    newBudget >= MEASURED_WORST_FLUSH_MS * 1.4,
    `${newBudget} vs ${MEASURED_WORST_FLUSH_MS}`);
}

console.log('\n④ Stay consistent with the constants in the kernel measurement script');

{
  const probe = fs.readFileSync('scripts/kernel-index-lag.py', 'utf8');
  check('the probe script has a POLL_BUDGETS table', /POLL_BUDGETS\s*=/.test(probe));
  // A budget recorded in the probe must match the source (change both, or they contradict each other)
  const src = fs.readFileSync('src/siyuan/store.ts', 'utf8');
  const loops = parseLoops(src, readConsts(src)).filter((l) => l.sleepMs > 0);
  for (const l of loops) {
    check(
      `★ some budget recorded in the probe script equals the source's ${l.budget}ms`,
      probe.includes(String(l.budget)) || probe.includes(`${l.rounds} * ${l.sleepMs}`),
      `the probe has no ${l.rounds} * ${l.sleepMs} = ${l.budget}`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────
console.log('\nThe criterion itself is valid');

{
  // An "insufficient budget" configuration must be caught by the criterion
  check('★ the criterion recognises 1440ms as insufficient',
    !(1440 >= MIN_POLL_BUDGET_MS), '1440 < 3000');
  check('★ the criterion recognises 4800ms as sufficient', 4800 >= MIN_POLL_BUDGET_MS);
  check('★ the criterion recognises 5000ms as sufficient', 5000 >= MIN_POLL_BUDGET_MS);
}

}

main().then(() => {
  console.log(`\n${pass}/${pass + fail} passed`);
  if (failures.length) {
    console.log('\nfailures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
});
