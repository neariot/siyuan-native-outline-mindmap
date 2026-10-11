import type { OutlineNode } from './types';
import { now } from './ids';
import { t } from '../plugin/i18n';

export function cloneNodes(nodes: OutlineNode[]): OutlineNode[] {
  return JSON.parse(JSON.stringify(nodes)) as OutlineNode[];
}

export function findNode(nodes: OutlineNode[], id: string): OutlineNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return null;
}

export interface FlatEntry {
  node: OutlineNode;
  parent: OutlineNode | null;
  index: number;
  depth: number;
}

/**
 * Depth-first flat list of **every** node, ignoring fold state.
 *
 * ★★ Five separate copies of this walk existed —— `mount.ts` had two (one as a local `flat`/`w` pair inside
 *    the undo-merge key, one collecting for a baseline), `store.ts` had two (`walk`, `collectAll`), and
 *    `core/map.ts` had this one as a private helper. Measured against a chain, a wide tree, an empty list, a
 *    node with no `children` key and a five-deep chain, all five produced identical output, so consolidating
 *    them needed no judgement about semantics —— which is exactly the kind of duplication worth removing,
 *    because the next caller to copy one of them has a 1-in-5 chance of picking a shape that differs subtly.
 *
 *    It takes an optional `out` so an existing accumulator can be extended, which is what two of the five
 *    call sites did; new callers should omit it.
 */
export function flatNodes(nodes: OutlineNode[], out: OutlineNode[] = []): OutlineNode[] {
  for (const n of nodes) {
    out.push(n);
    if (n.children?.length) flatNodes(n.children, out);
  }
  return out;
}

/**
 * The id of every node in the tree, depth-first.
 *
 * Two call sites collected this by hand (`mount.ts` for the "what still exists" probe before a deletion,
 * `store.ts` for the "what is alive" set a prune reads). They agreed, but the first had to guard
 * `list ?? []` because it is called with a possibly-unset ref while the second could assume an array ——
 * the sort of difference that invites a third copy with a third set of assumptions.
 */
export function collectIds(nodes: OutlineNode[] | null | undefined): Set<string> {
  const ids = new Set<string>();
  const walk = (list: OutlineNode[] | null | undefined): void => {
    for (const n of list ?? []) {
      ids.add(n.id);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return ids;
}

/** Depth-first flat list of *visible* nodes (collapsed subtrees hidden). */
export function flattenVisible(nodes: OutlineNode[]): FlatEntry[] {
  const out: FlatEntry[] = [];
  const walk = (list: OutlineNode[], parent: OutlineNode | null, depth: number) => {
    list.forEach((n, i) => {
      out.push({ node: n, parent, index: i, depth });
      if (!n.collapsed && n.children.length > 0) walk(n.children, n, depth + 1);
    });
  };
  walk(nodes, null, 0);
  return out;
}

export function flattenAll(nodes: OutlineNode[]): FlatEntry[] {
  const out: FlatEntry[] = [];
  const walk = (list: OutlineNode[], parent: OutlineNode | null, depth: number) => {
    list.forEach((n, i) => {
      out.push({ node: n, parent, index: i, depth });
      if (n.children.length > 0) walk(n.children, n, depth + 1);
    });
  };
  walk(nodes, null, 0);
  return out;
}

/** Remove node by id, return removed node (detached). */
export function removeNode(nodes: OutlineNode[], id: string): OutlineNode | null {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) {
      const [gone] = nodes.splice(i, 1);
      return gone;
    }
    const hit = removeNode(nodes[i].children, id);
    if (hit) return hit;
  }
  return null;
}

/**
 * Is `id` inside `node`'s subtree —— `node` itself, or any of its descendants?
 *
 * ★★ This answers the **cycle** question, and it deliberately includes `node` itself. Two call sites had
 *    grown their own version of it and disagreed on exactly that point: the outline's drop guard built a
 *    `Set` that `add`ed the moving node before walking its children, while the mount's reparent guard
 *    walked only `children`. Measured against a tree shaped `a > b > c`, both still refused and allowed
 *    the same drops, because each site reaches "target is the node itself" by a different route —— the
 *    outline through the descendant set, the mount through its earlier `ids.filter((i) => i !== targetId)`
 *    —— so the divergence was invisible. It would not have stayed invisible: a caller that moved that
 *    filter, or a third caller that copied one of the two, would enforce the safety rule in one view and
 *    not the other.
 *
 *    One function, one answer. Callers that must distinguish "itself" from "a descendant" filter first and
 *    pass what remains; callers guarding a reparent treat both as a refusal, which is what this returns.
 */
export function containsNode(node: OutlineNode, id: string): boolean {
  if (node.id === id) return true;
  return node.children.some((c) => containsNode(c, id));
}

/** Does any node in `nodes` contain `id` in its subtree (the node itself included)? */
export function anyContains(nodes: OutlineNode[], id: string): boolean {
  return nodes.some((n) => containsNode(n, id));
}

export function touch(n: OutlineNode): void {
  n.modified = now();
}

/** Strip tags -> plain text (for search / word count / mindmap labels). */
export function htmlToText(html: string): string {
  if (!html) return '';
  // ★★★ Only strip **known tags on the whitelist**; anything shaped like `<x>` is no longer stripped.
  //
  //   The last step used to be `.replace(/<[^>]+>/g, '')` —— a blanket strip.
  //   So when the user really writes angle brackets, the content **vanishes into thin air**:
  //   ```
  //   node text "use <T> for generics" → displayed as "use  for generics"
  //               a<b>c          → displayed as "ac"
  //   ```
  //   And this is **not** SiYuan's fault: measured, the kernel's `getBlockKramdown` stores them as-is
  //   `use <T> for generics` / `a<b>c` / `x < y`, and SiYuan's own editor displays them perfectly correctly
  //   —— only our side ate them.
  //
  //   Fix: restrict tag stripping to a tag-name whitelist. `<…>` outside the list is kept as **literal text**.
  //   ★ The list must cover **every** tag the upstream code in this file can generate; miss one and it will
  //     display a real tag as literal text —— easier to spot than losing characters, but still a bug.
  //     Cross-check it, item by item, against `htmlToKramdown`'s stash list and `kramdownToHtml`'s output.
  //   ★ The list must stay aligned with the producer in `src/core/map.ts`: upstream `kramdownToHtml`
  //     emits `span/u/sup/sub` (kept as-is by the kernel) + `b/code/br/mark/a/img` (generated by the plugin itself).
  //     `<x>` outside the list is kept as literal text.
  const KNOWN_TAG =
    /<\/?(?:span|b|i|u|s|sup|sub|mark|code|kbd|br|p|div|font|a|img|strong|em|del|ins|ruby|rt|table|thead|tbody|tr|td|th)\b[^<>]*>/gi;
  let s = html
    .replace(/<span data-formula="([^"]*)"[^>]*>.*?<\/span>/g, (_, f) => ` $${unescapeAttr(f)}$ `)
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, '[$1]')
    .replace(/<img[^>]*>/g, t('phImage'))
    .replace(/<table[\s\S]*?<\/table>/g, t('phTable'))
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/p>/g, '\n')
    .replace(KNOWN_TAG, '');
  s = s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"');
  return s;
}

function unescapeAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function countWords(nodes: OutlineNode[]): number {
  let total = 0;
  const walk = (list: OutlineNode[]) => {
    for (const n of list) {
      total += htmlToText(n.text).replace(/\s+/g, '').length;
      // attached paragraphs are body text too, so they count towards the word count
      for (const para of n.paragraphs ?? []) {
        total += htmlToText(para).replace(/\s+/g, '').length;
      }
      if (n.children.length > 0) walk(n.children);
    }
  };
  walk(nodes);
  return total;
}

export function countNodes(nodes: OutlineNode[]): number {
  let total = 0;
  const walk = (list: OutlineNode[]) => {
    for (const n of list) {
      total += 1;
      if (n.children.length > 0) walk(n.children);
    }
  };
  walk(nodes);
  return total;
}

export function findPath(nodes: OutlineNode[], id: string): OutlineNode[] | null {
  for (const n of nodes) {
    if (n.id === id) return [n];
    const sub = findPath(n.children, id);
    if (sub) return [n, ...sub];
  }
  return null;
}

