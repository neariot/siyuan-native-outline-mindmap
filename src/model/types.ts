// Node data model.
//
// A node's body is an **HTML fragment** (not a token array) —— the editor edits it directly
// with contenteditable, so no intermediate layer is needed. On persist, `core/blockdom.ts` turns it into SiYuan DOM;
// on read, `core/map.ts` restores it from Kramdown.
//
// Inline element conventions (matching SiYuan's native structures):
//   plain            <span>text</span>
//   bold/italic/     <b> <i> <s> <code> <u>
//   strike/code/u
//   color/highlight <span style="color:#.."> / <span style="background:#..">
//   formula          <span data-formula="latex source">fallback $..$</span> (rendered by KaTeX)
//   link             <a href="..">..</a>
//   tag              <span data-tag="name">#name</span>
//   mention/@        <span data-mention="docId">@name</span>
//   block ref        <span data-noderef="target">name</span>
//   image            <img data-img="id" src=".." alt=".." style="width:..%" />
//   table            <table><tbody><tr><td>..</td>..</tr>..</tbody></table>

export interface OutlineNode {
  id: string;
  modified: number;
  text: string;
  /**
   * **Attached paragraphs** below the node: any number of them, with no primary/secondary distinction, all attached.
   *
   * Corresponds to the remaining `NodeParagraph` blocks under a listItem in SiYuan, other than the first paragraph:
   *
   *     listItem
   *     ├── p  first paragraph (= text)
   *     ├── p  attached paragraph[0]
   *     ├── p  attached paragraph[1]
   *     └── l  child node list
   *
   * Each item is an HTML fragment, isomorphic to `text`.
   * An empty paragraph is the empty string; on serialization an empty paragraph gets a zero-width placeholder `\u200b`.
   *
   * The map shows only the first paragraph by default; click the icon on a node to expand the full text.
   */
  paragraphs?: string[];
  taskStatus?: number; // 0/undefined = none, 1 = todo, 2 = done
  // Heading level. SiYuan natively supports levels 1~6, so it is no longer capped at 3.
  heading?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** Fold state of this node: **view state, deliberately not saved.**
   *
   * Nothing persists or restores it, and that is intended —— folding is a way of looking at a document,
   * not something the document says, so it starts unfolded when the document is reopened. It is named by
   * the runtime (`model/tree.ts` skips the children of a folded node, the outline toggles it), which is
   * why `scripts/check-unsaved-fields.py` reports it as in-session rather than as a defect.
   */
  collapsed?: boolean;
  // ★ Five fields were declared here and named by no module at all —— not a reader, not a writer, not the
  //   wire layer: `finish` on the node, and `mindmapStructure` / `mindmapThemeIdx` / `mindmapLineStyle` /
  //   `mindmapShape` on the document. Each looked like a feature's storage and was in fact vestigial (the
  //   mind map keeps its structure, theme and folded branches in `localStorage`, `om-mm-prefs` /
  //   `om-mm-collapsed:<doc>`), and `finish`'s comment described a passthrough the code never performed.
  //   They were removed rather than left as declarations nothing can honour.
  // Summary (`summaryData`) and link lines (`linkLines`) used to live here. SiYuan has no native carrier for
  // either, so they were never persisted: they were session-local view state that vanished on reload, while
  // the UI went on offering them. They are removed rather than left looking supported (section 8).
  numbered?: boolean;
  children: OutlineNode[];
}

// ---- wire format (subset we read/write) ----
export interface DocMeta {
  id: string;
  name: string;
  folderId: string;
  createdAt: number;
  updatedAt: number;
  stared?: boolean;
  encrypted?: boolean;
  version?: number;
  deletedAt?: number;
  /** Attached paragraphs of the title node (the document root) (the paragraphs that precede all nodes in the document) */
  paragraphs?: string[];
  // ★ : There used to be a `mindmapWire?: OmWireConfig` (the mindmap config preserved
  //   as-is from the official definition JSON); it was removed together with `model/wire.ts` (definition import/export)
  //   —— the plugin form no longer has a definition.json path.
}



export interface FolderMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export const TASK_NONE = 0;
export const TASK_TODO = 1;
export const TASK_DONE = 2;

// Aligned with X's official limits (evidence from the bundle: titleMaxLength=100, nodeWordLimit=2000):
// Title at most 100 characters; each topic's body / description note at most 2000 characters (truncated automatically when over).
export const TITLE_MAX = 100;
export const NODE_WORD_LIMIT = 2000;
