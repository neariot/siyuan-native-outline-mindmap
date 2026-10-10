/**
 * "Fit" must live up to its name: it really fits all nodes and does not decide the font size for the user (regression test).
 *
 * ──────────────────────────────────────────────────────────────────
 * Symptom
 * ──────────────────────────────────────────────────────────────────
 *
 * Open a mind map on a narrow phone screen (or in a narrow sidebar) and a wide map **does not fit**——
 * the right/bottom edge is cut off; seeing the whole thing takes panning by hand.
 *
 * ──────────────────────────────────────────────────────────────────
 * Root cause
 * ──────────────────────────────────────────────────────────────────
 *
 * `fit()` had a readability floor `MIN_READABLE_K` (0.55 on narrow screens / 0.3 on wide ones):
 *
 *     const k = Math.min(1.2, Math.max(MIN_READABLE_K, fitK));
 *
 * The idea at the time was "rather scroll horizontally than shrink into a blur". But:
 *
 * ① **the button is lying** —— its tooltip says "zoom to show exactly all nodes",
 *    yet with the floor clamping it, it precisely does not fit;
 * ② **not only the button** —— `fit()` is also called by "open the panel", "switch structure"
 *    and "auto-fit after dragging the splitter"; relaxing only the button leaves the most common paths broken.
 *
 * Now fit has no floor: if it does not fit, it does not fit, and that is reported honestly.
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

const src = fs.readFileSync('src/mindmap/Mindmap.tsx', 'utf8');

/** Extract the body of fit() */
function fitBody(): string {
  const start = src.indexOf('const fit = (): void => {');
  if (start < 0) return '';
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

const body = fitBody();

console.log('① fit() can be located');

check('★ the fit() body is located', body.length > 0, 'fit() not found —— did the regex/structure change?');
check('★ fit() is not an empty shell', body.length > 200, `only ${body.length} bytes`);

console.log('\n★★ fit must not clamp the zoom (that is the defect itself)');

check(
  '★★ MIN_READABLE_K is gone from fit()',
  !/MIN_READABLE_K/.test(body),
  'the readability floor is back —— narrow screens will not fit again',
);

check(
  '★★ the zoom has no Math.max(…, fitK) floor',
  !/Math\.max\([^)]*fitK/.test(body),
  'fitK is clamped by a floor again',
);

check(
  '★★ the zoom is decided only by the container and the map size',
  /Math\.min\(1,\s*\(cw\s*-\s*pad\)\s*\/\s*layout\.w,\s*\(ch\s*-\s*pad\)\s*\/\s*layout\.h\)/.test(body),
  'the fit zoom formula changed; it should be min(1, available width/map width, available height/map height)',
);

console.log('\n③ a very wide map must fit too (the scenario that regresses this defect)');

{
  // Reproduce fit's zoom computation to verify "wide map + narrow container" really yields a tiny k
  const calc = (cw: number, ch: number, layoutW: number, layoutH: number): number => {
    const narrow = cw < 560;
    const pad = narrow ? 24 : 48;
    return Math.min(1, (cw - pad) / layoutW, (ch - pad) / layoutH);
  };

  // Phone dock 390px, map width 1800px (a horizontally spread mind map is very common)
  const kNarrow = calc(390, 780, 1800, 700);
  // Exact value = (390-24)/1800 = 0.20333… (pad=24 on narrow screens)
  check(
    '★★ 390px container + 1800px wide map → the zoom equals the exact computed value (no floor at all)',
    Math.abs(kNarrow - 366 / 1800) < 1e-9,
    `got ${kNarrow.toFixed(6)}, expected ${(366 / 1800).toFixed(6)}`,
  );
  check(
    '★★ this value is clearly below the old readability floor 0.55 (proof the floor is really gone)',
    kNarrow < 0.55,
    `got ${kNarrow.toFixed(3)}`,
  );
  check(
    '★ at this zoom the whole map really fits inside the container',
    1800 * kNarrow <= 390 && 700 * kNarrow <= 780,
    `the map spans ${Math.round(1800 * kNarrow)}px, container 390px`,
  );

  // A common desktop dock is 800px
  const kDesk = calc(800, 600, 1200, 700);
  check('★ 800px container + 1200px wide map → normal zoom', kDesk > 0.5 && kDesk < 1, `got ${kDesk.toFixed(3)}`);

  // A small map must not be scaled above 1 inside the container
  const kSmall = calc(1200, 800, 300, 200);
  check('★ a small map is not scaled above 1 (stays at 100%)', kSmall === 1, `got ${kSmall}`);
}

console.log('\n④ the promise of the button matches its behaviour');

{
  check('★ the button references tipFitCanvas i18n key', src.includes("t('tipFitCanvas')"), 't(\'tipFitCanvas\') not found in Mindmap.tsx');
  const zh = JSON.parse(fs.readFileSync('src/plugin/i18n/zh_CN.json', 'utf8')) as Record<string, string>;
  const en = JSON.parse(fs.readFileSync('src/plugin/i18n/en_US.json', 'utf8')) as Record<string, string>;
  const tipZh = zh.tipFitCanvas ?? '';
  const tipEn = en.tipFitCanvas ?? '';
  check('★ the zh tooltip promises "shows exactly all nodes"', tipZh.includes('全部节点'), tipZh || 'tooltip not found');
  check('★ the en tooltip promises "Fit to canvas"', tipEn.includes('canvas'), tipEn || 'tooltip not found');
  check(
    '★ the tooltip was not softened into a vague "show as much as possible" (the behaviour got stricter, the wording need not give way)',
    !/尽量|尽可能/.test(tipZh),
    tipZh,
  );
}

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}