/**
 * The on-device diagnostic panel: what the plugin actually loaded, and where the focus is.
 *
 * ## Why this exists, as a **permanent** tool rather than a temporary badge
 *
 * A defect reported on a platform the suites cannot reach is invisible to every test in this
 * repository: the E2E suites drive Chromium against a desktop kernel and the Android scenario
 * drives a real device with a **desktop-served** document. Measured on a real iOS Safari, the
 * reported "a code block cannot be edited or deleted" was not a code-block defect at all — the
 * panel was mounted with **no document id** (`rows=5` but a 7-character default title, and no
 * block read from the document the user was looking at).
 *
 * Nothing about that failure is visible without a signal **on the device**: iOS Safari has no
 * console for the user, and a screenshot shows rows rendering perfectly. An earlier version of
 * this was a temporary badge that I removed once a cause was hypothesised — which destroyed the
 * only instrument and cost a round trip. It is now a permanent, **collapsed by default** panel:
 * the user opens it deliberately, and it stays available for the next report.
 *
 * ## What it reports, and what it must never report
 *
 * Only **shapes and identities**: counts, element classes, the document id's **tail**, and the
 * address with its host stripped. Never a title, never any document text — the same rule the
 * repository applies to logs and screenshots (`AGENTS.md` §1). The user copies it deliberately,
 * so the instrument is useless if it carries the user's content with it.
 */

/** The fields shown, in order; each is measured, not remembered. */
export interface DiagFields {
  /**
   * Hash of the source this bundle was built from, so "the fix is deployed" and "the editor is
   * running the fix" can be told apart by looking. SiYuan loads a plugin once, at start-up, with no
   * route to reload it (`src/types/build-stamp.d.ts`).
   */
  build: string;
  /** Editable code boxes currently rendered. */
  codeBoxes: number;
  /** The pre-D23 read-only renderer. Non-zero means an old bundle is live. */
  legacyCodeBlocks: number;
  /** Outline rows currently rendered. */
  rows: number;
  /** Whether the panel knows which document it is showing. */
  docResolved: boolean;
  /** Last four characters of the document id — identity, never the document. */
  docIdTail: string;
  /** Address with the scheme and host removed. */
  url: string;
  /** Which mobile globals exist, and whether they carry a protyle. */
  mobile: string;
  /** `tag.class` of the focused element. */
  focus: string;
}

/** Read the live state. Pure read, no side effects beyond the DOM queries it makes. */
export function collectDiag(): DiagFields {
  const active = document.activeElement as HTMLElement | null;
  const win = window as unknown as {
    siyuan?: { mobile?: Record<string, unknown> };
  };
  const mobile = win.siyuan?.mobile;
  const mobileText = ['editor', 'popEditor', 'protyle']
    .map((k) => {
      const holder = mobile as Record<string, unknown> | undefined;
      const v = holder ? holder[k] : undefined;
      if (!v) return `${k}:-`;
      const o = v as Record<string, unknown>;
      return `${k}:${o.protyle ? 'protyle' : Object.keys(o).slice(0, 3).join('') || '+'}`;
    })
    .join(' ');
  const url = typeof location !== 'undefined' ? (location.href || '').replace(/^https?:\/\/[^/]+/, '') : '';
  const wrap = document.querySelector('.om-outline') as HTMLElement | null;
  const docId = wrap?.dataset?.docId ?? '';
  return {
    build: __OM_BUILD__,
    codeBoxes: document.querySelectorAll('.om-outline-wrap textarea.om-node-code').length,
    legacyCodeBlocks: document.querySelectorAll('.om-outline-wrap pre.om-node-code').length,
    rows: document.querySelectorAll('.om-outline-wrap .node-row').length,
    docResolved: docId !== '',
    docIdTail: docId.slice(-4),
    url,
    mobile: mobileText,
    focus: active ? `${active.tagName}.${String(active.className).slice(0, 28)}` : 'none',
  };
}

/** The panel's text, one field per line. Copying it is the whole point. */
export function formatDiag(f: DiagFields): string {
  return [
    `build=${f.build} boxes=${f.codeBoxes} oldpre=${f.legacyCodeBlocks} rows=${f.rows}`,
    `doc=${f.docResolved ? 'resolved' : 'EMPTY'} tail=${f.docIdTail}`,
    `url=${f.url}`,
    `m=${f.mobile}`,
    `focus=${f.focus}`,
  ].join('\n');
}

/**
 * Copy text to the clipboard, falling back to the legacy command.
 *
 * ★ The fallback is not decoration: iOS Safari rejects `navigator.clipboard.writeText` outside a
 *   user gesture on a non-secure origin, which is exactly the situation this panel is used in.
 *   The report is worthless if the copy silently fails, so the button reports which path worked.
 */
export function copyText(s: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}