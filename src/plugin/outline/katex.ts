/**
 * KaTeX parsing: reuse the copy SiYuan loads itself instead of bundling one with the plugin.
 *
 * Why bundling can be dropped (measured):
 *   SiYuan's front end lazy-loads KaTeX only **the first time it meets a formula block** ——
 *   in `protyleMethod.mathRender()`:
 *     ```js
 *     const u = node.querySelectorAll('[data-subtype="math"]');
 *     if (u.length === 0) return;                       // no formula, no loading
 *     loadScript(`${app}/js/katex/katex.min.js`, 'protyleKatexScript')
 *       .then(() => loadScript(`${app}/js/katex/mhchem.min.js`));
 *     ```
 *   And `katex.min.js` is **UMD**, whose last branch `e.katex = t()` attaches the instance to `window.katex`.
 *   Measured after opening a document that contains a formula:
 *     `typeof window.katex === 'object'`, `version === '0.16.9'`,
 *     `link/script` point at `/stage/protyle/js/katex/*`.
 *
 * ⚠️ Key point: `window.katex` is **not there from the start**.
 *   Earlier I probed on a page without formulas and got `hasGlobalKatex: false`,
 *   and nearly concluded that SiYuan does not expose it and we must bundle our own. The real reason was that lazy loading had not triggered yet.
 *   So here we must **probe first and actively load when needed**, not trust window outright.
 */

interface KatexLike {
  render: (tex: string, el: HTMLElement, opts?: Record<string, unknown>) => void;
  version?: string;
}

let cached: KatexLike | null = null;
let loading: Promise<KatexLike | null> | null = null;

/** The resource root path SiYuan ships with (both desktop and mobile use /stage/) */
function katexUrl(file: string): string {
  // Same origin as SiYuan's front end, so a relative path works; avoids hardcoding domain/port
  return `/stage/protyle/js/katex/${file}`;
}

/** Injects <link>/<script> once; does nothing if it already exists */
function injectOnce(tag: 'link' | 'script', url: string, id: string): Promise<void> {
  return new Promise((resolve) => {
    if (document.getElementById(id)) {
      resolve();
      return;
    }
    const el = document.createElement(tag);
    el.id = id;
    if (tag === 'link') {
      (el as HTMLLinkElement).rel = 'stylesheet';
      (el as HTMLLinkElement).href = url;
      el.onload = () => resolve();
      el.onerror = () => resolve(); // resolve on failure too, and fall back to plain text
    } else {
      (el as HTMLScriptElement).src = url;
      el.onload = () => resolve();
      el.onerror = () => resolve();
    }
    document.head.appendChild(el);
  });
}

/**
 * Gets a usable KaTeX instance; returns null when unavailable (callers fall back to plain `$..$` text).
 *
 * Order:
 *   1. `window.katex` already exists -> use it directly (SiYuan loaded it already, zero cost)
 *   2. not there -> actively load the copy SiYuan ships (also zero extra bundle size)
 *   3. still failing -> null
 */
export async function getKatex(): Promise<KatexLike | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = (window as any).katex as KatexLike | undefined;
  if (g && typeof g.render === 'function') return g;
  if (cached) return cached;
  if (loading) return loading;

  loading = (async (): Promise<KatexLike | null> => {
    try {
      await injectOnce('link', katexUrl('katex.min.css'), 'omKatexStyle');
      await injectOnce('script', katexUrl('katex.min.js'), 'protyleKatexScript');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const k = (window as any).katex as KatexLike | undefined;
      if (k && typeof k.render === 'function') {
        cached = k;
        // mhchem is the chemical-formula extension; a failure there does not affect the main flow
        void injectOnce('script', katexUrl('mhchem.min.js'), 'protyleKatexMhchemScript');
        return k;
      }
      return null;
    } catch {
      return null;
    } finally {
      loading = null;
    }
  })();

  return loading;
}

/**
 * Renders directly into the element; writes plain text when KaTeX is unavailable.
 *
 * ★ Anti-flicker: SiYuan lazy-loads KaTeX and only injects it on the first formula,
 * `katex.min.js` (measured about 150ms locally, possibly longer on a real device). During that time
 * the node still holds the raw `$E=mc^2$` literal, so the user sees the source flash before it is typeset.
 *
 * Approach: before rendering, mark the element with `data-formula-pending` so CSS hides the content as a
 * placeholder block (keeping the line height to avoid layout jumps); remove the mark once rendering succeeds.
 * Remove it when KaTeX is unavailable (plain-text fallback) too, or the text stays invisible forever.
 */
export async function renderFormula(tex: string, el: HTMLElement): Promise<void> {
  el.setAttribute('data-formula-pending', '1');
  const k = await getKatex();
  if (!k) {
    el.textContent = `$${tex}$`;
    el.removeAttribute('data-formula-pending');
    return;
  }
  try {
    k.render(tex, el, { throwOnError: false });
  } catch {
    el.textContent = `$${tex}$`;
  } finally {
    el.removeAttribute('data-formula-pending');
  }
}
