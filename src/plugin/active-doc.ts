// Resolve the block ID of the "currently active document".
//
// ## Why this was rewritten from scratch
//
// This used to "scan the DOM and guess which document is active", trying four layers of heuristics in turn:
//
//     ① .protyle-wysiwyg[data-node-id]
//     ② the one .protyle[data-node-id] that "contains the focused element"
//     ③ when all of the above miss, take the "last" .protyle
//     ④ [data-root-id]
//
// Every layer can guess wrong. The real defect hit in practice (reported as "after creating a notebook,
// the document keeps saying it has no content"): with several tabs there are **two** .protyle in a split,
// and the one "containing the focused element" is exactly the **just-opened one**, not the one the user is viewing:
//
//     1656ms  hit=focus  id=<doc-id>   ← the just-opened empty document
//             protyles=[the one the user is viewing, the just-opened one]   URL=the one the user is viewing
//
// So the panel reads that empty document, which has no content yet, and shows "This document has no content yet".
//
// ## Now it uses SiYuan's own definition
//
// SiYuan has an explicit implementation for deciding the "currently active document" (`app/src/layout/tabUtil.ts`
// 's `getActiveTab`): it takes `.layout__wnd--active .item--focus`,
// then uses `getInstanceById` to get the Tab instance and reads `model.editor.protyle.block.rootID`
// —— that is how SiYuan itself reads the document ID in `app/src/window/setHeader.ts`.
//
// The key point is that this is **no longer a heuristic**:
//
//   - "which tab is active" is decided by the `item--focus` class that SiYuan maintains,
//     not by us guessing "who contains the focus".
//   - "which document a tab maps to" is given by the kernel object `model.editor.protyle.block.rootID`
//     rather than us guessing "take the last one".
//
// The traversal root of `getInstanceById` is `window.siyuan.layout.centerLayout`
// (note it is **not** `window.siyuan.ws.app.layout` —— the latter no longer exists in 3.8.6,
// so an early version looked in the wrong place here and degraded into DOM scanning).
//
// ## Mobile
//
// Mobile has no centerLayout, but the kernel object answers just as directly:
// `siyuan.mobile.editor.protyle.block.rootID`.
//
// ## Order
//
// Desktop layout → mobile kernel object. Both read the kernel object, with no DOM guessing.

/** The layout structure SiYuan hangs on window (fields change between versions; all treated as optional) */
type SiYuanGlobal = {
  /** Desktop: the layout tree root. This is the default root of SiYuan's `getInstanceById`. */
  layout?: {
    centerLayout?: LayoutNode;
  };
  mobile?: {
    editor?: { protyle?: { block?: { rootID?: string } } };
    protyle?: { block?: { rootID?: string } };
  };
};

/** A layout tree node: may be Layout / Wnd / Tab, decided by structure */
type LayoutNode = {
  id?: string;
  model?: {
    editor?: { protyle?: { block?: { rootID?: string } } };
  };
  /** Tab header element —— its `item--focus` class decides "is active", same as SiYuan */
  headElement?: { classList?: { contains(cls: string): boolean } };
  children?: LayoutNode[];
};

function asGlobal(): SiYuanGlobal | undefined {
  return (globalThis as unknown as { siyuan?: SiYuanGlobal }).siyuan;
}

/**
 * Desktop: get the ID of the document of the "focused tab in the active window".
 *
 * The selector `.layout__wnd--active .item--focus` matches SiYuan's `getActiveTab()`;
 * once found, look the instance up in the layout tree by `data-id` and read its `model`.
 */
function fromDesktopLayout(): string {
  const center = asGlobal()?.layout?.centerLayout;
  if (!center) return '';

  // ① First locate by "which tab is active" —— that is SiYuan's own criterion.
  //
  //    Two paths, fast first then robust:
  //
  //      fast: the data-id of `.layout__wnd--active .item--focus`, identify the tab directly.
  //      robust: walk the layout tree and check whether each Tab's own `headElement` has
  //          the `item--focus` class.
  //
  //    Why the "robust" path is mandatory (measured):
  //    At the moment a Dock panel is opened, SiYuan's layout is in a **transitional state** ——
  //    `.layout__wnd--active` vanishes entirely for an instant (measured hit count 0).
  //    while the Tab's `item--focus` marker in the layout tree **stays correct**:
  //
  //        DOM_active windows=0   models=1   rootID=<root-id> focus=True
  //
  //    Taking only the fast path intermittently fails (measured 3 failures out of 5 runs),
  //    the panel sits at "Loading…" and the user thinks it is broken —— this is exactly the other face of
  //    the report "after creating a notebook, the document keeps saying it has no content".
  const isFocusTab = (node: LayoutNode): boolean => {
    try {
      return node.headElement?.classList?.contains('item--focus') === true;
    } catch {
      return false;
    }
  };

  const walk = (
    node: LayoutNode | undefined,
    depth: number,
    visit: (n: LayoutNode) => boolean,
  ): boolean => {
    // Cap the depth to avoid infinite recursion on abnormal structures.
    if (!node || depth > 8) return false;
    if (visit(node)) return true;
    for (const child of node.children ?? []) {
      if (walk(child, depth + 1, visit)) return true;
    }
    return false;
  };

  // Fast path: when the DOM has an explicit active window, locate the tab exactly by data-id.
  let activeId = '';
  try {
    const el = document.querySelector('.layout__wnd--active .item--focus');
    activeId = el?.getAttribute('data-id') ?? '';
  } catch {
    activeId = '';
  }

  let hit: LayoutNode | undefined;
  if (activeId) {
    walk(center, 0, (n) => {
      if (n.id === activeId && n.model) {
        hit = n;
        return true;
      }
      return false;
    });
  }

  // Robust path: when the fast path misses, find the Tab carrying the `item--focus` marker directly.
  if (!hit) {
    walk(center, 0, (n) => {
      if (n.model && isFocusTab(n)) {
        hit = n;
        return true;
      }
      return false;
    });
  }

  // ② The document ID comes only from the kernel object —— DOM attributes are just render output and lag behind.
  return hit?.model?.editor?.protyle?.block?.rootID ?? '';
}

/** Mobile: the kernel object directly gives the current document */
function fromMobileEditor(): string {
  const g = asGlobal();
  return (
    g?.mobile?.editor?.protyle?.block?.rootID ??
    g?.mobile?.protyle?.block?.rootID ??
    ''
  );
}

/**
 * Get the ID of the currently active document; returns an empty string when it cannot be resolved.
 *
 * When it cannot be resolved, do **not** fall back to guessing (scanning the DOM, taking the last editor, etc.) ——
 * the cost of guessing wrong is "silently reading some other document", far worse than being temporarily empty.
 * Callers should treat an empty value as "still resolving" and show loading.
 */
export function getActiveDocId(): string {
  try {
    return fromDesktopLayout() || fromMobileEditor();
  } catch {
    return '';
  }
}
