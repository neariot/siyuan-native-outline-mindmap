/**
 * Drop-target resolution: the **vertical position** of the finger / cursor inside a row decides the drop semantics.
 *
 * ──────────────────────────────────────────────────────────────────
 * Three-zone semantics
 * ──────────────────────────────────────────────────────────────────
 *
 *     0%  ┌──────────────┐
 *         │   above      │  insert **before** this row (becomes its previous sibling)
 *    25%  ├──────────────┤
 *         │              │
 *         │   child      │  become a **child** of this row
 *         │              │
 *    75%  ├──────────────┤
 *         │   below      │  insert **after** this row (becomes its next sibling)
 *   100%  └──────────────┘
 *
 * ──────────────────────────────────────────────────────────────────
 * Why this is a separate module
 * ──────────────────────────────────────────────────────────────────
 *
 * This `25% / 75%` rule used to be **written out in two places**:
 *
 *   · desktop `onDragOver` (mouse drag)
 *   · mobile `touchHitTest` (finger drag)
 *
 * A comment said "the same boundaries as desktop, so the feel stays identical", but no mechanism
 * guaranteed they actually were —— change one and forget the other, and you get "mouse drag and finger drag
 * landing in different places" —— a defect that is very hard to find (few people try both inputs on the same build).
 *
 * After extracting it:
 *   · there is a single source of truth, so changing the boundaries means changing only here;
 *   · it is a pure function, unit-testable offline (no browser needed);
 *   · the boundary values (exactly 25% / 75%) have defined semantics and are written into tests.
 */

/** Drop zone. `null` means "not a drop target" (the caller handles it). */
export type DropZone = 'above' | 'child' | 'below';

/**
 * Upper boundary: ratio < this value → `above`.
 *
 * Choosing 0.25 is a feel trade-off —— too large makes "becoming a child" hard to hit,
 * too small makes mistakenly inserting next to the row above likely. 0.25/0.75 take an end each while leaving half in the middle,
 * which is a common ratio in tree editors.
 */
export const DROP_ABOVE_RATIO = 0.25;

/** Lower boundary: ratio > this value → `below`. */
export const DROP_BELOW_RATIO = 0.75;

/**
 * Resolve the drop zone from the pointer's relative position inside the row.
 *
 * @param ratio Pointer position as a ratio, measured from the top of that row.
 *              `0` = row top, `1` = row bottom. **Out-of-range is allowed** (clamped to the nearer end),
 *              because callers often pass `(clientY - rect.top) / rect.height` straight in.
 * @returns The drop zone; `null` when the input is not a finite number (the caller should ignore that event).
 *
 * ★ Boundary semantics (written into tests to lock them down):
 *   - `ratio` exactly 0.25 → `child` (**not** `above`)
 *   - `ratio` exactly 0.75 → `child` (**not** `below`)
 *
 *   i.e. the ends use strictly-less / strictly-greater, so the middle band is the **closed interval** `[0.25, 0.75]`.
 *   This way "dead center" is always `child` and never flips at a boundary because of floating-point noise.
 */
export const dropZoneAt = (ratio: number): DropZone | null => {
  if (!Number.isFinite(ratio)) return null;
  if (ratio < DROP_ABOVE_RATIO) return 'above';
  if (ratio > DROP_BELOW_RATIO) return 'below';
  return 'child';
};

/**
 * Convenience wrapper: resolve the drop directly from the pointer's Y plus the row's rect.
 *
 * ★ Fallback for a zero row height (hit in practice):
 *   `getBoundingClientRect()` reports height 0 while the element is `display:none` or not laid out yet.
 *   In that case **do not use `(clientY - top) / 1`** —— that treats "the pixel distance to the row top"
 *   as a ratio, so a pointer 50px away gives ratio=50 → resolved as `below`,
 *   even though the pointer is not on that row at all, producing an inexplicable drop.
 *
 *   The original implementation wrote `rect.height || 1`, which is exactly this mistake.
 *
 *   Correct handling: with height 0 the row has **no usable in-row position information**,
 *   so only "which side of the row the pointer is on" is kept, since that fact is still reliable ——
 *   above the row top or exactly on it → `above`; below the row top → `below`.
 *   That way the absurd result of "pixel distance treated as a ratio" cannot occur.
 *
 * @param clientY Pointer viewport Y coordinate
 * @param rectTop Row top viewport Y coordinate
 * @param rectHeight Row height; `0` or a non-finite value takes the fallback above
 */
export const dropZoneFor = (
  clientY: number,
  rectTop: number,
  rectHeight: number,
): DropZone | null => {
  if (!Number.isFinite(clientY) || !Number.isFinite(rectTop)) return null;
  // Row height unusable: decide by "which side of the row top" only
  if (!Number.isFinite(rectHeight) || rectHeight <= 0) {
    return clientY <= rectTop ? 'above' : 'below';
  }
  return dropZoneAt((clientY - rectTop) / rectHeight);
};

/**
 * Fallback resolution: when the pointer is not inside any row, find the **vertically nearest row** and give a drop target.
 *
 * ★ Why this is needed (measured):
 *   `.om-outline-wrap` reserves room below the last node (`padding-bottom: 40vh` on desktop;
 *   `24px` under `@media (max-width: 768px)` -- `src/styles.css`).
 *   Measured when scrolled to the bottom (`scrollTop = max`): every node was above the screen,
 *   the finger resting at the edge **lands on no row at all** → the drop hint disappears → releasing does nothing.
 *
 * The fallback semantics differ from a direct hit in two ways:
 *   1. Only **two zones** are used (`above` / `below`) —— the finger is **outside** the row,
 *      so the intent "become its child", which needs an in-row position, cannot be expressed;
 *      the boundary is therefore 0.5 (upper half → above, lower half → below),
 *      rather than 0.25/0.75.
 *   2. Only rows **not too far from the finger** are accepted (see `maxDistance`),
 *      otherwise it amounts to "dropping at random" —— the finger is mid-page yet the node lands hundreds of pixels away.
 *
 * @param clientY Finger viewport Y coordinate
 * @param rows Candidate rows (expected to be in DOM order, each with top/height)
 * @param maxDistance Maximum accepted distance in pixels. Beyond it a row is not a candidate.
 * @returns The hit row index and the drop zone; `null` when there is no candidate.
 */
export const nearestRowZone = (
  clientY: number,
  rows: ReadonlyArray<{ top: number; height: number }>,
  maxDistance: number,
): { index: number; zone: DropZone } | null => {
  let best: { index: number; zone: DropZone; dist: number } | null = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const bottom = r.top + r.height;
    const dist = clientY < r.top ? r.top - clientY : clientY > bottom ? clientY - bottom : 0;
    if (dist > maxDistance) continue;
    if (!best || dist < best.dist) {
      // With height 0, `(clientY - top) / 1` treats pixel distance as a ratio (see dropZoneFor
      // for the explanation), so this uses the same fallback as dropZoneFor: only which side of the row top.
      const zone: DropZone =
        r.height > 0 ? ((clientY - r.top) / r.height > 0.5 ? 'below' : 'above') : clientY <= r.top ? 'above' : 'below';
      best = { index: i, zone, dist };
    }
  }
  return best ? { index: best.index, zone: best.zone } : null;
};
