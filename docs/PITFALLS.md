# Pitfall ledger

Things we stepped on once and do not want to step on again. Each entry reads
"symptom → cause → practice".

**The entries live in [`docs/pitfalls/`](pitfalls/), split by topic. This file
is only the index.**
(It used to be one 1700-line file, of which the "engineering and testing"
section alone took 1095 lines and mixed build / debug / style / interaction /
test-criteria — it had become unreadable.)

## Topics

| File | What it covers | Entries |
|---|---|---|
| [`pitfalls/wiring.md`](pitfalls/wiring.md) | Wiring: props not passed down, overlays, controls in narrow containers | `0.1`–`0.3` |
| [`pitfalls/data.md`](pitfalls/data.md) | Data and write-back: block-ID namespaces, conflicts, fingerprints | `1.1`–`1.10` |
| [`pitfalls/editor.md`](pitfalls/editor.md) | Editor interaction: focus, selection state, reverse keys, view switching, hints | `2.1`–`2.5`, `6.9b/d/g/o/v/w/x/y`, `6.9aa`–`6.9cc` |
| [`pitfalls/mobile.md`](pitfalls/mobile.md) | Mobile: gestures, plugin entry points | `3.1`–`3.5` |
| [`pitfalls/privacy.md`](pitfalls/privacy.md) | What must never reach the repository: a real notebook's name, id, path, or content; a credential, before and after deletion | `6.26` |
| [`pitfalls/style.md`](pitfalls/style.md) | Rendering and styles: scoping, SVG, `@media`/`@container`, device capabilities | `4.1`–`4.7`, `6.9c/e/n/p/q`, `6.21`, `6.24` |
| [`pitfalls/plugin.md`](pitfalls/plugin.md) | Plugin mechanics: i18n, icon tooltips | `5.1`–`5.5` |
| [`pitfalls/build.md`](pitfalls/build.md) | Build and engineering: minifiers, DOM paths, dead-code removal | `6.2`, `6.3`, `6.7` |
| [`pitfalls/debug.md`](pitfalls/debug.md) | Debugging methods and tools: **screenshot first**, polling, CDP recording, `getComputedStyle` | `6.5`, `6.6`, `6.9`, `6.12`, `6.19`, `6.20` |
| [`pitfalls/testing.md`](pitfalls/testing.md) | Tests and criteria: assertions that **look right but have no defensive value**; never guess a target or a path | `6.1`, `6.4`, `6.8`, `6.9f/h–m/r–u/z`, `6.10`, `6.11`, `6.13`, `6.15`–`6.18`, `6.22`, `6.25` |

SiYuan kernel API behaviour (`insertBlock` anchors, `updateBlock` rebuilding
block IDs, poll-after-write, kramdown parsing, plugin loading details) is about
**the kernel itself** and holds for any SiYuan project, so it moved to
[`kernel-api.md`](kernel-api.md).

## How to maintain this

1. Anything that can become a test should not live only here. A pitfall's
   destination is a regression test: code shouts, documentation rots. Entries
   that name a test file already have that insurance.
2. Delete entries that are fixed and covered by a regression test. Keep only
   what is still true, plus what a test cannot express (the symptom as the user
   sees it, design stances, why we walked into it in the first place).
3. One pitfall, one place. When the same root cause shows up in several spots,
   merge it into one entry about the pattern instead of copying it per
   occurrence.
4. **Adding an entry → put it in one of the topic files above; do not stuff it
   into this file.** If no topic fits, start a new file and add a row here.
5. Split any file that passes ~500 lines. Do not let it grow back into that
   1700-line monster.

---

## Appendix: design stances (not pitfalls, but they shape judgement)

### A1 "I don't want two copies of the data"

The user's core principle. Data always uses SiYuan's native carriers; we do not
invent attributes:

| Need | Native carrier |
|---|---|
| Note / description | A native `NodeParagraph` under the listItem (i.e. `paragraphs`) |
| Mirror | A native embed block |
| To-do | A native task list |

Why：home-made attributes cause more problems than they solve — full-text search
cannot find them, and the UI shows only an icon you have to open to see, which
breaks "what you see is what you get". The user was explicit: drop memo
entirely, keep no compatibility path.

Corollary: before asking "should we add a custom attribute", first ask "is
there a native carrier for this".

### A2 Do not cap things on the user's behalf

**Fact**: the panel width was once capped at `max-width: 860px`, justified as
"more comfortable reading". The user rejected it outright: "you have no right to
decide the cap; the user has eyes".

**Practice**: the content area is always `width: 100%`, following its container.

### A3 The location of a symptom is not the location of the cause

Seen repeatedly: Enter produced reversed order (cause: focus), a note was cut
down to one character (cause: the serialization fingerprint), Delete left an
empty shell (cause: an incomplete reverse-key branch).

**Practice**: first verify "did the action happen at all", then investigate
"it happened but the result is wrong".
