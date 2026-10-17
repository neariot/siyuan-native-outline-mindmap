# 0.2.1

Patch release. Completes the **code block** story (a node can become a code block, and code blocks
and tables can be nested), fixes two **silent divergences** between the panel and the document, and
repairs a **lost keystroke** in code boxes. Storage format and configuration remain fully compatible
with 0.2.0 — no migration, nothing to reconfigure.

## Code blocks

- **★★ `</>` turns the current node into a code block.** The button existed in the mobile bar but the
  top toolbar had no entry point for it, and the conversion itself was broken in four places: the input
  handler read a ref one commit behind, the focus was dropped to `BODY` on the re-mount, a shared
  element reference committed one box's value into another, and the focus loop was unbounded. All four
  are fixed and each has a red proof.
- **★★ Code blocks and tables can be nested.** A code block or a table is now a node in its own right
  that follows its parent: indent/outdent re-parents it, and a fence or table inside a list item is
  read back at the right level instead of being promoted to the document root. `moveBlock` is a silent
  no-op on both kinds of block, so a level change is written as create-then-delete and the node adopts
  the id the kernel mints.
- **★ The desktop kept its inline-code button.** Reusing the `</>` slot for the conversion had removed
  the only desktop entry point for inline code (the other one lives in the mobile bar, which is hidden
  above 768 px). It is restored next to `</>`, in the `<code>` form the kernel reads back.
- **★ A keystroke into a code box is no longer lost.** Two races: a foreign transaction (the echo of
  the conversion) could trigger a whole-document re-read while the keystroke was still debounced and
  overwrite the tree holding the edit; and the first conversion's focus loop (≈ 3 s) could steal the
  caret from the row click. The re-read now merges code-block code (keeping the in-flight value), and
  the loop carries a generation counter, cancels its pending frame on a new run, and stops after
  ≈ 0.5 s.

## Silent divergences fixed

- **★★ A level change into an empty child list.** `moveBlock` into a list with no list item answers
  `code: 0` and moves nothing, and the panel showed a level the document did not have. The phantom
  target came from the lagging SQL index (the kernel removes the empty list itself); the fix reads the
  list live, creates a fresh one with a placeholder, moves after it, and deletes the placeholder.
- **★ `code: 0` is not success.** It is now the answer for a move that did not happen, for three kinds
  of block (code block, table, list item). Write-backs verify where the block ended up.

## Tooling

- The diagnostic panel shows a **build stamp** (`build=…`) computed from the source, so a running
  bundle can be identified in one glance.
- `scripts/audit-language.py` no longer crashes on an unterminated template literal.

Storage format and configuration remain fully compatible with 0.2.0 — no migration, nothing to reconfigure.
