/** `pngjs` has no bundled types —— see the note below. This file is **ambient** (no import/export), which is
 * what makes `declare module` a *declaration* rather than a *module augmentation*. */
/**
 * `pngjs` ships no type declarations, so the frame-stats reader was implicitly `any` —— recorded as an audit
 * finding, and only visible once this layer got typechecked.
 *
 * ★ This lives in a `.d.ts` rather than beside the import: a `declare module` inside a **module** file is a
 *   module **augmentation**, and TypeScript refuses to augment a package that has no types at all
 *   ("Invalid module name in augmentation"). At the top level of an ambient declaration file it is a module
 *   **declaration**, which is the thing that was needed.
 *
 * Only the surface this suite uses is declared. A blanket `declare module 'pngjs'` would let any typo through.
 */
declare module 'pngjs' {
  export interface PngImage {
    width: number;
    height: number;
    data: Buffer;
  }
  export class PNG {
    constructor(opts?: { width?: number; height?: number; fill?: boolean });
    static sync: {
      read(buf: Buffer): PngImage;
      write(img: PngImage): Buffer;
    };
    width: number;
    height: number;
    data: Buffer;
  }
}
