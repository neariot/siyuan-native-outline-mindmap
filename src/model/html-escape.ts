/**
 * HTML escaping and its reverse, in one place.
 *
 * ★★ Five site-local variants had grown across three files, and they did not agree:
 *
 *   · `plugin/mount.ts` and `plugin/outline/Outliner.tsx` each defined their own `escapeHtml` (identical:
 *     `&`, `<`, `>`);
 *   · `Outliner.tsx` had a second, inline one for a title attribute that also escaped `"` —— the only one
 *     that quoted, and only because that call site happened to need it;
 *   · `plugin/sync.ts` and `siyuan/store.ts` each wrote their own six-entity **unescape** chain, with the
 *     same entities in the same order but no shared definition.
 *
 * The escapes agree today; that is the point. A security-relevant transformation with four copies is one
 * edit away from disagreeing, and the copy that forgets a character is the one an attacker's text reaches.
 * Nothing here is clever —— it is deliberately dull, because that is the property being bought.
 */

/** Escape text for use in HTML **content**: `&`, `<`, `>`. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Escape text for use in a **quoted attribute value**: `&`, `<`, `>`, `"`.
 *
 * Separate from `escapeHtml` on purpose. One call site built this inline (a `title` attribute) and the
 * distinction is easy to lose when the escaping is a chain written at the point of use: an attribute value
 * needs the quote character, HTML content does not, and a single function that always escapes `"` would be
 * harmless but would also stop saying which context the caller is in.
 */
export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Turn HTML back into plain text: strip tags, then decode the entities the kernel emits.
 *
 * ★ `&amp;` is decoded **last**. Decoding it first would turn the text `&amp;lt;` into `<`, i.e. it would
 *   invent a tag from data that never was one. The two hand-written chains this replaces both had the
 *   right order; it is written down here because it is the one part of this function that is easy to get
 *   wrong when editing it.
 */
export function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}
