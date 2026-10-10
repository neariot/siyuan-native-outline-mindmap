# 0.1.4

40+ commits accumulated since `v0.1.3`, focused on kernel two-way sync stability, the mobile experience, mind map badge readability, and CI pipeline problems.

This version has **no breaking changes to the public API** and no default configuration changes — behavior stays smooth and consistent after upgrading.

## Key fixes and improvements

### ★ Major hardening of kernel two-way sync and data structures

1. **Eliminate inverted and stale SQL ordering by using the kernel's in-memory AST**
   - Leaf node position sync is fully fixed; row order is no longer scrambled after a sync.
2. **Batch fetching of child lists**
   - Write-back overhead that grew linearly with node count is gone, and read/write performance on large node lists is significantly better.
3. **Eliminate the accidental deletions caused by rapid Enter presses**
   - Rapidly pressing Enter to create nodes no longer deletes a newly created node on a concurrency conflict (the `tree not found` error is eradicated).
4. **Fix anomalies in concurrent write-back**
   - Removed the occasional false "document deleted" report on concurrent saves; fixed leaf nodes being saved with an extra empty child list.
5. **Stronger rich-text character escaping**
   - Literal angle brackets `< > &` in nodes survive a round trip without nested characters being dropped round after round (for example `a<b>c` used to be misparsed or lose characters and become `ac`).
6. **Responding to an empty document**
   - Fixed the panel staying on "This document has no content yet" after a list item is created in an empty document (incremental re-read of an empty tree as a fallback).
7. **Ownership of paragraphs before the first node**
   - Attachment paragraphs before the document's first outline list item are now correctly attributed to the document title node.

### ★ Mobile adaptation and device verification

1. **Soft keyboard layout adaptation**
   - Fixed the blank toolbar and content sliding under the soft keyboard when it appears; everything now follows the viewport smoothly.
2. **Joint end-to-end mobile verification**
   - Added the Android / Redroid + CDP automated joint verification suite (`npm run verify:android`, 20/20 cases green).

### ★ Mind map and interface experience

1. **Attachment paragraph badge floats outside**
   - The node attachment paragraph icon moved to a floating position outside the top-right corner, with a high-contrast solid circular background and a border, fully solving the problem of it being unreadable inside the node text and covering that text.
2. **Right-click menu kept inside the viewport**
   - A right-click menu near an edge is automatically pulled into the viewport and is no longer cut off by the window or sidebar boundary.
3. **View state persistence**
   - Switching views or refreshing the panel no longer loses the mind map's zoom and layout settings.
4. **Responsive narrow columns and containers**
   - The settings bar now wraps adaptively in a narrow sidebar instead of pushing controls out of the viewport; several `@media` rules became `@container` rules, so sizes follow the host container strictly.
5. **Deduplicated text when expanding into a child document**
   - After expanding into a child document, node text is no longer duplicated.

### ★ Outline view and interaction experience

1. **Right-click context menu**
   - The outline view now has a full right-click menu: quick-edit a single node, add a sibling/child node, toggle to-do, collapse/expand, focus a subtree, or delete; with a multi-selection it supports batch indenting, moving, changing to-do state, adding a summary/connection, and batch deletion; right-clicking empty space supports select-all in one action plus global expand/collapse.
2. **Ctrl+A select-all on the keyboard and the workflow around it**
   - While editing a node, pressing Ctrl+A once selects the current node's text, and pressing it twice (or pressing it again after the text is already selected) automatically selects every node in the whole outline; the outline supports Ctrl+A to select all, Esc to clear the selection, and Del / Backspace to delete in batch.
3. **Hardened mouse multi-select and range selection**
   - Fully fixed `Ctrl + click` add/remove-from-selection and `Shift + click` range selection, intercepting the conflict with native input cursor dragging; the dot icon supports Ctrl/Shift multi-select as well; a plain click keeps clear focus and selection semantics.
4. **Precise error messages**
   - "＋ Summary" now reports the real reason (a top-level sibling has no parent block, so no summary can be added) instead of a vague message.
5. **Removing experimental features**
   - Removed the text-cloze feature and its toolbar button, which had no native persistence carrier, keeping the native principle of "a single data source, no private copies, no custom attributes"; leftover debug overlays were cleaned up.

### ★ CI pipeline and test engineering

1. **GitHub Actions CI fixes**
   - Reordered the CI steps (`typecheck` → `build` → `test` → `package`) and added an automatic artifact build as a fallback in the export style verification test, fully solving offline unit tests failing on a clean CI runner because `dist-plugin/` was missing.
2. **Test coverage**
   - Offline unit tests: **all 68 cases green** (`npm test`).
   - Real-device/offline verification: **all 15 cases green** (`npm run verify`).
   - Android mobile verification: **all 20 cases green** (`npm run verify:android`).
   - Playwright browser E2E: **all 84 cases green** (`npm run test:e2e`).
