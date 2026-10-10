# Mind map ⇄ SiYuan Data Mapping Spec

> Version: 2026-10-06 · Implementation: `src/core/map.ts` · Tests: `src/core/map.test.ts`
> Every conclusion here comes from **measurements against the real SiYuan kernel**, not conjecture.

## 0. Design principles

Two hard requirements run through this whole document:

1. **Zero custom attributes** — after uninstalling the plugin the document information must survive intact, with no `custom-*` traces left behind
2. **What you see is what you get** — all data lives on SiYuan's **native** carriers, visible and editable in the native editor,
   never hidden in plugin-private attributes or data structures

This plugin **writes and reads no `custom-*` attribute whatsoever** — node semantics come only from SiYuan's native structures.

## 1. Structural mapping

| Concept | SiYuan expression | Notes |
|---|---|---|
| One mind map | One document (`.sy`) | Created with `createDocWithMd` |
| One node | One `listItem`(i) + its inner `paragraph`(p) | **Two blocks per pair** |
| Node hierarchy | Nested `list`(l) | Kramdown uses 2-space indentation |
| **Node identity** | The **block ID of the `listItem` itself** | No extra ID is stored |
| Node text | The paragraph's Kramdown | See §2 |
| Node description | **Multiple paragraphs** under the listItem | Shown directly below the node, may be several paragraphs |
| Task state | Native task list `- [ ]` / `- [x]` | `taskStatus` 1/2 |
| Heading level | Native `#` ~ `######` | h1~h6 all supported |
| Mirror block | Native document embed `{{(( docId ))}}` | Renders directly, no decorator needed |

### 1.1 Serialization format

```
# Document title

- Root node
  - Child node
    - Grandchild node
```

**Key constraint**: the attribute must be on the **same line** as the list item, written after `- `.

> ⚠️ Pitfall: if the attribute sits on its own line (especially with indentation), SiYuan parses it as a **plain paragraph block**,
> and the attribute will not attach to the listItem.
>
> Exception: **heading blocks** do not support list-item attributes; their attributes go on a separate line and are **flush left**.

### 1.2 What SiYuan actually exports (the parser must handle this)

SiYuan exports each listItem as **three** lines:

```
- {: id=".." updated=".."}test1            ← listItem itself
  {: id=".." updated=".."}                 ← inner: the paragraph inside the listItem
{: id=".." updated=".."}                   ← outer: the listItem itself
```

> ⚠️ Parsing must judge hierarchy by **indentation**. Recognizing only a leading `- ` treats an indented child as deleted (false positive).

### 1.3 The empty-node special case

SiYuan **does not keep block attributes for empty list items**, so empty text nodes are lost in a round trip.

**Solution**: when serializing, pad empty nodes with the zero-width placeholder `\u200b`:
```
- ​      ← the trailing character is an invisible \u200b
```
When parsing: a line with an empty body **still becomes a node**, restored as empty text.

## 2. Inline marker mapping table

The HTML convention defined by `src/model/types.ts` → SiYuan Kramdown.
Measured status: ✅ round trip verified

| Internal HTML | SiYuan Kramdown | Status |
|---|---|---|
| `<b>t</b>` | `**t**` | ✅ |
| `<i>t</i>` | `*t*` | ✅ |
| `<s>t</s>` | `~~t~~` | ✅ |
| `<code>t</code>` | `` `t` `` | ✅ |
| `<u>t</u>` | `<u>t</u>` (inline HTML kept as-is) | ✅ |
| `<sup>t</sup>` | `<sup>t</sup>` | ✅ |
| `<sub>t</sub>` | `<sub>t</sub>` | ✅ |
| `<mark>t</mark>` | `==t==` | ✅ |
| `<span data-formula="L">` | `$L$` | ✅ |
| `<span data-tag="n">#n` | `#n` | ✅ |
| `<a href="u">t</a>` | `[t](u)` | ✅ |
| `<span data-noderef="id">t` | `((id 't'))` | ✅ |
| `<span style="color:var(--b3-font-colorN)">` | span with the same name | ✅ see §2.1 |
| `<img data-img>` | `![alt](assets/...)` | ✅ see §3.2 |
| `<span data-mask="1">t` | `t` (original text kept) | ⚠️ see §2.2 |

### 2.1 Inline styles (color / background / font size / font family)

**SiYuan supports this**, but three things must be kept in mind:

#### (1) It must go through the DOM write path

SiYuan's inline rich text has **two write paths that do not interoperate**:

| Path | Accepts | Does not accept |
|---|---|---|
| `dataType=markdown` | markdown syntax (`` ` `` `**` `==`) | **HTML tags, IAL** |
| `dataType=dom` | SiYuan `data-type` structures | **bare HTML tags** |

Measured:
- `<span style="color:red">红</span>` (red) via markdown → **escaped into literal source**, color lost
- A bare `<b>粗</b>` (bold) via dom → breaks into `&lt;protyle-html&gt;`

⇒ A node carrying styles must go through `updateBlockDom()`, and the argument must first pass through `htmlToSiyuanDom()`.

#### (2) Style and semantics must be **merged into the same tag**

Measured round-trip results for three kinds of nesting:

| Form | Kernel kramdown | Result |
|---|---|---|
| `<span data-type="text" style="…"><span data-type="strong">X` | `<span style=…>X</span>{:…}` | ❌ bold lost |
| `<span data-type="strong"><span data-type="text" style="…">X` | `**X**` | ❌ color lost |
| `<span data-type="strong" style="…">X</span>` | `**X**{: style="…"}` | ✅ both kept |

⇒ `htmlToSiyuanDom()` rewrites both kinds of nesting into the merged form.

#### (3) Colors use CSS variables, not hardcoded color values

SiYuan itself uses `var(--b3-font-colorN)` / `var(--b3-font-backgroundN)`
(see `INLINE_FONT_COLORS` in `app/src/protyle/toolbar/inlineStyle.ts`).

The advantage of variables over color values: they follow the theme's light/dark setting automatically.
The parsing side **identifies by attribute name** and accepts any form of color value (`var()`, `#hex`, and color keywords are all accepted).

> ⚠️ On export SiYuan appends a redundant `{: style="…"}` IAL suffix after the text; that is the kernel's own
> representation, **not part of the text content**, and must be stripped when parsing, or it pollutes the node text as literal characters.

### 2.2 Mask (cloze blank)

SiYuan has **no native mask concept**. Strategy: **

- **Write**: keep the original text only, write no private attribute (to avoid polluting the document)
- **Read**: read no attribute at all. Mask semantics are neither written nor read —
  the node body is preserved as-is and the mask information is lost.

### 2.3 Escaping

- HTML entity unescaping: `&lt; &gt; &quot; &#39; &nbsp; &amp;`
- The implementation uses 'scan the text segment by segment with regexes' rather than pulling in an HTML parser, keeping `core/` dependency-free

## 3. Status

### 3.1 Attachment paragraphs ✅ implemented (carrying node descriptions/notes)

**Replaces `memo`**: the explanatory text below a node is carried by SiYuan's **native multi-paragraph structure** —
a listItem may have several `NodeParagraph` sibling blocks:

```
listItem
├── p  first paragraph (= the node text)
├── p  attachment paragraph[0]
├── p  attachment paragraph[1]
└── l  child list (optional)
```

**Any number of paragraphs, no primary/secondary distinction, all of them attachments**; empty paragraphs are supported too.

| Advantage | Notes |
|---|---|
| Directly visible in the editor | Right below the node; no need to click the "M" icon |
| Full-text searchable | It is body text and enters the index naturally (`memo` is not searchable by default) |
| Supports multiple paragraphs | `memo` is a single attribute value |
| Zero custom attributes | All of them are native blocks |

**Interaction on the mind map side**: a node shows only the first paragraph by default; clicking the three-bar icon at its top left opens a popover with the full text;
inside the popover you can "edit" — one paragraph per line, **a blank line is an empty paragraph**, Ctrl+Enter saves and Esc cancels.

**Points that must be handled** (all measured):

1. **The first paragraph must not be empty** — otherwise the whole group of attachment paragraphs leaves the listItem and lands at the document root; pad with `\u200b`
2. **Empty paragraphs are recovered from "adjacent attribute lines"** — `getBlockKramdown` **does not export the body line of an empty paragraph**
   (the block really does exist in the kernel); it exports only the attribute line. The criterion is "two adjacent attribute lines + indentation of node+1"
3. When rendering, `String.trim()` does **not** remove `\u200b`; it must be stripped explicitly before testing for emptiness
4. **Appending and updating must go through the same write path** — at one point "append used DOM, update used markdown",
   and the two paths store different internal representations (DOM stores `<span data-type="text">甲</span>`,
   markdown stores `甲`), so the comparison always judged "there is a difference" and rewrote over and over
5. ★★ **Adding a paragraph must be positioned with `insertBlock(previousID=anchor)`;
   never use `appendBlock(parentID=listItem)`** —
   the latter appends the paragraph at the **very end of the listItem (after the child list)**:
   ```
   appendBlock → ['p:root node', 'l: child node', 'p:appended paragraph']   ← wrong position
   insertBlock → ['p:root node', 'p:inserted paragraph', 'l: child node']   ← correct
   ```
   A wrong position also **breaks the reading side** (parsing decides ownership by indentation; once the indentation relations are scrambled the whole run cannot be read back)
6. **The anchor must start from "the last existing attachment paragraph" and move forward one by one** —
   if the first paragraph is always used as the anchor, a new paragraph is inserted **before** the existing ones (measured `['乙','甲','']`);
   inserting two paragraphs in a row with the same anchor yields the **reverse order**
7. ★★ **When a block mapping is missing you must retry and report an error, never skip silently** —
   after `createDoc` the SQL index lags by **1~3 seconds**, and during that window `lastListItems` is empty.
   The original code `if (liId) { ... }` would **silently discard** the user's attachment paragraphs
   (the UI showed "saved" while the content never reached SiYuan).
   The current degradation: re-read the blockMap once (change the limit to bypass the in-write-back cache) → if it still fails, throw

#### Blank-line rule: does not exist (settled from the source)

**Conclusion: the kramdown this plugin writes contains no "you must leave a blank line" rule at all.**

This conclusion was **not** reached by repeated experimentation (experiments can falsify but cannot prove),
but by **reading the kernel and Lute sources, which confirm that this rule simply does not apply in the first place**.

**① Two common misunderstandings**

| Claim | Reality | Source evidence |
|---|---|---|
| ① A blank line **before** an attachment paragraph | ❌ not needed | see "two paths" below |
| ② Blank lines **around** a child list | ❌ not needed | same as above |

**② Why it is not needed: `dataType` has two paths, and only one of them goes through markdown parsing**

The `dataType` of `/api/block/appendBlock`, `insertBlock`, `updateBlock`
**accepts only `markdown` or `dom`** (`kernel/api/block_op.go:664`):

```
dataType: 'markdown'  →  dataBlockDOM → Lute markdown parsing  ← blank lines have meaning
dataType: 'dom'       →  BlockDOM2Tree(kernel/model/transaction.go:1704)
                          → lute/protyle.go:348 BlockDOM2Tree
                            → util.ParseHTML
                            → adjustVditorDOM
                            → genASTByBlockDOM
                          ← **never goes through markdown parsing**
```

Under the DOM path, one `<div data-type="NodeParagraph">` is **one paragraph**,
the paragraph boundary is given explicitly by the DOM structure, and there is **no such thing** as "separated by blank lines".

**③ The real source of blank-line semantics is Lute's markdown parser, not SiYuan**

This has to be stated clearly, or one will wrongly conclude that "SiYuan requires blank lines":

```go
// lute/parse/paragraph.go:22
func ParagraphContinue(p *ast.Node, context *Context) int {
    if context.blank { return 1 }   // blank line → paragraph ends
    return 0
}
// lute/parse/parse.go:246
context.blank = lex.ItemNewline == token
```

In Lute a paragraph **terminates only at a blank line** and **never terminates because of indentation**;
indentation only decides **ownership** (`parse/list.go:92`).

So "a blank line is a paragraph separator" is **Markdown's paragraph semantics**,
implemented by Lute, the markdown engine — **SiYuan itself has no requirement that "paragraphs need blank lines"**.

**④ What this plugin does: it takes the DOM path, so the blank-line problem simply does not exist**

**All** plugin writes go through `dataType: 'dom'`, and the "leave a blank line or not" question no longer arises:

- `createDoc` builds the title shell → `appendBlockDom(treeToBlockDom(nodes))`
- Adding a paragraph → `insertParagraphAfter` (DOM)
- Updating a paragraph → `updateBlockDom` (DOM)

**⑤ An old conclusion corrected along the way**

An earlier record said "after deleting the blank line the attachment paragraph merges into the first paragraph", and gave a kernel reproduction using `createDocWithMd`:

```
Input:  - 节点         Kernel:  i ' 节点⏎甲⏎乙'
          甲                    p '节点⏎甲⏎乙'     ← all merged into one paragraph
          乙
```

That reproduction is itself **correct**, but what it proves is the semantics of the **markdown path**
(`createDocWithMd` is a markdown importer); it **cannot** be generalised into
"SiYuan requires blank lines". After switching to the DOM path that phenomenon no longer occurs.

**⑥ Lesson**: to judge whether a "platform rule" holds, read **where that rule is implemented in the platform's source**,
rather than generalising from black-box experiments — experiments can falsify, but they can hardly prove "the rule applies to every path".
Of the two old rules in question, ① was **a misattribution** (taking the markdown engine's semantics for a platform requirement),
and ② was **a false positive** (not reproducible by any of six ablations, most likely coming from other causes that have since been fixed:
the SQL `sort` column not being unique, and `appendBlock` putting the paragraph after the child list).

### 3.2 Images ✅ implemented

Uploaded to SiYuan assets via `/api/file/put`, and synced along with the document.

> ⚠️ An `<img>` that has only an alt and no usable address **must never** produce an empty link `![alt]()`;
> in SiYuan that is a broken image. It should degrade to plain text.

### 3.3 Outline `summaryData` / link lines `linkLines` ⛔ no longer supported

SiYuan has **no native counterpart**, so — to satisfy "zero custom attributes" — they are **neither read nor written**.

Both are **local view semantics within a session** (valid only in the current editing session)
and are not persisted across sessions — so there is no "read side / write side" distinction.

## 4. ID strategy

| Scenario | ID used |
|---|---|
| New node | SiYuan block ID (generated by the kernel) |
| Parsing a SiYuan document | **The block ID of the listItem itself** |

In SiYuan a node is a **first-class citizen**: it has a real block ID, can be referenced, searched, and backlinked.
The plugin keeps no extra ID mapping table — the block ID is the identity.

## 5. How it is verified

```bash
# type check
./node_modules/.bin/tsc --noEmit

# unit tests (covering the mapping layer and the plugin layer)
```

Real-kernel E2E conclusions (v3.8.6): h1~h6 levels, to-dos, attachment paragraphs (including empty paragraphs), nesting levels,
and inline rich text (color/background/font size/underline/superscript and subscript/highlight) are **all preserved exactly**;
after writing, the DOM has no escaped source, no lost colors, and no stray IAL in the DOM.
