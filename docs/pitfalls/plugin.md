# Pitfalls · Plugin Mechanics

← [Master index](../PITFALLS.md) ｜ Things we stepped on once and do not want to step on again; each entry reads "symptom → cause → practice".

Entry numbers (like `2.3`, `6.9v`) are **stable IDs**: other documents cross-reference them by
number, so keep the original numbers when splitting and never renumber. The numbers are not the
order inside this file; the `6.x` ones were moved here from the old "engineering and testing" section, grouped by topic.

### 5.1 The `displayName` localisation key must be `zh_CN` (underscore)

**Symptom**: in the bazaar list the plugin name shows up as the key itself, or falls back to the default language.

**Cause**: do not mix the two things up —

| Purpose | Format | Example |
|---|---|---|
| `i18n/` file name | BCP47 (hyphen) | `zh-CN.json` |
| `plugin.json`'s `displayName` locale key | underscore | `zh_CN` |

Using `zh-CN` from the official sample "does run", but only the underscore gets parsed correctly.

How to decide: query `/api/bazaar/getInstalledPlugin` and look at the localisation the kernel actually returns.

---

### 5.2 The i18n resolution chain

**Where the entries live**: the plugin directory `i18n/<lang>.json`; the kernel reads them in `kernel/model/plugin.go`.

How the kernel picks the file: `LangToLegacy` in `plugin.go`
(`kernel/util/lang.go`, converting underscore ↔ BCP47 both ways).

The right way to verify i18n headlessly: `--lang` is a kernel startup argument and overrides `conf.json`.
So to check another language you have to restart the kernel with the argument, not edit the config.

Bridge layer: SiYuan hangs the entries off the plugin instance (`this.i18n.<key>`),
but a pure-function module cannot reach the instance → a thin bridge layer is needed; do not write a separate one in every module.

Pitfall: watch out for `t` shadowing — a local variable named `t` hides the translation function.

### 5.3 Icon tooltips: give both SiYuan's `.ariaLabel` and the native `title`

**SiYuan's mechanism** (`app/src/dialog/tooltip.ts`): a
`mouseover` delegate on `document`; it selects `.ariaLabel` elements, reads `aria-label` and renders it as `<div id="tooltip">`.
It beats the native `title`: the delay is controllable, the styling follows the theme, HTML is supported, and there is a `data-position` placement.

**But on mobile it does not show at all**:

```js
export const showTooltip = (...) => {
    if (isMobile() || !message) return;    // ← skipped on mobile
};
```

**So give both**: add `ariaLabel` to the `class` + write `aria-label` to go through SiYuan's bubble,
while keeping `title` as the mobile fallback. Writing only `aria-label` turns mobile from
"long-press gives a tooltip" into "nothing at all", which is a regression.

Practice: `tooltip(text, baseClass?, position?)` in `src/plugin/tooltip.ts`
generates this set of attributes in one go; just spread it onto the element. On desktop, when both are present SiYuan's bubble covers the native
`title` (`mouseover` fires faster than the native hover).

**Test**: `src/plugin/tooltip.test.ts` (locks down "both attributes must be present at once").

**Do not edit JSX with regexes when refactoring**: `className={\`m-btn ${cond ? 'active' : ''}\`}`
Template strings like this get mangled by a regex. My first version used regex replacement and inserted `ariaLabel` into the middle of the ternary's
two branches, eating 12 lines of source outright (`tsc` reported `'}' expected`).
Switching to the TypeScript AST (change only the attribute node, apply the edit once at the end) is the safe way,
and it guarantees the line count stays the same.

---

### 5.4 `openTab` does not check `app` -- and its error names neither `app` nor `plugins`

**Symptom** (measured 2026-10-06; kernel 3.8.6 desktop, build `main.2ad40d65a4f684255925.js`, Chromium viewport
1600×1000): `openTab({ app: <plugin instance>, doc: { id } })` **opens the tab anyway**, but the document renders
**blank** and the console holds

```
TypeError: Cannot read properties of undefined (reading 'forEach')
  at new Ks (main.*.js)
  at d.initProtyle (main.*.js)
```

The message names **neither `app` nor `plugins`**, so there is nothing in it to attribute the failure to -- and the
empty tab it did open reads as "the call worked". That is the whole difficulty of the case: the symptom (a blank
document) and the cause (a wrong `app` argument) sit in different places.

**Cause**: the kernel's `class Ks` constructor starts `(s, F, Oe, $e = {})` and runs `s.plugins.forEach(...)` --
`s` is the **first argument, the `app`**. A plugin instance has no `plugins` field -> `undefined.forEach`. Nothing
validates `app` on the way in either: in JavaScript a plugin instance and an application instance are both plain
objects, so no type can stop the mix-up.

Measured with a 2×2 controlled experiment (`.tmp/k1-run.py`): each case a **new, never-opened** document
(`# K1<tag>` plus one list item `- 目标内容<tag>`) with **all tabs closed** first, so that the open goes down the
`initProtyle` cold path; page errors collected through the browser's `pageerror` event; the call is
`openTab({ app, doc })` with `doc = { id }` or `doc = { id, action: ['cb-get-focus', 'cb-get-scroll'] }`:

| `app` | `action` | page errors | rendered body |
|---|---|---|---|
| real application instance | not given | **0** | fine |
| real application instance | `['cb-get-focus', 'cb-get-scroll']` | **0** | fine |
| plugin instance | not given | **1** | blank |
| plugin instance | `['cb-get-focus', 'cb-get-scroll']` | **1** | blank |

**Practice**: pass the **application** instance (`window.siyuan.ws.app`) as `app`, never the current plugin
instance. And when a kernel API fails without saying why, do not change one thing at a time -- run the whole
comparison (here 2×2), with the official equivalent path next to it as a baseline: SiYuan's own file tree opening
the same document reports **0 errors**, which pins the fault on this call site rather than on the environment.

★ The conditions are part of the measurement: an already-open document takes the reuse branch and never reaches
`initProtyle`, so the variable under test is not exercised and **every** combination looks clean -- a false
negative that reads exactly like a pass.

★★ Do not let `action` take the blame. Reading the build's fallback (`doc.action || (doc.action = [])`) once
produced the claim "not passing `action` crashes", and the table above disproves it (real app + no `action` ->
0 errors): the `forEach` belongs to `app.plugins`, not to `action`. **A cause read out of the compiled build is
a hypothesis until a measurement confirms it.**

**Measured**: the 2×2 outcome is in [`docs/kernel-api.md`](../kernel-api.md) §7.14 (with the table), and the
plugin's side of it —— which value the call passes, and that a missing instance is reported instead of
substituted —— is `src/plugin/ref-nav.test.ts`. It used to be cited to `src/plugin/kernel-bugs.test.ts`, a file
whose cases asserted on stub functions written inside the test itself.

---

### 5.5 To learn a kernel calling convention, read the kernel's own call sites -- not the field names you guess

**Where the gap is**: the `doc` branch of `openTab` is undocumented, and its argument names have to be right --
`openTab({ app, doc: { id, action, zoomIn } })` -> `openFileById({ app, id, action, zoomIn, scrollPosition: 'start' })`
(inferred from measurement). Guessing the fields and the `action` values costs a round of "the tab opens but does
not focus or scroll to the target".

**Practice**: search the **build** for the equivalent official feature and copy what SiYuan itself passes. In the
desktop bundle (kernel 3.8.6, `main.2ad40d65a4f684255925.js`) the call sites are spelled out:

```bash
rg -o "openFileById\)\(\{[^}]*\}" app/stage/build/desktop/main.*.js
```

The first hit is SiYuan's own reference-click path:

```js
openFileById)({app:h.app,id:this.refDefs[0].refID,action:W,zoomIn:N,openNewTab:!0,scrollPosition:"start"}
```

and its pinned-document path passes the pair literally:

```js
openFileById)({app:Ie.app,id:b,action:[a.Constants.CB_GET_FOCUS,a.Constants.CB_GET_SCROLL]}
```

★ `action: ['cb-get-focus', 'cb-get-scroll']` (those two constants) is **exactly the combination SiYuan itself
uses when a block reference is clicked** -- which is why this plugin's reference navigation passes the same pair.
The field names are identical on both sides because `openTab`'s `doc` branch forwards `doc` verbatim as
`openFileById`'s arguments; the field names are visible at a glance that way, and guessing them is what wastes
rounds.

★ That pair only decides the "focus and scroll into place after opening" experience -- whether the tab opens, and
the `app` crash, do not depend on it (5.4). The wiring half of the same path (a declared-but-never-passed
callback) is 6.9cc.

**Tests**: `src/plugin/ref-nav.test.ts`

---
