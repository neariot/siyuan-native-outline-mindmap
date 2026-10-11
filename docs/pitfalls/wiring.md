# Pitfalls - Wiring and overlays

<- [Master index](../PITFALLS.md) | Things we stepped on once and do not want to step on again; each entry reads "symptom -> cause -> practice".

Entry numbers (like `2.3`, `6.9v`) are **stable IDs**: other documents cross-reference them by
number, so keep the original numbers when splitting and never renumber. The numbers are not the
order inside this file; the `6.x` ones were moved here from the old "engineering and testing" section, grouped by topic.

### 0.1 One optional prop left unpassed silently disables the whole chain

**Symptom**: right-click a mind map node -> "Focus this node": the menu opens normally, and clicking it **does nothing at all**,
with no error either. The same code works fine in the outline view.

**Cause**: when `mount.ts` renders `Mindmap` it **does not pass `zoomId` / `onZoomChange`**.
Every `onZoomChange?.(...)` inside the component is swallowed by the optional chain.
(The same problem appeared once in `Outliner`; only the outline was patched at the time, and the mind map was missed.)

**Why it is hard to spot**: the optional chain makes "not wired up" look exactly like "wired up but not working" --
no error, no missing UI, the menu item is right there. Only asserting the **side effect** (the node count should drop) exposes it.

**Practice**: pass those two props to `Mindmap` (sharing the same state as the outline).
Regression test: "focusing a node shows only the subtree, and returning to the full map restores it" in `e2e/keyboard.spec.ts`.

**The general defence for this class of bug**: when several views need the same capability, pass the props
**one view at a time and check each** -- never assume "the outline got it, so the mind map has it too". E2E looks only at side effects, not at arrival,
so if it did not take effect the test does go red.

### 0.2 Overlays must close on Esc

**Symptom**: the context menu could only be closed by "click elsewhere" or "right-click again"; Esc did nothing.

**Cause**: `Mindmap`'s `onKeyDown` handled Escape explicitly for the "attached paragraph overlay",
but **never added the same branch for the context menu**.

**Practice**: add `if (ctxMenu !== null) { Escape -> setCtxMenu(null); return; }` to `onKeyDown`.
Regression test: "Escape closes the context menu".
When adding an overlay, check against this: **every overlay you can open must be closable with Esc**.

---

### 0.3 Do not hide controls in a narrow container behind "one line + horizontal scroll"

**Symptom**: SiYuan's right sidebar is only **237px** wide by default, while the mind map settings bar has 12 controls totalling **1131px**.
It used to be unconditionally `flex-wrap: nowrap; overflow-x: auto`, so
"Fit", "Export image" and "Export .mm" ended up **outside the viewport** (the last button measured x = 1907
against a 1440-wide viewport), findable only through a **4px-tall** horizontal scrollbar -- users simply never find them.

**Cause**: to keep the toolbar "compact on one line instead of filling the whole top", `.om-mm-root .mm-bar` was
hardcoded to `nowrap`. That intent is fine, but **no fallback was left for "it does not fit"**.

**Practice**: switch on **container** width (`@container`, not a viewport media query -- a SiYuan panel's
width is unrelated to the window size, so a media query misfires with a large window and a narrow panel) and wrap when it does not fit.
A wide enough container still stays on one line. Also release the trailing explanatory text from `nowrap`,
otherwise it is pinned at 298px and still overflows once things wrap.

**Why the test almost missed it**: `toBeVisible()` **still returns true** for an element inside an overflowing container
(it really is rendered and does have a size, it is simply not in the viewport). The first version of the case scrolled horizontally by hand before asserting visibility,
so it passed whether or not the defect was present. It now pins three things at once: the controls are inside the viewport, the bar needs no horizontal scrolling, and the bar really did wrap.

---

### 0.4 A helper that owns an invariant must own it at every call site

**Symptom**: `mount.ts` had six write paths, each opening the echo-guard window by hand
(`beginApply(); await writeLatest(); endApply(...)`). Two shapes of failure, neither with a message:

- release in a `finally` — the counter stayed balanced, but the blocks were recorded as **written** even
  when the write had thrown, so a genuine external change arriving in the short window afterwards was
  swallowed as our own echo;
- no release on the failure path at all — `applyingCount` stayed above zero for the rest of the session,
  `isApplying()` stayed true, and from then on **every** event was judged an echo: external edits stopped
  arriving and local ones were reported as conflicts, until a reload.

**Cause**: the invariant ("every `beginApply` is balanced, and a failed write claims nothing") lived in
six copies of a three-line pattern. A helper — `withEchoGuard`, which does exactly this — had already been
written and unit-tested, and was used by **one** of the seven paths. The helper's own test could not see
the other six: it tests the helper, while the defect is in the wiring.

**Practice**: one helper owns the invariant, and a check asserts that the product **uses** it. Found
through the parser rather than by searching the text —— `guardRef.current.beginApply` appears **0 times**
as a call in `mount.ts` and **4 times** in the comments that explain the rule, so a text search reports the
explanation and the "fix" would be to stop writing it down (`callSites` in `src/plugin/source-probe.ts`).
And a second check asserts the helper is actually called, because "no hand-rolled window found" means
nothing if nothing uses the helper either.

**Tests**: `src/plugin/echo-guard.test.ts` (18 checks: the helper's failure path, and the wiring).

---
