# Shortcuts

## Structure and focus

| Keys | Action |
|---|---|
| `Enter` | Split the current node at the caret; when the node is empty, create a new empty sibling **at the same level** (press again and again to keep creating them). **This holds at every level**, it never promotes or demotes — use `Shift+Tab` to outdent |
| `Tab` / `Shift+Tab` | Indent / outdent (supports multi-select) |
| `Backspace` (at line start) | **A to-do becomes a plain node** (the marker is dropped, the node stays); otherwise merge into the previous node; an empty node is deleted outright |
| `Delete` (at line end) | Merge into the next node |
| `Alt+↑` / `Alt+↓` | Move the node up / down |
| `Ctrl+D` | Duplicate topic |
| `Ctrl+Shift+Backspace` | Quick delete topic |
| `Alt+→` | **Focus into the current node (Zoom-in)** |
| `Alt+←` | **Back to the parent level / all nodes (Zoom-out)** |
| `↑` / `↓` | Previous / next node; `Shift` extends the selection |
| Left-drag in the **gutter** (the blank strip left of the dots) | Draw a selection rectangle and select every node it crosses; click there without dragging to clear the selection |
| `←` / `→` (at line start / end) | Jump to the previous / next node |
| `Shift+Enter` | Enter / leave the description note |
| `Ctrl+.` / `Alt+.` (Chinese keyboard: `。`) | Collapse / expand the current node |
| `Ctrl+Shift+.` | Collapse / expand **sibling** nodes |
| `Alt+Shift+.` or `Ctrl+Alt+Shift+.` | Collapse all / expand all (toggles between the two) |
| `Ctrl+Alt+1/2/3` | Collapse by level (same as the toolbar "Level" (层级) dropdown) |
| `Ctrl+/` | Open / close the shortcut help panel |
| `Esc` | Clear the multi-selection / close the panel |

## To-do

| Keys | Action |
|---|---|
| `Ctrl+Shift+L` | Set to-do |
| `Ctrl+Shift+K` | Mark as done (to cycle through to-do states, see also the toolbar ☑ button) |
| Line start `[] ` / `[x] ` + space | Convert to to-do / done |

## Insert

| Keys | Action |
|---|---|
| `Alt+Enter` | Insert image |
| `Ctrl+Alt+T` | Insert table |

## Markdown at line start + space

`- ` → remove the prefix; `1. ` → numbered.
★ `# ` + space is **not** among them: it used to set a node's level, which could never be read back
(every node is a list item, and SiYuan takes a level only from a non-list line). It now stays literal text,
which is what a list item can hold. Headings already present in a document are read and preserved.

Inline paste supports `**b** *i* ~~s~~ `code` [t](u) $公式$ #标签` (when importing md; 公式 = formula, 标签 = tag);
While editing, `$latex$ + space` turns into a formula block automatically.

## Mouse and interaction

- **Outline bullet**: **a single click focuses into it (Zoom-in)**; `Alt+click` collapses / expands the whole branch recursively; **a double click also focuses**; drag the bullet to move the node (top / middle / bottom drop zones).
  Clicking an already-focused bullet again goes back to the parent level (Zoom-out).
- **Mindmap**: a single click jumps back to the outline and locates the node; **a double click on a node focuses that branch**; click "← Back to full map" (返回全图) to reset.
- **Breadcrumb navigation**: clicking any ancestor node at the top jumps straight to that level.

## Other

`Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y` undo / redo (keystrokes within 1.5s of each other merge into one step);
`Ctrl+F` find and replace; `Ctrl+B/I/U` bold, italic and underline; `Ctrl+Enter` strikethrough.
