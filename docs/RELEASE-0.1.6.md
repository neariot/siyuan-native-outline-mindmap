# 0.1.6

14 commits since `v0.1.5`, all of them in the outline and the mind map's rendering of nesting: one
reported bug in each view, plus the test layer that should have caught them.

**Storage format and configuration are unchanged** —— documents written by 0.1.5 read back identically, and
no setting changes meaning. The only text change is one shortcut's wording, in both catalogues.

## Key fixes

### ★ A to-do could not be turned back into a plain node from the keyboard (reported)

1. **`Backspace` at the start of a to-do now drops its marker**
   - Reported as "at the very start, Backspace does not turn the to-do into an ordinary node". Measured, the
     two positions failed for **different** reasons: on the **first** node nothing happened at all (no branch
     of the handler matched —— the node is not empty and there is no previous node to merge into, so the key
     was swallowed), and on any **other** node it merged into the previous one, so the marker went but so did
     the node itself.
   - It now removes the marker and keeps the node and its text. `Delete` is unchanged (it still joins the
     next node), and clearing by hand stays available in the menus.
2. **The to-do checkbox no longer takes focus** (found while fixing the above)
   - The checkbox is an `<input>`, so clicking it moved focus off the node's text —— and the node's key
     handler is attached to that text rather than to an ancestor, so **every** key pressed afterwards went to
     the checkbox. That is why `Delete` also did nothing on a to-do node.

### ★ A nested document drew as a flat line in the mind map (reported)

3. **Every level of a chain now descends**
   - Reported as "the document is right but the outline and the mind map are both wrong". Measured, the
     **outline was correct** and only the map was wrong: a four-level chain (`a > b > c > d`) came out with
     **every box at the same y** in all four structure modes, drawn as one flat left-to-right line, so the
     map showed the levels as siblings.
   - The cause was "centre each child on the band it owns", which is right for a **tree** and silently wrong
     for a **chain**: with one child the band is that child's own height, so the child landed at the parent's
     `y` **exactly** —— at every level. The same arithmetic appeared in five places; it is now one function.
   - The tree shape is unchanged: a parent with three children still keeps some above and some below it.
4. **The spacing no longer grows with the parent's text length**
   - The first version of the fix used the parent's height as the gap, so a one-line parent put its child
     37px below, two lines 73px, three lines 108px. The height was standing in for "one line of text", which
     is not what it measures. The gap below a parent is now the same constant used between siblings, and the
     **clearance** is identical at every parent height.

### ★ Re-parenting in the mind map left the views contradicting the document (reported)

5. **A drag now updates both views, not just SiYuan**
   - Reported as "after dragging a node to become a child, the SiYuan document is accurate but the outline
     and the mind map are both wrong". Reproduced exactly: the document held the nested shape while both
     views stayed flat —— and stayed flat after switching views, so the next edit would have written the
     wrong picture back.
   - The drag itself was never broken (`insertBlock` → `moveBlock` → `deleteBlock` all fire, and SiYuan stores
     the nesting). What broke was the plugin's own picture: the drag creates a list item, whose transaction
     arrives while the write is still running, so its ID is neither known nor yet an echo and it is judged
     "an external change I cannot map". That starts a whole-document re-read which lands **before our own
     write** —— it faithfully returns the pre-write shape and overwrites the correct tree.
   - The re-read now waits for our own write-back to finish. Measured order before the fix:
     `reparent assigns the nested tree → re-read lands with 3 flat roots → our write finishes`.

## Verification

- **End-to-end, both views**: the drag cases assert the **document, the mind map and the outline together**.
  Comparing the views only against each other would pass for two views wrong in the same way, and comparing
  against the document alone would pass for exactly the state this bug leaves behind.
- The to-do and drag cases were each shown **red** on the unfixed build before being kept, and the
  subtree-move case was rewritten after it was found to pass with the mutation in place.
- The full suite runs in **13 minutes** (was 33) —— one helper's wrong criterion accounted for 20 of them.
- 71 offline checks, 17 gates, `audit-privacy --live` clean.

## Not changed

- No new settings, no new storage, no `custom-*` attributes. Documents remain readable by 0.1.5 and earlier.
