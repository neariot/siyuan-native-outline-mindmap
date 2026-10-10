# Pitfalls - Mobile

<- [Master index](../PITFALLS.md) | Things we stepped on once and do not want to step on again; each entry reads "symptom -> cause -> practice".

Entry numbers (like `2.3`, `6.9v`) are **stable IDs**: other documents cross-reference them by
number, so keep the original numbers when splitting and never renumber. The numbers are not the
order inside this file; the `6.x` ones were moved here from the old "engineering and testing" section, grouped by topic.

### 3.1 A horizontal swipe gets stolen by SiYuan's "toggle sidebar" gesture

**Symptom**: dragging the map left and right on a touch screen slides the sidebar out or back in, and the map itself barely moves --
horizontal panning is completely unusable.

**Cause**: SiYuan mobile has a global `sidebarSwipe` gesture (`handleTouchStart` in
`app/src/mobile/util/touch.ts`), enabled by default. Its only exemption mechanism is that on `touchstart` it walks
up from the target looking for `data-prevent-swipe`:

```js
preventSwipe = !!target.closest(".av__widthdrag") ||
    !!hasClosestByAttribute(target, "data-prevent-swipe", null, true);
if (preventSwipe) return;      // this gesture is left to the content itself
```

`hasClosestByAttribute(el, attr, null, top=true)` means "it exists, therefore it applies"
(when the value is not a string it falls back to `hasAttribute`), and it keeps walking up to `BODY`.
So the attribute value does not matter; writing `"true"` is purely for readability.

**Practice**: put `data-prevent-swipe="true"` on the plugin's own scrolling / draggable containers.
This project puts it on `.mm-canvas` (the mind map canvas) and `.om-outline-wrap` (the outline container).
SiYuan's own list-mindmap viewer marks it the same way (`protyle/render/listMindmap/view.ts`).
Use the existing mechanism; do not modify SiYuan itself.

Do not verify this over CDP: a synthetic `Input.dispatchTouchEvent` never reaches SiYuan's gesture logic at all.
The "test passed" at the time was a false positive -- the control group (SiYuan body text, without the attribute) was equally untriggered.

For the right approach see `TESTING.md`: SSR plus a DOM stub asserting the attribute is present, 539 ms to a result.
See `src/plugin/mobile-swipe.test.ts`.

---

### 3.2 The mobile plugin entry point is in the bottom toolbar

**Fact**: on mobile the plugin entry is bottom toolbar -> More -> the plugin group.

Not the slash menu, not the command palette.

When writing mobile docs or screenshot scripts, always follow that path.
Open it with `#toolbarMore` and then find the menu item; do not click the slash menu inside `.protyle`.

---

### 3.3 A bottom padding that reserves room for the keyboard bar is **scrollable height**

**Symptom** (measured: 390×844 mobile viewport, 20 nodes, dragging a node to the bottom edge): the auto-scroll
does run, but the **drop hint disappears** and releasing the finger does nothing. Scrolling all the way down
moves **every** node above the top of the screen, so no row is left to drop onto.

**Cause**: the outline reserves room for the keyboard bar with a bottom padding
(`padding-bottom: max(380px, 60vh)` at the time of the measurement), and **padding counts as scrollable height**.
The scrollable total therefore far exceeds the content height, and at `scrollTop = max` that surplus padding
has pushed the whole list out of view.

Measured position of the last node (`节点20`; `t` = top, `b` = bottom, in px) while auto-scrolling to the bottom:

```
{t:   5, b:  39}   <- still visible
{t: -13, b:  21}
{t: -31, b:   3}
{t: -49, b: -15}
{t: -66, b: -32}   <- all of them above the top of the screen
scrollTop=893 (max) -> visible node count = 0
```

The bottom hit area is lost twice over: the keyboard bar (`.mobile-bar-fixed`, **192px** tall at this viewport)
covers the bottom of the screen, so a finger at `y=834` hits the bar instead of a `.node-row`, and
`document.elementFromPoint` finds no row at all.

**Practice** -- three parts, and each one is needed on its own:

1. ★★ raise the auto-scroll bottom line **above the keyboard bar**:
   `bottomLimit = Math.min(rect.bottom, innerHeight) - barH` -> **652** at this viewport (844 - 192);
2. ★★★ guard the overshoot: while scrolling down, if the last node's bottom has already crossed the bottom line,
   put `scrollTop` back to its previous value -- measured after the fix, the auto-scroll **stops at 192 instead of
   overshooting to 893**;
3. ★ when `elementFromPoint` finds no `.node-row`, fall back to the **vertically nearest visible node** (within one
   screen height), so "drag to the very bottom" keeps a defined meaning.

**End-to-end record** (same viewport, same 20 nodes): long-press `节点01` -> drag to the edge -> auto-scroll ->
drop below `节点20`; SiYuan's order `[..., 节点20, 节点01]` matched the UI's, and both stayed unchanged for
**16 seconds** afterwards.

**Lesson**: keep the guard, not the constant. The mobile rule no longer reserves 380px, but **any** bottom padding
is scrollable height shared with the content, so the same overshoot comes back as soon as that padding grows.

**Tests**: `src/plugin/edge-autoscroll.test.ts` freezes the raised bottom line and the overshoot guard;
the measurements above are ledger records, not assertions.

---

### 3.4 `touchmove` stops while the finger **holds still** -- drive the edge auto-scroll from `requestAnimationFrame`

**Symptom**: a node dragged to the screen edge and then **held** there stops scrolling. The user is holding it
precisely because they expect it to "keep scrolling", so from their side the feature simply does not work.

**Cause**: the loop was advanced from `touchmove`. Touch events report **movement**: a finger that does not move
emits no further `touchmove`, so a touchmove-driven loop advances zero frames -- and the closer to the edge
(where the finger is most likely to rest) the more certain the standstill.

**Practice**: drive the auto-scroll from `requestAnimationFrame` -- one step per frame while a touch drag is active,
cancelled when the drag ends -- and treat the touch position as **state that the loop reads**, never as the clock
that drives it. Every "the finger is still holding" behaviour needs that distinction.

---

### 3.5 A mobile feature that silently does nothing may be a **kernel TODO**, not a plugin bug

**Symptom**: on mobile, code that opens a custom tab does **nothing at all** -- no exception, no console entry,
the tab never appears. The search for the bug then starts in the plugin's own call site, which is correct.

**Cause**: the kernel ships an **empty implementation** for mobile -- in the kernel's `app/src/plugin/API.ts`:

```js
/// #if MOBILE
openTab = () => { /* TODO: Mobile */ };
/// #endif
```

Measured against that contract: calling it on mobile **does not throw** and returns `undefined`.
From the plugin side, "I called it wrong" and "the kernel has not written it yet" look exactly the same.

**Practice**: before debugging a mobile no-op in your own code, read the kernel's implementation of the API you
called and look for a TODO / empty stub. Then carry the UI in carriers that **do** exist on mobile -- this plugin
uses a dock + slash menu, which is why it works there. See `src/plugin/kernel-bugs.test.ts` (Defect 4).

---
