/**
 * `dominant-baseline="central"` is unreliable in Safari —— compute `dy` ourselves instead.
 *
 * Two things are locked down here:
 *   1. The offset depends only on the font size and is proportional (changing the font size scales it automatically);
 *   2. Invalid input produces no NaN (NaN would make the whole run of text disappear).
 *
 * The concrete values per font size come from measurement; see the comments in `text-baseline.ts`.
 */
import { centerBaselineDy } from './text-baseline';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error('  ❌', name, extra ?? '');
  }
}

// proportional to the font size
const d14 = centerBaselineDy(14, 34);
check('14px has an offset', d14 > 0, d14);
check('proportional: 28px is twice 14px',
  Math.abs(centerBaselineDy(28, 34) - d14 * 2) < 1e-9);
check('proportional: 12px is 12/14 of 14px',
  Math.abs(centerBaselineDy(12, 34) - d14 * 12 / 14) < 1e-9);

// measured anchor: at 14px the CJK ink midpoint sits about 0.385em above the baseline
check('14px ≈ 5.39', Math.abs(d14 - 5.39) < 0.01, d14);

// invalid input must not produce NaN (it would make the text disappear entirely)
for (const [fs, h] of [[0, 34], [-1, 34], [14, 0], [14, -1], [NaN, 34], [14, NaN]] as
    Array<[number, number]>) {
  check(`invalid input (${fs}, ${h}) returns 0`, centerBaselineDy(fs, h) === 0);
}
check('a NaN font size does not produce NaN', !Number.isNaN(centerBaselineDy(NaN, 34)));

// every font size actually used should have a sensible offset
for (const fs of [10, 12, 13, 14, 15]) {
  const d = centerBaselineDy(fs, 34);
  check(`${fs}px offset is between 0.3em and 0.45em`,
    d / fs > 0.3 && d / fs < 0.45, d / fs);
}

console.log(`  text-baseline: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
