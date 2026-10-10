# Pitfalls · Build and Engineering

← [Master index](../PITFALLS.md) ｜ Things we stepped on once and do not want to step on again; each entry reads "symptom → cause → practice".

Entry numbers (like `2.3`, `6.9v`) are **stable IDs**: other documents cross-reference them by
number, so keep the original numbers when splitting and never renumber. The numbers are not the
order inside this file; the `6.x` ones were moved here from the old "engineering and testing" section, grouped by topic.

### 6.2 Two names colliding in the minifier create a TDZ, completely invisible in the source

**Symptom**: red text at the top of the panel

    Cannot access 'e' before initialization

It is reported on every write-back, and that round's "was the block destroyed by the kernel" check is skipped entirely (it goes to the outer `catch`),
leaving the dead-block mapping in the table.

**Cause**: two variables with **different names** in the source are minified down to **the same single letter** `e`:

    // source (looks perfectly fine: child, probeIds, q all have different names)
    const probeIds = siblingsBefore.filter((id) => id !== child);
    if (probeIds.length) {
      try {
        const q = async () => { ... };      // ← the minifier renamed this to e
        let liveSet = await q();

    // minified output (the filter callback and the let are only 35 characters apart)
    if(s.length){let t=s.filter(t=>t!==e);if(t.length)try{let e=await this...}
                              ↑ the e referenced here resolves to the let below → TDZ

**Why it is hard to find**:

- Type checking, unit tests, and code review **all stay silent** — there is no `e` in the source at all
- Only in the minified output do the two names collapse into the same letter
- The reported line number points into the minified output (`plugin:...:17:402`), so you have to locate it
  yourself in `dist-plugin/index.js` by character offset

**A symptomatic fix does not work**: after the inline `const q` was moved into its own method the first time, the minifier promptly
minified `let liveSet` to `e` as well, and the defect **reproduced exactly**. The cause is
the **structure** "a filter callback and a `let` share one block scope", not some variable name.

**The right fix**: extract the whole block of logic into a separate method, so the filter callback and the `let` no longer share a scope.
However the minifier renames things, they cannot collide.

**Regression guard**: `src/plugin/minify-tdz.test.ts` scans `dist-plugin/index.js` directly and
goes red when it finds "a filter callback referencing `e` + a `let e=` immediately after".

---

### 6.3 A bare `<br>` / `<p>` sent down the DOM path turns into `<protyle-html>` garbage

**Symptom**: a literal `<protyle-html><protyle-html>` shows up in the document, and what the user sees is that garbage
instead of an empty line. Every extra write adds one more level of nesting.

**Cause**: SiYuan's inline DOM **does not recognise** a bare `<br>` / `<p>`; fed one, it escapes the whole thing into a literal.
And inside contenteditable the browser **auto-inserts a placeholder** `<p><br></p>` into an empty block, so:

    <span></span><p><br></p><p><br></p>   ← the node's real innerHTML
              ↓ htmlToSiyuanDom
    <br><br>                              ← bare tags went into the kernel
              ↓ kernel escapes
    &lt;protyle-html&gt;                  ← stored as literal text

**Measured comparison** (same kernel, same position, same DOM path):

| Written content | kramdown result |
|---|---|
| `<div data-type="NodeParagraph"><br><br></div>` | `<protyle-html><protyle-html>` ❌ |
| `<div data-type="NodeParagraph">​</div>` | empty ✅ |

That is: **`<br>` gets escaped, a zero-width space does not**.

**Fix**: in `htmlToSiyuanDom`, strip the block-level placeholder tags (`p`/`div`) and
convert `<br>` uniformly into a zero-width space `​` (SiYuan uses it to mean "an empty line that has content").
It must run **before** the final "strip unknown tags" fallback.

---

### 6.7 Dead-code removal: compare the build output before and after

Practice (reusable): compute the static import closure starting from the entry point `src/plugin/index.ts`;
whatever does not appear in the closure is an unreachable file.

**Verification**: `dist-plugin/index.js` has exactly the same byte count before and after the deletion —
this proves the deleted code really was dead better than "run the test suite" does.
