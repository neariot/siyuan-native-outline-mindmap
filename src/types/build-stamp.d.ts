/**
 * The build stamp: a short hash of the **source**, replaced at build time by
 * `rsbuild.config.ts` (`source.define`).
 *
 * ★ Why it exists: SiYuan loads a plugin bundle **once, at start-up**, and exposes no route to
 *   reload it, so "I deployed a fix" and "the editor is running that fix" are two different claims.
 *   Nothing on screen could tell them apart: the diagnostic panel carried a `build` field whose value
 *   was a hand-written constant (`DBG-iOS2`), so it looked like an instrument and answered nothing.
 *   That is how a fix was declared delivered while the running bundle was three builds old.
 *
 * It is derived from the source rather than from git on purpose: the working tree is the thing being
 * shipped, and a commit id says nothing about uncommitted work.
 */
declare const __OM_BUILD__: string;
