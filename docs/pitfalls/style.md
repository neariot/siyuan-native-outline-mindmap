# Pitfalls - Rendering and styles

<- [Master index](../PITFALLS.md) | Things we stepped on once and do not want to step on again; each entry reads "symptom -> cause -> practice".

Entry numbers (like `2.3`, `6.9v`) are **stable IDs**: other documents cross-reference them by
number, so keep the original numbers when splitting and never renumber. The numbers are not the order inside this file;
the `6.x` ones were moved here from the old "engineering and testing" section, grouped by topic.

### 4.1 Plugin CSS is injected globally; every selector must be scoped

**Background**: SiYuan reads `index.css` and shoves the whole thing into `<style>` -- there is no Shadow DOM,
no CSS Modules, no iframe. Every selector the plugin writes lives inside the **host page's global
scope**, sharing one class-name space with SiYuan itself and with other plugins.

**Symptom** (this really happened): `body { overflow: hidden }` stopped the whole SiYuan page from scrolling,
`button { background: none }` cleared every button's styles, and `.toolbar` collided by name with SiYuan's own
toolbar, so the desktop ended up with two toolbars.

**Key insight**: "SiYuan happens not to use this class name right now" is **not** a reason. The host gets redesigned, the user installs
another plugin, or there is even a second instance of the plugin on the same page -- any of these can suddenly collide. And this class of defect
is never visible in the development environment (only your own plugin is running there); it only blows up on the user's machine.

So the criterion is not "will it collide", but **scope it unconditionally**.

**Practice**: keep writing bare class names in the source (best readability) and add the prefix uniformly at build time:

```ts
// rsbuild.config.ts → tools.postcss
postcssPrefixSelector({ prefix: '.om-mm-host', transform: scopeSelector })
```

The prefixer lives in `scripts/css-scope.mjs`; it handles three cases:

| Input | Output | Note |
|---|---|---|
| `.node-row` | `.om-mm-host .node-row` | an ordinary bare selector |
| `.om-mm-host .x` | as-is | already scoped; it **must not** be prefixed again |
| `html[data-theme-mode='dark'] .node-row` | `html[data-theme-mode='dark'] .om-mm-host .node-row` | the prefix goes **after** `html[...]` |

The third row is where it is easy to go wrong: if you simply prepend it as `.om-mm-host html[...]`, it **never matches** in SiYuan
-- under dark mode that whole block of variables becomes dead code, the mind map keeps its light palette, and it shows up as "grey background, black text".

**Acceptance**: `scripts/verify-css-scope.py` scans the build output and fails the build if any bare selector appears;
it is wired into `npm run build` / `npm run package`. The guard's effectiveness, measured:

```
Source before the fix      -> 124 unscoped ❌ (build aborted)
Build output after the fix -> 318/318 scoped ✅
```

**Reverse verification** (proving the isolation really works): create an element with the same class name **outside** the plugin container --

```
inside  .node-row    -> display: flex   <- the style applies
outside .node-row    -> display: block  <- not matched ✅
outside .outliner-title -> max-width: none <- not matched ✅
```

**Do not hand-write `.om-mm-host .xxx`**: it is recognised as already scoped and skipped (not an error, just pointless).
The exception is the "scope base" rules (things like `box-sizing`, `font: inherit`),
which are meant to express "everything inside the plugin container" anyway; writing them by hand is clearer.

**Historical ledger**: the 7 class names this project has collided with --
`.toolbar` `.bullet` `.findbar` `.outline` `.outline-wrap` `.h1` `.h2` `.h3`.
The fix at the time was to **rename** them (add the `om-` prefix); but that only treated the symptom --
the next newly written bare class name would slip through just the same, so it was later changed to uniform build-time scoping + a build-output gate.

---


---

### 4.2 A CSS declaration overrides an SVG presentation attribute

**Symptom**: the plugin writes `fill="none"`, yet it renders as a solid black block.

**Cause**: SiYuan's `base.css` has a global `svg { fill: currentColor }`.
A CSS declaration outranks an SVG presentation attribute, so the attribute is overridden.

**Practice**: write CSS, do not change the attribute:

```css
.om-mm-host svg[fill="none"],
.om-mm-host .m-btn > svg,
.om-mm-host .dock-btn > svg { fill: none; }
```

This rule must sit outside every `@media`.
Put it inside and, when the media query does not match, the rule disappears from `el.sheet.cssRules`,
so diagnosing it misreads as "it did not take effect".

**Diagnosis rule of thumb**: when you suspect a style did not take effect, look at `getComputedStyle`, do not just read the CSS source.
Also, do not paper over a fill problem with a "thicker stroke" -- that is stopping the bleeding, not fixing it.

---

### 4.3 SVG `<text>` is monochrome; multiple colours must use `<tspan>`

**Symptom**: the text is set to red in the outline, and it is still black in the mind map.

Cause (two layers, both must be fixed):

1. Render layer: `fill` is an element-level attribute. One `<text>` can only have one colour,
   so multiple colours must be split into `<tspan>` child elements.
2. Write-back layer: `document.execCommand('foreColor')` produces
   `<font color="#...">` (not `<span style>`),
   and `htmlToSiyuanDom` had no `<font>` rule at the time -> the colour was silently dropped.

**Practice**:
- Add `src/core/richtext.ts`: `htmlToRuns(html): RichRun[]` splits HTML into styled runs,
  with the merge criterion in exactly one place, `sameStyle` (deliberately a single point, so adding a style bit cannot be fixed in one place and missed in another)
- Add `src/mindmap/RichText.tsx`: renders a chain of `<tspan fill=...>`
- `htmlToSiyuanDom` converts `<font color>` -> `<span data-type="text" style="color: ...">` before the fallback stripping

Note: the outline view was fine all along (it goes through `contentEditable`,
which natively supports inline `style="color: var(--b3-font-colorN)"`).
Do not go looking for a common cause just because "neither view has colour" -- measured, the outline is correct,
and the problem is only in the two chains, the mind map and the write-back.

When you change format support, walk both the read direction and the write-back direction.
At the time all 10/10 read cases passed; only `<font>` in the write-back direction failed.

**Tests**: `src/core/richtext.test.ts`, `src/mindmap/RichText.test.ts`, `src/core/map.test.ts`

---

### 4.4 Get the docId from `.protyle[data-node-id]`

**Fact**: the active document's ID comes from the `data-node-id` of the `.protyle` element.

Do not guess the document from its title / hpath -- this matches the project's hard rule
(every lookup must go through a Block/Doc ID).

### 4.5 Do not centre SVG text with `dominant-baseline`

**Symptom**: in mobile Safari, Chinese node text sits visibly too high. The same page is aligned in desktop
Chromium, so looking only at desktop screenshots never finds it.

**Cause**: `dominant-baseline="central"` is unreliable in Safari -- WebKit computes from
the **font's ascent/descent** rather than the **glyphs' actual ink**. A CJK font's ascent
is far larger than a Latin font's, so the text is pushed up as a whole. The WebKit tracker has been open since 2008:

    https://bugs.webkit.org/show_bug.cgi?id=6424

**Practice**: do not rely on the browser's baseline keywords; compute `dy` yourself
(`src/mindmap/text-baseline.ts`):

```
dy = 0.385 × fontSize
```

0.385 is a measured value: at 100px a Chinese glyph's ink covers 0.85em above the baseline to 0.08em below it,
and the midpoint sits 0.385em above the baseline. It scales proportionally with the font size.

**Tests**: `src/mindmap/text-baseline.test.ts` (including "invalid input produces no NaN" --
NaN makes the whole run of text disappear).

**Lesson from the investigation**: at first I only measured the DOM's `getBoundingClientRect` /
`getBBox`; they return the **em-box**, not the ink, so they kept reporting "perfectly centred".
`getBBox()` computes from glyph contours, but a `<text>`'s em-box still averages the white space above and below
it. **To judge "does it look centred", the only way is to draw the pixels and look with your eyes**,
or scan the pixels and compute the ink's centre of mass. Data lies; a screenshot does not.

---

### 4.6 `flex: 1` + `overflow: auto` is a scroll area only when **three** conditions hold

**Symptom** (measured 2026-10-05; 390×844 mobile viewport, 20 nodes): the last node, `节点20`,
is **never visible and never reachable**, and **no scrollbar appears at all** --
to the user the list simply has 19 items.

**Cause**: `.outline-wrap` was written as the scroll container (`flex: 1; overflow-y: auto`),
but its parent was `display: block`, and **`flex: 1` has no effect at all when the parent is not a flex container**.
The child therefore grew with its content and `overflow-y: auto` had no spare height left to scroll,
while the host `.om-mm-host` is `overflow: hidden` -- the excess was cut off.

Measured before the fix:

```
.om-mm-host     overflow-y=hidden    scrollHeight=1663    clientHeight=770
.om-mm-root     display=block        h=770                scrollHeight=1663
.outline-wrap   h=1625               scrollHeight == clientHeight -> it cannot scroll
setting .outline-wrap.scrollTop=500  -> still 0
```

**Practice**: three conditions, and missing any one of them shows up as "no scrollbar", silently:

1. the parent is a **bounded-height flex column** (`.om-mm-root { display: flex; flex-direction: column }`);
2. the bars do not take part in the squeeze
   (`.om-mm-root > .om-mm-viewswitch, .om-mm-root > .mm-bar { flex: 0 0 auto }`);
3. ★ the scroll area itself carries **`min-height: 0`** -- a flex child's default is `min-height: auto`,
   which makes it **refuse to shrink below its content height**. Without that line the flex column changes nothing.

Measured after the fix (same 390×844, same 20 nodes):

```
.outline-wrap   scrollHeight=1625    clientHeight=732    -> scrollTop=500 takes effect
host scrollHeight 1663 -> 770   (the overflow is gone)
real touch swipe up: scrollTop 0 -> 525, and 节点20 becomes visible
```

★ The same switch on the horizontal axis is `min-width: 0` (6.9c): same default, same silence,
only the direction differs -- a vertically clipped list and a horizontally overflowing toolbar
are one mistake with two faces.

**Tests**: `src/plugin/edge-autoscroll.test.ts`

---

### 4.7 The mind map draws connector lines, but the delete entry point was never wired

**Symptom**: the mind map renders a connector as **1 dashed line carrying its label**
(`分支一` on the line, the same string as the `<title>` on hover), so the feature looks present and alive.
Clicking that line opens the delete confirmation -- and confirming does **nothing at all**:
the dashed line is still there and the data under it has not moved, **still unchanged after 8 seconds**.
No error, no warning; the user reports "clicking does nothing".

**Cause**: `Mindmap` declares `onDeleteLink?: (fromId, linkId) => void` and its click handler calls it,
but `mount.ts` **never passed it** -- across the whole project only the retired web version ever did.
An optional prop plus optional chaining (`onDeleteLink?.(...)`) is a perfect silent failure:
`undefined` -> nothing happens, and TypeScript accepts it because of the `?`.

Measured (one connector line between two nodes, label `分支一`):

```
mind map        1 dashed line, line data =
                [{"id":"EMeWnSFiRi","toNodeId":"<anchor-id>","dashed":true,"label":"分支一"}]
                and the outline shows the connector marker 2 times (source and target both marked)
click delete -> still 1 dashed line, data unchanged; still unchanged after 8s      <- before the fix
after the fix -> 0 dashed lines, the attribute reads `[]`; still `[]` after 8s
```

(The connector was carried by a custom attribute at the time, so it survived a full page reload;
connector lines have since become view-local semantics and are neither read nor written -- see
[`MAPPING.md`](../MAPPING.md) 3.3. The render fact above is unchanged by that.)

**Practice**: pass the prop from `mount.ts`, in the same shape as every other mutation
(filter by `linkId`, push undo, write back).

★ Two details that only show up in the write-back: when the last entry goes, **remove the field**
(`delete n.linkLines`) instead of leaving an empty array -- an empty array is still a value that gets
written out, `undefined` is what removes it; and drop the lines whose target node was deleted,
or render draws an edge to a node it cannot find.

★ The general pattern -- "a prop that is declared but never passed raises no error, it just shows up
as 'I changed it and nothing happened'" -- is 6.9d; this entry is the **measured** case on the
connector-line path, and it is where two independent wirings meet: **whether a line is drawn** and
**whether clicking it works** are not the same wiring, so "I can see the line" is not evidence that
the delete path exists.

**Tests**: `e2e/ctxmenu.spec.ts`

---

### 6.9c Substituting a "guessed breakpoint" for "does it actually fit" misses half the cases

**Symptom** (2026-10-08): the settings bar was fixed in a narrow container, and widening it **broke it again**.

Only one width was tested (the default right column, 237px) and it was assumed done. Measuring across a sweep of container widths:

| Container width | Result |
|---|---|
| 237 / 400 / 560 | ✅ wraps, all controls present |
| **700** | ❌ "Export image" and "Export .mm" fall outside the column |
| 900 / 1100 | ❌ the stats text overflows |
| 1200 / 1300 | ❌ the stats text **still** overflows |

**Cause**: the fix was `@container (max-width: 560px) { flex-wrap: wrap }` --
wrapping only below 560px. But the settings bar's content is about **1131px** wide,
so **above the breakpoint it still does not fit**. 560 was a guess; the real criterion is "does it fit".

**Practice**: put `flex-wrap: wrap` straight into the base rule.
When the container is wide enough it would not wrap anyway (if one line fits it stays one line); it only wraps when narrow --
**no breakpoint is needed at all**.

The second place: the stats text is pinned at 298px by `flex-shrink: 0` and is still outside even in a 1300px container.
Changed to `flex-shrink: 1; min-width: 0`.
★ `min-width: 0` is the switch that lets a flex child **actually shrink** --
without it, `flex-shrink: 1` does nothing while the content is `nowrap`.

**Lesson**:

1. ★ **Every style that is "tiered by width" needs a sweep across the width range**;
   do not test only the one you happen to have. This is the same class as 6.10 ("occasional" is not "random"):
   both come from **testing one point and declaring it good**.
2. ★ The criterion must use **the element's own container**, never the viewport.
   The probe widened the dock while the window was still 1440, so the dock itself sticks out of the window --
   judging by the viewport gives a false positive (my first version misjudged the 1300px row exactly that way).
3. Mind CSS precedence: a later `.mm-bar > span { flex-shrink: 0 }` in the same file
   **overrides** the `flex-shrink: 1` in the earlier container query.
   When a style change does not take effect, first search for a later rule with the same name.

### 6.9e A floating menu must be **clamped into the viewport**, not placed straight at the click point

**Symptom** (2026-10-08): when the mind map expands to the right, the context menu of a right-hand node runs outside the window.
A sweep of 13 nodes found **12** overflowing, the worst off by 83px.
"Delete node (with children)" was clipped -- you can neither read it fully nor click it accurately,
**the most dangerous operation is the hardest one to hit**.

**Cause**: the menu is placed straight at `left: clientX, top: clientY`, with no clamping at all.
The map expands to the right -> the node hugs the window's right edge -> the menu opens down and right and goes out of bounds.

**Practice**: after rendering, measure the **real size** (`useLayoutEffect` + `getBoundingClientRect`),
flip to the other side when it touches an edge, then clamp once more as a backstop.

★ Why it must be **measured** rather than done in CSS: the menu's size changes with the text
(Chinese or English, whether there is a `Tab`/`Enter` shortcut hint), and CSS cannot guess the height.

★ The criterion uses `window.innerWidth/Height`: the menu is an overlay,
and the boundary the user can see is the viewport, not some ancestor container.

### 6.9n The same mistake three times: `@media` looks at the window while the style governs the **dock**

**Symptom** (2026-10-08): with a 1440px window and a 237px right column,
**the toolbar collapse toggle does not show at all** -- the user is in a narrow column that does not fit,
**with no way at all to collapse the toolbar**.

**Cause**: `.mm-bar-toggle` controls its visibility with `@media (max-width: 560px)`,
which reads the **window** width. But what it controls is **SiYuan's right dock** --
the column width is **unrelated** to the window width (measured: with a 1440px window the column is only 237px).

### The same mistake, made three times in this file

| Place | Original | Consequence |
|---|---|---|
| `.mm-bar`'s stats text | `@media` | with a big window + narrow column, what should be hidden is not hidden |
| `.mm-bar-toggle` visibility | `@media` | **no collapse toggle available in a narrow column** |
| **the entire narrow-screen toolbar block** (~60 lines) | `@media` | hint text on top, button font size, larger colour swatches -- **none of it takes effect** |

The third is the most typical: the block's **end** had already been changed to `@container`, and a comment was even left behind,
"★ use @container instead of @media: the panel width has nothing to do with the window size" --
**but the rest of the block was never changed**. The comment stated the right principle; the code was still wrong.

**The measured criterion** (before -> after): with a 1440px window / 237px column,
`getComputedStyle(label).flexDirection`:

    before: 'row'      <- the narrow-column layout never took effect at all (only shrinking the **window** to 520 switches it to column)
    after:  'column'   <- it takes effect whenever the column is narrow, independent of the window

**Practice**: change all three to `@container (max-width: 560px)`.
Container queries are already available (`.om-mm-root` has `container-type: inline-size`).

★ **Lesson**: a comment stating the right principle does not mean the code follows it.
  When you see an `@media`, **first ask what the size of the thing it governs varies with**:
  the window -> `@media` is right; the container -> it must be `@container`.

### 6.9p The criterion used the wrong **axis**: judging a touch concern by width

**Symptom** (2026-10-08): on **touch devices** (tablets, touch-screen laptops),
the outline sidebar's expand/collapse arrow is **`opacity: 0` -- completely invisible and unclickable**.

**Cause**: the arrow is `opacity: 0` by default and appears via `.node-row:hover` --
but **touch devices have no hover**. So another block raises it to `opacity: 0.85`
and enlarges it to `32px` (a finger is fatter than a mouse). But that block's criterion was:

```css
@media (max-width: 768px) { ... }   /* <- it asks "how wide is the window" */
```

**What it cares about is not width at all, but the input device.** This is using the wrong "axis".

Measured (`hasTouch` context, 1440px window):

    pointer: coarse -> true
    hover: none     -> true
    arrow opacity   -> 0        <- not one visibility style was applied

=> a tablet user with a wide window **never sees this arrow**;
  conversely a **mouse** user with a narrow window gets the enlarged version (they got it without needing it).

**Practice**: change it to `@media (pointer: coarse)` -- that is how "touch" is expressed in CSS.

After the change (same context): `opacity: 0.85`, `32×32`;
mouse devices still keep `opacity: 0` + reveal on hover (`24px`), no regression.

★ **Lesson**: before writing a media query, ask **two** questions:
  1. What does the size of the thing it governs vary with? (-> `@media` / `@container`, see 6.9n)
  2. Is what it judges a matter of **size** or of **device capability**?
     touch -> `pointer: coarse`; no hover -> `hover: none`;
     retina -> `min-resolution`.
     **Never use width as a stand-in for "is this a phone"** -- both tablets and narrow windows will make you judge wrong.

★ Verifying this class of defect requires a `hasTouch` / `pointer: coarse` context:
  narrowing the window in an ordinary context makes the `max-width` version **pass too** -- a false pass.

### 6.9q The first-visit default reads the window width -- what you see first is settings, not the map

**Symptom** (2026-10-08): opening the mind map for the first time (no local memory),
in a right column only **237px** wide, the toolbar is nevertheless **expanded by default**,
eating **239px** of height in one go -- the panel is only 798px in total,
leaving the canvas just 529px. **The user's first sight is a slab of settings, not the map.**

**Cause**: `barOpen`'s first-visit default was

```js
return typeof window === 'undefined' ? true : window.innerWidth > 560;
```

Yet another criterion that **uses the window width as a stand-in** (this repository has already fixed 4 places of this class, see 6.9n/6.9p).
The toolbar lives in **SiYuan's right dock**, and the column width is **unrelated** to the window width.

**Note the direction**: this differs from 6.9n -- 6.9n was "something that should show in a narrow column did not show",
this one is "something that should not expand in a narrow column expanded". Same root mistake, **opposite symptom direction**.

**Practice**: give it the initial value `true` (the DOM is not mounted yet, so the column width cannot be measured),
then correct it **by the column width** after mount with `useLayoutEffect`,
and only **when there is no user memory** -- if the user clicked it themselves, respect their choice.

```js
React.useLayoutEffect(() => {
  let saved = null;
  try { saved = localStorage.getItem('om-mm-bar-open'); } catch { /* storage unavailable */ }
  if (saved !== null) return;              // the user chose; leave it alone
  const w = wrapRef.current?.clientWidth ?? 0;
  if (w <= 0) return;                      // not mounted yet; keep the default
  setBarOpen(w > 560);
}, []);                                    // run once only; no live tracking
```

**Measured (first visit, window 1440px in every case)**:

| Column width | First-visit default | Toolbar height |
|---|---|---|
| 237 / 400 / 560 | **collapsed** | 0px |
| 700 / 1100 | **expanded** | 65 / 61px |

★ **Why run once and not do "live tracking"**: live tracking would, after the user toggles it by hand,
  be overwritten again by a column-width change -- which is exactly what the empty effect deleted in 6.9o tried to do.
  **The first-visit default** and **following along live** are two different things; do not mix them.

★ **Two prerequisites for constructing a "first visit" test; neither can be missing**:
  ① `localStorage` has no `om-mm-bar-open`;
  ② the column is already at the target width **before** the page script runs -- `addInitScript` is required.
     setting the width with `evaluate` after reload **is already too late**; the first-visit decision ran long before.
     That is how I wrote it the first time, and all 5 widths reported the same value.

### 6.21 A theme-conditional rule that can never match —— three ways to be silently dead

**Symptom**: four dark-mode rules had been in the shipped stylesheet for weeks and did nothing. Nothing
was red anywhere: no build error, no failing check, no visual glitch beyond "dark mode keeps the light
colours", which is easy to read as "the plugin simply has no dark styling yet".

**Cause**: the selector was written as `[data-theme='dark'] …`, and SiYuan never sets a `data-theme`
attribute at all. It writes **`data-theme-mode` on `<html>`** (`data-light-theme` / `data-dark-theme`
sit beside it; `<body>` carries nothing). So the selector matched nothing, in every theme, forever.

Three separate traps, each of which fakes a verification:

1. **The attribute is not where you guess.** Measured in the running app: `data-theme-mode` is on
   `<html>`; the built bundle contains `data-theme-mode` 37 times and `data-theme=` 0 times.
2. **`appearance.modeOS` ("follow the system") overrides `appearance.mode`.** Asking the kernel for
   dark with `modeOS: true` returns `code:0` and changes **nothing** when the OS preference is light --
   a headless browser's is light. A verification that trusts `code:0` passes here while the page stays light.
3. **Setting the attribute by hand changes the attribute, not the palette.** The plugin's rules then
   match (so a "did my rule apply" question answers yes) while the page is still painted light -- and a
   screenshot taken at that moment is a picture of light mode labelled dark.

**Practice**:
- Switch the theme the way the app does: `POST /api/setting/setAppearance` with the whole
  `window.siyuan.config.appearance` and `modeOS:false`, then wait for SiYuan's own `data-theme-mode` to
  change and assert the **painted** colour moved (`getComputedStyle(body).backgroundColor`, not the raw
  `--b3-theme-background` hex). `e2e/themes.ts` owns all three traps; a live switch costs ~0.4s, a
  reload ~1.3s, and re-opening the document ~10s -- which is why the matrix samples one document.
- A dead selector is not something a text scan can judge. Ask the **CSS engine**
  (`querySelectorAll` over the shipped CSSOM) whether a selector matches anywhere, and sample
  **both themes in both views** -- "matches nothing right now" is not "dead". `e2e/theme.spec.ts` does
  this and prints exactly which selectors matched nothing in any sample.
- Do not add a second, weaker criterion (a hand-written lint) for the same defect: it will disagree with
  the engine exactly where it matters, e.g. on `[data-theme=...]` appearing inside an attribute *value*.

### 6.24 A character-count cap is not a layout: the label was elided while the box had room

**Symptom.** Mind-map node labels were cut short and ended in `…`, so a reader could not see the node's
text — including labels whose box was wide enough to show them.

**Cause.** Two separate decisions had been fused into one number. `RichText` truncated at
`limit={20}` characters, and the layout sized the box from a *width* estimate (`widthOf`, up to 320px)
while giving every node the same height (`NODE_H = 34`). Neither side consulted the other:

- the 20-character cap ignored the box width, so 20 Latin characters (~160px at 8px each) wasted half of
  a 320px box, while 20 CJK characters (~300px) nearly filled it —— the same rule was wrong for both
  languages, in opposite directions;
- SVG `<text>` cannot wrap, and the fixed 34px height left nowhere for a second line, so "show it
  somewhere else" was not available either.

**Practice.** Wrap, and make the box follow the text —— do not cap text by character count:

- **One authority decides the lines.** `measureNode` (in `core/layout.ts`) wraps the runs to the wrap
  width and returns `{lines, w, h}`; the renderer draws *those* lines (`box.lines`) and never wraps
  again. Two wrapping decisions would let the text disagree with the box it was measured for.
- **The height is derived, not constant:** `lines.length * LINE_HEIGHT + PAD`. Every place that used the
  single-line constant has to use the node's own height instead —— `subtreeH`, vertical centring, the
  tree's total height, the vertical layout's level gap. `npx tsc` finds them all once the constant is
  deleted, which is the reason to delete it rather than keep it as a fallback.
- **Wrapping must lose nothing.** Pin it: concatenating the lines reproduces the input (a cut label
  hides information; a wrapped one must not drop a character), no line exceeds the wrap target, and a
  word wider than the line is broken rather than allowed to overflow.
- **The export needs no separate work** when it clones the live SVG (`XMLSerializer`), because the
  lines are already in the DOM. It would need work if it re-drew the text itself.

`src/mindmap/RichText.test.ts` and the wrapping block in `src/core/layout.test.ts` hold these
invariants, and `e2e/mindmap.spec.ts` checks the render (`> 1` tspan, no `…`, nothing dropped).
