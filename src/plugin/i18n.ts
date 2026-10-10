/**
 * i18n bridge for UI text.
 *
 * ── Why this layer is needed ────────────────────────────────────────────
 * SiYuan hangs dictionary entries on the **plugin instance** (`this.i18n.<key>`), but the vast majority of
 * the UI is plain React components (mind map canvas, outline editor), which cannot reach the plugin instance ——
 * passing props down through every layer would pollute every component signature.
 *
 * So this is a **module-level singleton**: the plugin installs the lookup function in onload,
 * and any layer can just `import { t } from '.../i18n'`.
 *
 * ── Usage ───────────────────────────────────────────────────────
 *   t('cmdBackToFullMap')                     // plain entry
 *   t('lblTopicCount', { n: boxes.length })   // entry contains an {n} placeholder
 *
 * (An example that looks like a call is a call as far as `scripts/check-i18n-keys.py` is concerned:
 *  it must name keys that really exist, or the gate fails on the documentation.)
 *
 * ★ The catalogue is the **only** source of UI text. There is no fallback argument: a copy of the
 *   string in the call site is a second version of it that drifts the moment either side is edited
 *   (this repository shipped six such call sites whose text no longer matched the catalogue).
 *   Chinese and English both come from `src/plugin/i18n/zh_CN.json` / `en_US.json`.
 *
 *   A missing entry therefore cannot be papered over here. `scripts/check-i18n-keys.py` fails the
 *   build when a key used in code is absent from either catalogue (or when an entry is unused), so
 *   the runtime path below only has to stay harmless: it returns the key, which is visibly wrong
 *   rather than silently English-in-a-Chinese-UI.
 */

/** Lookup function (injected by the plugin during onload) */
type Lookup = (key: string, vars?: Record<string, string | number>) => string;

let lookup: Lookup | null = null;

/**
 * Install the lookup function. Called once by the plugin in onload; onunload passes null to reset,
 * so nothing keeps a stale-language closure after the plugin unloads.
 */
export function setI18nLookup(fn: Lookup | null): void {
  lookup = fn;
}

/** Replace `{name}` placeholders with actual values; if not provided, the placeholder is kept as is */
function interpolate(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (whole, k: string) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : whole,
  );
}

/**
 * Look up one UI string.
 *
 * @param key  i18n entry name; must exist in both catalogues (`scripts/check-i18n-keys.py`)
 * @param vars values substituted for placeholders
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  let raw: string | undefined;
  try {
    raw = lookup?.(key, vars);
  } catch {
    /* A failed lookup must not crash the UI; the key below is what it degrades to */
  }
  // SiYuan returns the key itself for an entry it does not have -- that is a missing entry, not a hit,
  // and the gate above is what keeps it from reaching a user.
  return interpolate(raw && raw !== key ? raw : key, vars);
}
