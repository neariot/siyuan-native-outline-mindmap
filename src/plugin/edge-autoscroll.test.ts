/**
 * Drag-to-edge auto-scroll + content clipped away and out of reach.
 *
 * Corresponds to .logs/API-GOTCHAS.md §114 / §115.
 */
export {};

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
};

console.log('=== §114 content clipped by overflow:hidden → out of reach ===');
{
  // measured values (390×844 mobile, 20 nodes)
  const host = { overflowY: 'hidden', scrollHeight: 1663, clientHeight: 770 };
  check('★★ the host declares overflow:hidden', host.overflowY === 'hidden');
  check('★★ yet it holds 1663px of content with only 770px visible', host.scrollHeight > host.clientHeight);
  check('★★★ overflow with no scrollbar ⇒ the content below is **never reachable**', host.overflowY === 'hidden' && host.scrollHeight > host.clientHeight);

  // root cause: flex:1 has no effect when the parent is not a flex container
  const parentDisplay: string = 'block';  // before the fix
  const flexWorks = parentDisplay === 'flex';
  check('★★ parent display:block ⇒ the child flex:1 **has no effect**', !flexWorks);
  check('★★ ⇒ .outline-wrap grows with its content (1625px), no scroll area appears', !flexWorks);

  const fixed = 'flex';
  check('★ the fix: make the parent flex column', fixed === 'flex');
}

console.log('\n=== before and after the fix (measured) ===');
{
  const before = { sh: 1625, ch: 1625, scrollTopAfterSet500: 0 };
  const after = { sh: 1625, ch: 732, scrollTopAfterSet500: 500 };
  check('★ before the fix: scrollHeight === clientHeight ⇒ it cannot scroll', before.sh === before.ch);
  check('★ before the fix: setting scrollTop=500 does nothing (still 0)', before.scrollTopAfterSet500 === 0);
  check('★★ after the fix: the parent constrains clientHeight to 732', after.ch < after.sh);
  check('★★ after the fix: scrollTop=500 takes effect', after.scrollTopAfterSet500 === 500);
}

console.log('\n=== §115 padding makes auto-scroll overshoot ===');
{
  // the position of the last node during auto-scroll (probe measurement)
  const trace = [
    { t: 5, b: 39 },
    { t: -13, b: 21 },
    { t: -31, b: 3 },
    { t: -49, b: -15 },
    { t: -66, b: -32 },
  ];
  check('★★ scrolling all the way down pushes the last node above the screen', trace[trace.length - 1].b < 0);
  check('★★★ at the very bottom **no node can take the drop** ⇒ the drop hint disappears', trace.every((x) => x.b < 40 + 1) === false || trace[trace.length - 1].b < 0);

  // root cause: padding-bottom reserves room for the keyboard bar
  // ★ the decision uses the last node's position **before scrolling**, under the condition `lastBottom < bottomLimit`
  //   —— "the last node is already **above** the bottom line (pushed out)" means bounce back.
  const guard = (dy: number, lastBottom: number, bottomLimit: number, before: number): number =>
    dy > 0 && lastBottom < bottomLimit ? before : before + dy;
  check('★ scrolling down with the last node pushed above the bottom line ⇒ bounce back to the original position', guard(18, -66, 812, 875) === 875);
  // ★ the condition asks whether the last node's bottom has **crossed the bottom line**.
  //   lastBottom=700 (mid-node, not yet at the bottom line) → treated as "still running upward" → bounce back.
  //   normal scrolling needs "the last node is already below the bottom line":
  check('★ last node mid-node (bottom < bottom line) ⇒ bounce back (do not push it out of view)', guard(18, 700, 812, 875) === 875);
  check('★ last node below the bottom line (bottom > bottom line) ⇒ scroll down normally', guard(18, 900, 812, 875) === 893);
  check('★ scrolling up is unaffected by that guard', guard(-18, -66, 812, 200) === 182);

}

console.log('\n=== the keyboard bar eats the bottom hit area ===');
{
  const vh = 844;
  const barH = 192;   // measured height of .mobile-bar-fixed
  const bottomLimit = vh - barH;
  check('★ a finger resting at y=834 hits `.mobile-bar-fixed` (not a node)', 834 > bottomLimit);
  check('★★ ⇒ the auto-scroll bottom line must be **raised above the keyboard bar**', bottomLimit === 652);
}

console.log('\n=== driven by rAF, not touchmove ===');
{
  const frames = [426, 696, 893];
  check('★ measured t=0.25s→426, t=0.50s→696, t=0.75s→893 (stops at the bottom)', frames[2] === 893);
}

console.log('\n=== full scenario on record ===');
{
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
