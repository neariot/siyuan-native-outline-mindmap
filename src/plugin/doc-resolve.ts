/**
 * ★★★ The panel must not stay empty because the page was still redirecting when it mounted.
 *
 * ## The defect this covers (the reported "a code block can't be edited or deleted at all", iOS)
 *
 * The active document id was read **once at mount** and afterwards only on `switch-protyle`. On a
 * real iOS Safari neither assumption holds (measured on the user's phone through an on-device
 * badge carrying counts and an id tail — never content):
 *
 * ```
 * url=/stage/build/mobile/?r=7q7zc45     ← the access-code address: no ?id= at all
 * m=editor:version popEditor:- protyle:-  ← siyuan.mobile.editor exists, with no protyle
 * boxes=0 rows=5 tLen=7 dTail=            ← rows and a title render; the document id is empty
 * ```
 *
 * The kernel serves the mobile shell at `?r=<code>` and then redirects to `?id=<rootId>` — the id
 * it actually reads from (`new URLSearchParams(location.search).get("id")` in the kernel's own
 * bundle). That redirect is a **page navigation**, not an editor switch, so `switch-protyle` never
 * fires: with an event-only design the id stays empty for the rest of the session. The panel then
 * shows rows and a title that belong to nothing, and a document holding a code block shows no code
 * block at all — the feature reported broken was never reached.
 *
 * The fix has two halves, and both are load-bearing: keep re-reading while nothing is known
 * (`shouldKeepResolving`), and treat the address as an event source (popstate / hashchange / load).
 *
 * A separate module, not `mount.ts`, because the behaviour is pure and must stay assertable
 * offline: importing the mount layer drags in the `siyuan` host module, which does not resolve
 * outside the app — a test importing it fails to load rather than failing on its criterion.
 *
 * Runs offline: python3 scripts/run-tests.py doc-resolve
 */

/** How long to wait between re-reads while the active document is still unknown. */
export const DOC_RESOLVE_RETRY_MS = 400;

/**
 * Whether the retry loop should keep going.
 *
 * ★★★ The criterion is **equality with what the panel is showing**, not "is something non-empty".
 *
 *   The earlier version asked `id === ''`, and that is a defect waiting to happen: the resolver can
 *   answer with a **stale** document (a mobile shell that still carries the previous document's
 *   protyle, a reopened tab, a second editor). Non-empty, so the loop stopped — while the panel was
 *   showing nothing of the document the user is actually in. That is the "rows render, but the
 *   document I am looking at is not there" shape, and a retry that stops on it cannot recover.
 *
 *   So the loop ends only when the resolved id **is** the one on screen; anything else — empty,
 *   stale, or a different document — keeps it running. It still terminates: once they agree, it
 *   stops, and unmount clears it either way.
 */
export function shouldKeepResolving(currentId: string, shownId: string): boolean {
  // Both empty is the **mount** state, not a resolution: the panel has nothing to show and the
  // resolver has not answered. Treating "equal" as "resolved" here would stop the loop on the one
  // tick that matters most.
  if (currentId === '' && shownId === '') return true;
  return currentId !== shownId;
}

/**
 * Whether a navigation event may be the reason the id finally appeared.
 *
 * ★ Why this is not "any event": the measured mobile redirect is a **page navigation**, and the
 *   earlier design only listened for `switch-protyle` (an editor switch), which a navigation does
 *   not produce. These are the three events a navigation actually delivers.
 */
export const NAVIGATION_EVENTS = ['popstate', 'hashchange', 'load'] as const;