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
 * A separate module, not `mount.ts`, because the behaviour is pure and must stay assertable
 * offline: importing the mount layer drags in the `siyuan` host module, which does not resolve
 * outside the app — a test importing it fails to load rather than failing on its criterion.
 *
 * Runs offline: python3 scripts/run-tests.py doc-resolve
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOC_RESOLVE_RETRY_MS, NAVIGATION_EVENTS, shouldKeepResolving } from './doc-resolve';

test('an unresolved id keeps the retry loop going', () => {
  assert.equal(shouldKeepResolving('', ''), true, 'nothing known yet → must keep asking');
});

test('★ a resolved id stops the retry loop', () => {
  // The direction that matters: a loop that never stops would re-read a settled document forever.
  assert.equal(shouldKeepResolving('20261016050000-v000009', '20261016050000-v000009'), false);
});

test('★★ a STALE id does not stop the retry loop', () => {
  // ★ The defect this pins: the criterion used to be "is something non-empty", so a resolver
  //   answering with the **previous** document's id stopped the loop for good — while the panel
  //   was showing nothing of the document the user is actually in (measured: rows render, a
  //   default title, and a document holding a code block shows none).
  assert.equal(
    shouldKeepResolving('20261016040000-vstal001', ''),
    true,
    'a stale non-empty id must not be mistaken for the resolved one',
  );
  assert.equal(
    shouldKeepResolving('20261016050000-v000009', '20261016040000-vstal001'),
    true,
    'two different documents mean "not resolved yet"',
  );
});

test('★ the retry interval is short enough to be invisible and long enough not to spin', () => {
  assert.ok(
    DOC_RESOLVE_RETRY_MS > 0 && DOC_RESOLVE_RETRY_MS <= 1000,
    `retry interval out of range: ${DOC_RESOLVE_RETRY_MS}ms`,
  );
});

test('★ a navigation is watched, because the mobile redirect is a navigation and not a switch', () => {
  // The event that was missing in the measured case. Each is a navigation delivery channel;
  // `switch-protyle` (an editor switch) is the one that never arrives there.
  for (const ev of ['popstate', 'hashchange', 'load']) {
    assert.ok(
      (NAVIGATION_EVENTS as readonly string[]).includes(ev),
      `navigation event not watched: ${ev}`,
    );
  }
});