/**
 * The tooltip attribute set: on desktop it goes through the SiYuan bubble, on mobile it falls back to the native title.
 *
 * The key behaviour locked down: **both attributes must be present at once**.
 * Giving only `aria-label` leaves mobile with no tooltip at all (inside SiYuan's `showTooltip`
 * `if (isMobile()) return;`); giving only `title` leaves the desktop style unable to follow the theme.
 */
import { tooltip, tooltipWithHint } from './tooltip';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    console.error('  ❌', name, extra ?? '');
  }
}

// ── the basic trio ──────────────────────────────────────────────
const a = tooltip('切换配色主题', 'dock-btn');
check('keeps the original class', a.className.includes('dock-btn'), a.className);
check('appends ariaLabel (SiYuan delegates mouseover through it)',
  a.className.includes('ariaLabel'), a.className);
check('the class order is not reversed', a.className.startsWith('dock-btn'), a.className);
check('writes aria-label (this is what SiYuan reads)', a['aria-label'] === '切换配色主题');
check('also writes title (the mobile fallback)', a.title === '切换配色主题');
check('default position is north', a['data-position'] === 'north');
check('passing south takes effect', tooltip('x', 'c', 'south')['data-position'] === 'south');

// ── no base class must mean no leading space ────────────────────────────────
const b = tooltip('测试');
check('no baseClass means no leading space', b.className === 'ariaLabel', JSON.stringify(b.className));

// ── empty text ──────────────────────────────────────────────────
const c = tooltip('');
check('empty text does not carry the ariaLabel class (so SiYuan does not run a pointless query)',
  !c.className.includes('ariaLabel'), c.className);
check('empty text gives an empty aria-label', c['aria-label'] === '');

// ── rich-text tooltip ──────────────────────────────────────────────
const h = tooltipWithHint('菜单项一', '菜单项二');
check('the hint is wrapped in the grey span SiYuan expects',
  h === "菜单项一 <span class='ft__on-surface'>菜单项二</span>", h);
check('with no hint it returns the text unchanged', tooltipWithHint('菜单项一', '') === '菜单项一');

// ── class is not overwritten: an existing composite class is passed in ───────────────────────
const d = tooltip('x', 'dock-btn add-btn');
check('a composite class is preserved intact',
  d.className === 'dock-btn add-btn ariaLabel', d.className);

console.log(`  tooltip: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
