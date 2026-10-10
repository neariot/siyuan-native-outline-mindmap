import React from 'react';
import { type WrappedLine } from '../core/richtext';

/**
 * Draw the lines a node box was measured for, as `<tspan>` elements, preserving inline formatting.
 *
 * ## Why `htmlToText` cannot be used directly
 *
 * Mind-map node text is drawn inside an SVG `<text>`. `fill` on `<text>` is an **element-level** property,
 * so a piece of text can have only one color — this is not an implementation oversight, it is an SVG limitation.
 * The map used to strip the HTML to plain text with `htmlToText` before drawing,
 * so **colors/bold/italics all disappeared in the mind map** (the outline view was fine,
 * because it goes through `contentEditable` + `dangerouslySetInnerHTML`, which support HTML natively).
 *
 * SVG allows multiple colors: nest `<tspan>` inside `<text>`, each `tspan` with its own `fill`.
 * So this renders the runs parsed by `htmlToRuns` as individual `tspan` elements.
 *
 * ★ The lines are **given**, not computed here: `core/layout.ts` breaks the label to fit the box it
 *   sized, and the box height follows the number of lines. Wrapping a second time in the view would be
 *   a second authority for one question, and the text could disagree with the box it was measured for.
 */
export function RichText({
  lines,
  fallbackFill,
  x,
  lineHeight,
  firstDy,
}: {
  /** Lines to draw, already wrapped to the node's width by the layout */
  lines: WrappedLine[];
  /** Use the theme color when there is no explicit color */
  fallbackFill: string;
  /** The `<text>` anchor this block is centered on; a new line must repeat it (SVG continues otherwise) */
  x?: number | string;
  /** Distance between line baselines */
  lineHeight?: number;
  /** Baseline offset for the first line (SVG ink centering, see text-baseline.ts) */
  firstDy?: number;
}): React.ReactElement | null {
  const out: React.ReactElement[] = [];

  lines.forEach((line, lineIndex) => {
    line.runs.forEach((r, runIndex) => {
      const startsLine = runIndex === 0;
      const newLine = lineIndex > 0 && startsLine;
      out.push(
        <tspan
          key={`${lineIndex}-${runIndex}`}
          // A new line repeats `x`; without it SVG would continue from where the previous line ended.
          x={newLine ? x : undefined}
          dy={newLine ? lineHeight : lineIndex === 0 && startsLine ? firstDy : undefined}
          fill={r.color || fallbackFill}
          fontWeight={r.bold ? 'bold' : undefined}
          fontStyle={r.italic ? 'italic' : undefined}
          textDecoration={
            r.strike && r.underline
              ? 'line-through underline'
              : r.strike
                ? 'line-through'
                : r.underline
                  ? 'underline'
                  : undefined
          }
          // Inline code is distinguished with a monospace font
          fontFamily={r.code ? 'ui-monospace, Consolas, monospace' : undefined}
        >
          {r.text}
        </tspan>,
      );
    });
  });

  return out.length ? <>{out}</> : null;
}
