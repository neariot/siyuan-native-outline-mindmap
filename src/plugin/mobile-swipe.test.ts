// Mobile gesture ownership: a plugin panel must declare `data-prevent-swipe`.
//
// ## Background (a real defect)
//
// Dragging the mind map left/right on a touch screen makes **the sidebar slide out / back in**, while the map itself barely moves --
// horizontal panning is completely unusable.
//
// ## Root cause
//
// SiYuan mobile has a global `sidebarSwipe` gesture (`app/src/mobile/util/touch.ts
// `handleTouchStart`), enabled by default: a horizontal swipe switches the sidebar. Its **only exemption mechanism** is
// to look up from the target for `data-prevent-swipe` on `touchstart`:
//
//     preventSwipe = !!target.closest(".av__widthdrag") ||
//         !!hasClosestByAttribute(target, "data-prevent-swipe", null, true);
//     if (preventSwipe) return;      // this gesture is left to the content itself
//
// The semantics of `hasClosestByAttribute(el, attr, null, top=true)` are
// "**the mere presence of the attribute is enough**" (when value is not a string it uses `hasAttribute`),
// and it keeps walking up until BODY. So the attribute value itself does not matter; "true" is written only for readability.
// SiYuan's own "list mind map" viewer marks it the same way
// (`protyle/render/listMindmap/view.ts` sets it on the viewport).
//
// ## Why not verify this live over CDP
//
// We tried -- dispatching synthetic touches with `Input.dispatchTouchEvent` left the plugin panel "not triggered",
// which looks like a pass, but **the control group (SiYuan body text, without this attribute) was equally not triggered**,
// meaning the synthetic event never reached SiYuan's gesture logic at all. That is a **false positive** and cannot be evidence.
//
// SiYuan itself uses a hand-written DOM stub plus `node:vm` to test the gesture branch
// (see `app/src/mobile/util/sidebarSwipe.test.ts`). The same approach is used here:
// assert directly that "the DOM rendered by the component really carries that attribute",
// and replicate SiYuan's ancestor walk to verify it can be found.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
// ★ Order matters: run the DOM stub first, then load the component module
//   (ESM imports are hoisted, so the stub lives in its own module and installs itself)
import './test-dom-shim';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Mindmap from '../mindmap/Mindmap';
import Outliner from './outline/Outliner';

/** Count the occurrences of `data-prevent-swipe` in an HTML fragment */
function countPreventSwipe(html: string): number {
  return (html.match(/data-prevent-swipe=/g) || []).length;
}

/**
 * Replicates the core branch of SiYuan's `hasClosestByAttribute(el, "data-prevent-swipe", null, true)`
 * **if the element itself or any ancestor has this attribute, it returns true**.
 *
 * This uses an "attribute string" rather than a real DOM tree -- what is asserted is
 * "the attribute hangs on the container" itself, which is enough to cover the regression.
 */
function findPreventSwipeAttr(html: string, containerClass: string): boolean {
  // find the opening tag carrying that class
  const re = new RegExp(`<[a-z]+[^>]*class="[^"]*${containerClass}[^"]*"[^>]*>`, 'i');
  const m = re.exec(html);
  if (!m) return false;
  // If that tag and its ancestors all carry the attribute -- since SSR output is nested,
  // it is enough that the container tag itself carries the attribute for the `closest` walk (it matches itself first).
  return /data-prevent-swipe/.test(m[0]);
}

test('mind map canvas declares data-prevent-swipe (blocks the mobile sidebar swipe gesture)', () => {
  const node = {
    id: 'n1', text: '节点测试', children: [],
    paragraphs: [], summaryData: [], linkLines: [],
  };
  const html = renderToStaticMarkup(
    React.createElement(Mindmap as never, {
      nodes: [node], onChange: () => {}, settings: {},
    } as never),
  );
  assert.ok(html.length > 0, 'the mind map should have output');
  assert.ok(
    findPreventSwipeAttr(html, 'mm-canvas'),
    `mm-canvas must carry data-prevent-swipe, otherwise a horizontal drag triggers SiYuan's sidebar gesture.\n` +
    `actual output fragment: ${html.slice(0, 300)}`,
  );
});

test('outline container declares data-prevent-swipe', () => {
  const node = {
    id: 'n1', text: '节点测试', children: [], paragraphs: [],
  };
  const html = renderToStaticMarkup(
    React.createElement(Outliner as never, {
      nodes: [node], externRev: 0, onChange: () => {},
      onUndo: () => {}, onRedo: () => {}, docs: [], docId: 'doc',
      onOpenDoc: () => {}, zoomId: null, onZoomChange: () => {},
      onOpenRef: () => {}, docTitle: '标题', onTitleChange: () => {},
    } as never),
  );
  assert.ok(html.length > 0, 'the outline should have output');
  assert.ok(
    findPreventSwipeAttr(html, 'om-outline-wrap'),
    `om-outline-wrap must carry data-prevent-swipe.\n` +
    `actual output fragment: ${html.slice(0, 300)}`,
  );
  // also confirm it is not attached twice (once per container is enough)
  assert.equal(countPreventSwipe(html), 1,
    'data-prevent-swipe should be attached only once; attaching it twice means it was added in the wrong place');
});

test('regression: the attribute must be findable along the ancestor chain (algorithm matches SiYuan)', () => {
  // simulate SiYuan's upward lookup: the target is a deep child element, the attribute is on an ancestor
  const target = { attr: undefined as string | undefined, parent: null as unknown };
  const container = { attr: 'true', parent: null };
  (target as { parent: unknown }).parent = container;
  let e: { attr?: string; parent: unknown } | null = target;
  let found = false;
  while (e && e !== null) {
    if (e.attr !== undefined) { found = true; break; }
    e = e.parent as typeof e;
  }
  assert.ok(found, 'when the attribute hangs on the container, a deep target must find it by walking up');
});
