# 0.1.7

15 commits since `v0.1.6`. Three user-visible defects, each one silent —— none of them raised an error, and
two changed what the user saw without changing what was stored.

**Storage format and configuration are unchanged** —— documents written by 0.1.6 read back identically, and
no setting changes meaning. No UI text changed.

## Key fixes

### ★ A title containing `<` or `>` lost those characters

The root node built its label by putting the document title straight into markup, so a title was parsed as
HTML instead of drawn as text:

| The document's title | What the map showed |
|---|---|
| `use <T> for generics` | `use  for generics` |
| `a<b>c` | `ac` |

The characters disappeared in the mind map **and** in the PNG export, which draws the same rendered runs. The
title is plain text from SiYuan's own `blocks.content` and the kernel stores it exactly as typed —— measured
against a running instance —— so the loss was entirely on the drawing side.

It now goes through the same escaping as everything else. The `.mm` export had been escaping its title all
along, which is why this went unnoticed for so long: the format that escaped was tested, and the one the user
looks at was not.

### ★ The keyboard went dead after a context-menu command

After any of **five** menu items —— *focus this node*, *back to full map*, *expand as sub-document*, *delete
node (with children)*, and *focus this node* from the map —— `Tab`, `Enter`, `Delete`, `F2` and `Ctrl+Z` did
nothing until the node was clicked again. No message, no visual change: the menu simply closed.

The menu is an overlay of `div`s, so clicking an item moved focus away from the canvas, and the map's
shortcuts are attached to the canvas. The other menu items were unaffected because opening the editor or the
paragraph panel sets its own focus —— which is also why a casual test of one item would have found nothing
wrong.

### ★ Text containing a literal entity name was replaced by the character it names

Typing `&nbsp;` as **text** into a node drew as a space; `&quot;` drew as `"`. The stored document was always
correct —— only the display was wrong, which is what made it easy to miss.

Two of the five copies of the HTML-decoding code in the project had the entity order right and three did
not. Consolidating them into one shared function surfaced it.

## Also in this release

- **The undo baseline is now what the write-back actually wrote**, not what it was asked to write. The two
  could differ by one edit, which made a single `Ctrl+Z` step jump further than the edit it should undo.
- **A performance self-test was measuring the machine rather than the code** (it failed at load 5.3 and
  passed at load 1.6 on the same build). The sample it timed was below the clock's resolution.
- **`run-e2e.py` now reports the machine's load before running**, and warns when a failure is more likely to
  be the machine than the plugin.

## Verification

Full browser suite: **112/112 in 14.6m** at load average 1.2, on this build. Every new case was shown to fail
first with the defect restored:

- the title case reports `Expected "E2E-角度<T>-测试"`, `Received "E2E-角度-测试"`;
- the keyboard case reports `activeElement` as `BODY` instead of the canvas;
- the entity case reports the literal `&nbsp;` decoding to a single space.
