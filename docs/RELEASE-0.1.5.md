# 0.1.5

69 commits since `v0.1.4`, focused on the outline's selection and to-do handling, write-back integrity,
editor focus, and the test layer that guards all of it.

**Storage format and configuration are unchanged** —— documents written by 0.1.4 read back identically, and no
setting changes meaning. The one visible behaviour change is that **four controls were removed**, because
SiYuan has no carrier for what they produced (see "Removed" below): they could not survive a reload, and a
control that silently loses its result is worse than no control.

## Key fixes and improvements

### ★ Selecting several nodes (a reported bug)

1. **Select across nodes by dragging in the outline's gutter**
   - The plain left button could not select more than one node: dragging over the text selects *text*, and every
     node is its own editing host, so a range cannot leave the node it started in. The bullet is draggable and
     owns the other gesture; the strip no gesture owned was the gutter.
   - The marquee matches SiYuan's own shape (`protyle-select__container`), and a left-drag in the gutter now
     selects every node it crosses.

### ★ To-do handling

1. **A to-do created in the outline now reaches the document**
   - It is created through the markdown call, the only one the kernel will create a task with. It is written
     **together with its subtree**, so a to-do with children keeps them: updating a list item with only its own
     line makes the kernel append a nested line instead of converting the block (measured).
2. **Clearing a to-do clears it in the document**
   - Unchecking left it a to-do in the document: the clear had no call at all, and the two calls that could
     have made one cannot —— the marker API answers `-1 block is not a task list item` on anything that is not
     already a task, and the attribute path refuses `data-task` outright. Clearing travels the same markdown
     write that creates a task, and the state is written only when it changes.
3. **The mind map's to-do checkbox works, and toggles instead of removing the marker**
   - It was drawn with a pointer cursor and handled its click, but `onToggleTask` was never passed to the
     component, so clicking changed nothing —— the only part of the map that looked interactive and was not.
   - It now flips **to-do ↔ done** through the same path as everything else. It used to cycle
     none → to-do → done → **none**, so a third click took the marker off and the node became a plain list
     item —— which is not something a click on a checkbox can be read as. Removing the marker is still
     available as the explicit, labelled action it already was.
4. **A to-do change is no longer swallowed while the index catches up** (reported as "clicking it deletes
   the to-do")
   - Behind the symptom above sat a silent defect: whether to write is decided from a read of the current
     state, and that read lags the kernel by 1~3 seconds, so a click following the previous one inside that
     window read the state from **before the plugin's own last write** and the change was dropped —— no
     call, no error, no message, and the panel showed a state the document never got. What this session
     wrote is now remembered and consulted first, and the note retires the moment the read agrees with it,
     so the document is the authority again as soon as the index has caught up.
5. **A closed dock can be opened**
   - The check waited for the panel's content *before* clicking the icon that opens it, so a closed dock was
     never opened, and the write-back that followed was lost without a message.

### ★ Write-back integrity

1. **A formula no longer merges into the run before it**
   - The style comparison tested the `formula` flag on the first run only, so a formula run whose other styles
     matched the plain run before it merged into it and lost the flag: `$…$` was then wrapped as ordinary text.
2. **One authority for "what text does this node show"**
   - Two implementations disagreed about HTML entities, so a node containing `&`, `<` or `>` never matched its
     own echo (the kernel returns `&amp;`/`&lt;`/`&gt;`) and a write-back in flight reported a conflict on text
     nobody had touched.
3. **The echo window is balanced even when a write-back fails**
   - A failed write left the guard open, so the next external change was swallowed; ownership of that window
     now lives in one place instead of six copies.
4. **Deleting a document no longer leaves a tab pointing at it**, and clicks that landed on a dangling
   reference no longer miss.

### ★ Editor focus

1. **Focus is given back when a panel or an attached-paragraph edit closes**
   - Cancelling a paragraph edit unmounted an `autoFocus` textarea, so focus fell to `BODY` and the panel's own
     keys (Escape, Ctrl+Enter) plus every canvas shortcut were dead until the next click. The same one-way
     migration was fixed for the zoom/panel overlay, and the attached-paragraph panel no longer takes focus
     back on every keystroke.

### ★ Removed: four controls SiYuan cannot store

SiYuan has no native carrier for what these produced, so they lived only in the session's memory and could not
survive a reload. `docs/MAPPING.md` already recorded "neither read nor written" for them; the product now
agrees with the document. Five node fields nothing named went with them.

1. **Summary** (`summaryData`)
2. **Link lines** (`linkLines`)
3. **Cloze mask**
4. **Due date** (the 📅 chip) —— it had the same defect and no test at all, which is why it outlived the other
   three

The native-storage principle is unchanged: no custom attributes, no private storage, no second copy of the
document's data.

### ★ Test and process layer

1. **No test file is left that cannot fail**
   - `scripts/check-vacuous-tests.py` fails the build when a document cites a test that does not exist, and it
     now also refuses a citation naming a test that imports nothing and reads nothing. The count of such files
     went from 17 to **0**, and the gate runs strictly rather than printing them as queued work.
2. **Structural checks read the parser, not a regex**
   - Function bodies are cut with the TypeScript parser, comments are stripped through the parser's own trivia
     (`stripComments` used to desynchronise on JSX and silently keep comments —— text that only exists in a
     comment makes a check pass), and CSS is checked with postcss.
3. **Two more gates**
   - `hardcoded-paths`: no literal path that belongs to one machine in a tracked file (the rule was previously
     enforced by remembering to look).
   - `fixture-text`, `dead-props`, `dead-css`, `vacuous-tests` and `hardcoded-paths` all run in `npm run check`
     (16 gates, ~37s).

## Test coverage

- Offline unit tests: **70 cases green** (`npm test`).
- Playwright browser E2E: **103 cases green** (`npm run test:e2e`, 34.6 min on the isolated test instance).
  The release adds one further case (the to-do toggle above), which was verified on its own and shown red
  against the defect; the full suite has not been re-run since it was added.
- Live desktop check (`npm run verify`) and the Android device check (`npm run verify:android`) were **not** run
  for this release: the first wants a document in a workspace the plugin is running against, and the second
  needs the Android/Redroid toolchain. Neither is claimed as verified here.
