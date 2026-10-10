/**
 * Type declarations for `scripts/css-scope.mjs`.
 *
 * That file is a **build-time** PostCSS prefixer (loaded by
 * `rsbuild.config.ts`'s `tools.postcss`). It is written as `.mjs` rather than `.ts` because rsbuild's config
 * loader (jiti) parses it as TypeScript, so type annotations make it throw
 * `ParseError: Unexpected token, expected ","`.
 *
 * but it also has to be covered by the `src/plugin/css-scope.test.ts` unit tests, while tsconfig's
 * `include` only covers `src` —— hence this declaration.
 */
declare module '*/scripts/css-scope.mjs' {
  /** Class name of the plugin container, matching `host.classList.add(...)` in `src/plugin/mount.ts` */
  export const HOST_SCOPE: string;

  /** Whether a selector is **already** scoped (raw text only, so it is not prefixed twice) */
  export function isScoped(selector: string): boolean;

  /**
   * Add the scope prefix to one selector.
   *
   * @param selector Raw selector (without prefix)
   * @param prefixed Result already computed by postcss-prefix-selector; normally use it directly
   */
  export function scopeSelector(selector: string, prefixed: string): string;
}
