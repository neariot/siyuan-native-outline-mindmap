/**
 * Minimal DOM shim —— for components that need to SSR under Node.
 *
 * ## Why it is needed
 *
 * `Mindmap` / `Outliner` at **module load or first render** will hit
 * `window` / `document` (selection, `ResizeObserver`, `matchMedia`, ...),
 * which in a pure Node environment is a straight `ReferenceError`.
 *
 * SiYuan's own gesture tests take the same route (`app/src/mobile/util/sidebarSwipe.test.ts`
 * uses a hand-written shim + `node:vm`) instead of opening a real browser ——
 * a browser costs at least 3.8 seconds to start, while tens of milliseconds are enough here.
 *
 * ## Why a separate module
 *
 * ESM `import`s are hoisted to the top of the file, so "install the shim, then import the component"
 * written in the same file does not work. Put the shim installation logic in this module,
 * and as long as the test imports it **first**, the shim is installed before the component module is evaluated:
 *
 *     import './test-dom-shim';     // ← must come first
 *     import Mindmap from '../mindmap/Mindmap';
 *
 * ## Scope
 *
 * Only the few APIs the render path actually uses are implemented. This is **not** a jsdom replacement ——
 * for real layout / events / CSS use `npm run verify` (a real device).
 */

const g = globalThis as unknown as Record<string, unknown>;

/**
 * Safely install a global.
 *
 * ★ Cannot just write `g.x = g.x ?? ...`: in Node 24, `navigator` and friends are already
 *   **getter-only** globals, and assigning to them throws
 *   `Cannot set property navigator of #<Object> which has only a getter`.
 *   So defineProperty is used here, and a failure is skipped silently ——
 *   these shims are "use it if present, fill it in only if missing", not mandatory overrides.
 */
function defineStub(name: string, value: unknown): void {
  if (g[name] !== undefined) return;
  try {
    Object.defineProperty(g, name, {
      value, writable: true, configurable: true, enumerable: false,
    });
  } catch {
    // Read-only globals that already have a value (such as Node's own navigator) —— nothing to fill in
  }
}

function stubElement(): Record<string, unknown> {
  return {
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    hasAttribute: () => false,
    appendChild() {}, removeChild() {}, insertBefore() {},
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    getContext: () => null,
    getBoundingClientRect: () => ({
      x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0,
      width: 0, height: 0,
    }),
    closest: () => null,
    focus() {}, blur() {}, click() {},
    scrollIntoView() {},
    contains: () => false,
  };
}

defineStub("window", {
  getSelection: () => null,
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({
    matches: false, addEventListener() {}, removeEventListener() {},
  }),
  requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  cancelAnimationFrame() {},
  setTimeout, clearTimeout, setInterval, clearInterval,
  innerWidth: 1400, innerHeight: 900, devicePixelRatio: 1,
  location: { href: '', origin: '', search: '' },
});

defineStub("document", {
  createElement: stubElement,
  createElementNS: stubElement,
  createTextNode: () => ({}),
  createRange: () => ({
    setStart() {}, setEnd() {}, selectNodeContents() {}, collapse() {},
    cloneRange() { return this; },
    getBoundingClientRect: () => ({
      x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
    }),
    getClientRects: () => [],
  }),
  createTreeWalker: () => ({
    nextNode: () => null, currentNode: null, parentNode: () => null,
  }),
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  getElementsByClassName: () => [],
  addEventListener() {}, removeEventListener() {},
  documentElement: {
    setAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, contains: () => false },
  },
  body: {
    appendChild() {}, classList: { add() {}, remove() {}, contains: () => false },
    style: { setProperty() {}, removeProperty() {} },
  },
  head: { appendChild() {} },
  activeElement: null,
});

defineStub("NodeFilter", { SHOW_TEXT: 4, SHOW_ELEMENT: 1 });
defineStub("navigator", { userAgent: 'node', language: 'zh-CN' });
defineStub("location", { href: '', origin: '', search: '' });
defineStub("ResizeObserver", class {
  observe() {} unobserve() {} disconnect() {}
});
defineStub("MutationObserver", class {
  observe() {} disconnect() {} takeRecords() { return []; }
});
defineStub("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0));
defineStub("cancelAnimationFrame", () => {});

export {};
