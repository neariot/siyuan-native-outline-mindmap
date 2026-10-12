/**
 * ★ The SiYuan host's own global, as this suite uses it.
 *
 * `window.siyuan` is real —— the editor puts it there, and the helpers wait on `window.siyuan?.layout` to know
 * the page is interactive. It was read in `e2e/mindmap.ts` and **nothing noticed it was undeclared**, because
 * `tsconfig.json` includes `src` only and Playwright transpiles with esbuild (types stripped, never checked).
 * `tsconfig.e2e.json` now checks this layer, and this declaration is the honest one: only the fields this
 * suite actually reads, typed loosely, so the check catches typos in *our* code rather than modelling SiYuan's
 * whole surface.
 */
declare global {
  interface Window {
    siyuan?: {
      layout?: unknown;
      ws?: unknown;
      [key: string]: unknown;
    };
  }
}

export {};
