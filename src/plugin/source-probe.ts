// Helpers for asserting on the **text** of a source file.
//
// ★ Why this file exists: two ways a source-text assertion goes wrong, and
//   both of them stay quiet.
//
//   1. A fixed character window.
//      `src.slice(start, start + 1400)` moves with every comment edit. Add a
//      paragraph of explanation and the code you meant to look at falls
//      outside the window -- red, with the code perfectly correct. Shorten a
//      comment and the window now covers two branches instead of three --
//      green, saying nothing. The window must be derived from the structure,
//      not from a guessed length.
//
//   2. Asserting on text that still contains comments.
//      Then a comment can satisfy the assertion. A branch that has been
//      deleted still passes, because a comment explains what it used to do.
//      Strip comments first; assert on code only.
//
// So: `fnBody(src, header)` cuts a function body by brace matching, and
// `stripComments(src)` removes comments without touching string literals.
// Use both before every source-text assertion.

/**
 * Remove line and block comments, leaving string literals alone.
 *
 * A naive one-line regex replace of line comments also eats the tail of a line
 * that contains a URL inside a string, which can delete real code from the
 * probed text and turn a check silently green. So walk the text and track
 * whether we are inside a quote.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  // '' = outside a string; otherwise the quote that opened it
  let quote = '';
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        // an escape consumes the next character, whatever it is
        if (i + 1 < n) out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) quote = '';
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      // a block comment becomes a newline, so line structure survives
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      out += '\n';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Cut the body of the function (or arrow function / method) starting at
 * `header`, by matching braces.
 *
 * Returns `''` when the header is not found, so a check that forgot to assert
 * the header exists fails loudly instead of asserting on an empty string.
 * Pass `header` exactly as it appears in the source; use a fragment that
 * cannot appear twice (e.g. `'const onBulletTouchStart = ('`).
 */
export function fnBody(src: string, header: string, options?: { keepComments?: boolean }): string {
  const start = src.indexOf(header);
  if (start < 0) return '';
  const open = src.indexOf('{', start);
  if (open < 0) return '';
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) {
        const body = src.slice(open, j + 1);
        return options?.keepComments ? body : stripComments(body);
      }
    }
  }
  // unbalanced source: return the rest, comments stripped, so the check fails
  // on real content rather than on a truncated one
  const rest = src.slice(open);
  return options?.keepComments ? rest : stripComments(rest);
}

/**
 * Cut the body of a function by brace matching **including** its comments.
 * Use it when the check is about comments themselves (e.g. "the pitfall note
 * is still there"); otherwise prefer `fnBody`, whose result is comment-free.
 */
export function fnBodyWithComments(src: string, header: string): string {
  return fnBody(src, header, { keepComments: true });
}

/**
 * Return the statement whose `{...}` block starts at or after `from`, by brace
 * matching -- **including the header** between `from` and the brace, so a
 * `for (...)` loop's condition is part of the result.
 *
 * Use it to bound a loop or an `if` inside an already-extracted body, instead
 * of guessing a length (`body.slice(loopStart, loopStart + 700)`): a guessed
 * window silently widens or narrows as the surrounding comments change, so the
 * assertion ends up looking at text nobody intended.
 *
 * Returns `''` when there is no brace at or after `from`, so a mis-anchored
 * caller fails loudly rather than asserting on the wrong text.
 */
export function braceBlock(src: string, from: number): string {
  if (from < 0) return '';
  const open = src.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(from, j + 1);
    }
  }
  return src.slice(from);
}
