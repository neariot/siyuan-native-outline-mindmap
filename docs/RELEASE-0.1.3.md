# 0.1.3

56 commits accumulated since `v0.1.2`.

## Behavior changes to be aware of

This version has **no breaking changes to the public API** (command IDs are unchanged, configuration goes through the official `loadData/saveData`),
but the defaults below have changed, and existing users who upgrade will notice:

| Change | Before | Now |
|---|---|---|
| Default structure | Mind map (both sides) | **Right** |
| "Fit" button | Zoom was clamped to a lower bound (a narrow screen could not fit the whole map) | **No clamping**; it really fits every node into the canvas |
| Default shortcuts | `⌥⌘M` export image / `⌥⌘N` insert mirror | `⌥⌘O` / `⌥⌘I` |
| Structure dropdown | 6 entries | 5 entries ("Tree" was removed, see below) |

Shortcuts can be changed in the settings; just change them back to the old keys.

## Added

- **Mind map nodes support inline rich text**: bold, italic, strikethrough, links, code, inline color
- Inline formatting is read from SiYuan and preserved when writing back to the document (previously it was silently dropped)
- Icon tooltips now use SiYuan's `.ariaLabel`, with `title` kept as a fallback
- `scripts/mindmap-shot.py`: a visual verification script for mind map rendering; it reuses an already open tab,
  about 2.6 seconds (a full-page screenshot takes about 40 seconds)

## Fixed

- **"Export image" grew a large "−" circle at every branch junction**
  Those circles are collapse buttons, hidden on the page by CSS; `cloneNode` + `XMLSerializer` only carries over
  the class attribute and not the page CSS, so in a standalone SVG `opacity` falls back to 1 and they all become visible.
  The fix takes two steps at the same time: embed the plugin styles + add `.om-mm-host` to the cloned root node
  (that rule is a descendant selector, so it requires an ancestor with this class).
- **"Fit" could not fit a wide map on a narrow screen**: there used to be a readability lower bound (0.55 on narrow screens),
  which made the button tooltip "Fit to canvas (zoom until all nodes are just visible)" a misnomer.
- In the structure dropdown, "Tree (right)" and "Logic (right)" **render exactly the same**
  (measured layout fingerprints matched box by box), so two menu entries had one effect; the extra one was removed.

## Internal cleanup

- The structure value `'default'` was renamed to `'balanced'`: the old name meant both "both-sides layout" and "the default value",
  and once the default became `'right'` it was simply misleading
- The structure dropdown labels are now named after the actual behavior, no longer using diagram-type names such as "mind map / logic chart" —
  the two were never different to begin with; only the growth direction differs:

  | Structure value | Label | Behavior |
  |---|---|---|
  | `right` | Right | All child nodes go right |
  | `balanced` | Balanced | Expands to both sides, splitting by child node **size** |
  | `left` | Left | All child nodes go left |
  | `org` | Down | Expands vertically |
  | `timeline` | Alternating | Expands to both sides, alternating by **index** parity |

## Tests

`npm test` is green on all 67 cases (65 suites), and `tsc --noEmit` is clean.

Every new key regression test went through **injection verification** (reintroduce the defect and confirm the test really goes red):

| Test | After injection |
|---|---|
| Export styles | Remove "add root class" → 11/12; remove "embed styles" → 8/12 |
| Fit without clamping | Put the readability lower bound back → 10/12 |
| Structure dropdown | Put `treeRight` back → 12/17; revert the labels to diagram-type names → 22/24 |
