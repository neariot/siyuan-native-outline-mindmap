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
// ★ The structure comes from the TypeScript parser, not from counting braces.
//   Counting was the first version and it was wrong in the one place it had to
//   be right: a brace inside a string literal, a template literal
//   (`${...}` counts as one `{` and one `}` only if the expression is balanced
//   too) or a comment moves the depth, and the "body" silently runs on into the
//   next functions. Measured: the body of `store.ts:moveNodes` came out as
//   **949 lines** -- the rest of the class, 13 more methods -- while every
//   assertion in the test that used it passed, because they were being asked
//   about text nobody meant to probe. The parser knows where a block ends, so
//   the question is asked of the compiler instead of reconstructed by hand.
//
// So: `fnBody(src, header)` cuts a function body with the parser, and
// `stripComments(src)` removes comments without touching string literals.
// Use both before every source-text assertion.

import * as ts from 'typescript';

/** Parsing the same file once per assertion is wasteful; the text is the cache key. */
const parsed = new Map<string, ts.SourceFile>();

const parse = (src: string): ts.SourceFile => {
  let sf = parsed.get(src);
  if (!sf) {
    sf = ts.createSourceFile('probe.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    parsed.set(src, sf);
  }
  return sf;
};

/** The function-like declaration that starts at or after `from`, nearest first. */
const nearestFunctionBody = (src: string, from: number): ts.Node | null => {
  const sf = parse(src);
  let best: { body: ts.Node; start: number } | null = null;
  const visit = (node: ts.Node): void => {
    const body = (node as { body?: ts.Node }).body;
    const isFunctionLike =
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node);
    if (isFunctionLike && body && ts.isBlock(body)) {
      const start = node.getStart(sf);
      // Nearest at or after `from`, and the **outermost** one: for
      // `const x = () => { const y = () => {...} }` asked about `const x = (`, the answer is x's body,
      // so a later, inner function must not win.
      if (start >= from && (best === null || start < best.start)) best = { body, start };
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return best === null ? null : (best as { body: ts.Node }).body;
};

/** The statement whose `{...}` block starts at or after `from`, nearest first, by the parser. */
const nearestBlock = (src: string, from: number): ts.Node | null => {
  const sf = parse(src);
  let best: { node: ts.Node; start: number } | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isBlock(node)) {
      const start = node.getStart(sf);
      if (start >= from && (best === null || start < best.start)) best = { node, start };
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return best === null ? null : (best as { node: ts.Node }).node;
};

/**
 * The call expressions whose **callee** matches `pattern`, read through the parser.
 *
 * For an invariant of the shape "this call must not appear outside that helper": a text search cannot
 * make that statement, because the name is also written in the comments that explain why —— measured on
 * `mount.ts`, where `guardRef.current.beginApply` appears **0 times** as a call and **4 times** in prose.
 * Searching the text reports the prose, and the "fix" would be to stop writing the explanation down.
 */
export function callSites(src: string, pattern: RegExp): string[] {
  const sf = parse(src);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sf);
      if (pattern.test(callee)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        found.push(`${callee} (line ${line + 1})`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * The value written for one property of an object-literal argument, for every call whose callee matches.
 *
 * The invariant this exists for: "this call must pass **this** value for that property" —— usually
 * because the alternative is known to fail (measured), so substituting it is a defect rather than a courtesy.
 *
 * ★ Read through the parser, not with a regex over the call's text: that text contains the whole object
 *   literal, so a regex finds the first `app:` it can see and may report a nested or commented one. It is
 *   also why the value comes back as *one property's initialiser* rather than as the call's text ——
 *   `app: appRef ?? plugin` and `app: appRef` must not read the same.
 */
export function callArgProps(
  src: string,
  pattern: RegExp,
  prop: string,
): Array<{ value: string; line: number }> {
  const sf = parse(src);
  const found: Array<{ value: string; line: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && pattern.test(node.expression.getText(sf))) {
      for (const arg of node.arguments) {
        if (!ts.isObjectLiteralExpression(arg)) continue;
        for (const p of arg.properties) {
          if (!ts.isPropertyAssignment(p)) continue;
          if (p.name.getText(sf).replace(/['"]/g, '') !== prop) continue;
          const { line } = sf.getLineAndCharacterOfPosition(p.initializer.getStart(sf));
          found.push({ value: p.initializer.getText(sf), line: line + 1 });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Every JSX element whose `name` attribute's initialiser is written `value`, with all its attribute names.
 *
 * The invariant this exists for: "every element that carries this ref must also carry these attributes".
 * A panel container that can be focused needs `tabIndex`, or `box.focus()` silently does nothing and the
 * container's `onKeyDown` never receives Escape —— a defect that no type check and no browser error reports.
 *
 * ★ Read through the parser because the same ref name appears in the JSX, in the `useRef` declaration and in
 *   the prose that explains the rule; and because "the attribute is present" has to be asked of the element
 *   it is present **on**, not of the file.
 */
export function jsxElementsWithAttr(
  src: string,
  name: string,
  value: string,
): Array<{ attrs: string[]; line: number }> {
  const sf = parse(src);
  const out: Array<{ attrs: string[]; line: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attrs = (ts.isJsxElement(node) ? node.openingElement : node).attributes.properties;
      let match = false;
      const names: string[] = [];
      for (const a of attrs) {
        if (!ts.isJsxAttribute(a)) continue;
        const attrName = a.name.getText(sf);
        names.push(attrName);
        if (attrName === name && a.initializer?.getText(sf) === value) match = true;
      }
      if (match) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        out.push({ attrs: names, line: line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Every JSX element whose `name` attribute's initialiser **contains** `needle`.
 *
 * For the question "which element wires a handler that does this?" —— e.g. the find bar's Escape lives in the
 * input's own inline `onKeyDown`, not in the panel container's, so it has to be found on the element rather
 * than by looking for the nearest function body (the inline arrow sits inside a large component callback, and
 * a body search walks out to that callback instead).
 */
export function jsxElementsWithAttrContaining(
  src: string,
  name: string,
  needle: string,
): Array<{ init: string; line: number }> {
  const sf = parse(src);
  const out: Array<{ init: string; line: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attrs = (ts.isJsxElement(node) ? node.openingElement : node).attributes.properties;
      for (const a of attrs) {
        if (!ts.isJsxAttribute(a)) continue;
        if (a.name.getText(sf) !== name) continue;
        const init = a.initializer?.getText(sf) ?? '';
        if (init.includes(needle)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          out.push({ init, line: line + 1 });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Every assignment whose left-hand side is written `lhs`, with the right-hand side's text.
 *
 * For "this state really is initialised **from** that value" —— which a call-site search cannot answer, and
 * which a body search answers badly when the body has more than one function in it (a React effect with a
 * cleanup closure is the case that produced a 28-character body for the anchor that was asked about).
 */
export function assignmentsTo(src: string, lhs: string): Array<{ value: string; line: number }> {
  const sf = parse(src);
  const out: Array<{ value: string; line: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (node.left.getText(sf) === lhs) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        out.push({ value: node.right.getText(sf), line: line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The arguments of every call whose callee matches `pattern`, as written. */
export function callArgs(src: string, pattern: RegExp): Array<{ args: string[]; line: number }> {
  const sf = parse(src);
  const out: Array<{ args: string[]; line: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && pattern.test(node.expression.getText(sf))) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      out.push({ args: node.arguments.map((a) => a.getText(sf)), line: line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * The body of the **innermost function that contains** `anchor` —— for anchors that are statements inside a
 * body rather than a declaration header.
 *
 * ★ Why this exists next to `fnBody`: `fnBody` takes the nearest function *starting at or after* the anchor,
 *   which is right when the anchor **is** the declaration (`fnBody(src, 'const pushUndo = React.useCallback(')`)
 *   and silently wrong when the anchor is a statement inside a body —— it then returns the next nested
 *   function, which may be a React effect's cleanup closure: asking about a line in a `useEffect` body
 *   returned the 28-character body `{ alive = false; }`, and a check written on it would have asserted
 *   against the wrong code while looking perfectly reasonable.
 *
 * Rule of thumb: anchor on the header and use `fnBody`; anchor anywhere inside the body and use this. The two
 * are deliberately separate —— making `fnBody` "find the enclosing function" would break every existing call
 * site, because a header anchor is also contained in the surrounding component.
 */
export function enclosingBody(src: string, anchor: string): string {
  const at = src.indexOf(anchor);
  if (at < 0) return '';
  const sf = parse(src);
  let best: { start: number; text: string } | null = null;
  const visit = (node: ts.Node): void => {
    const body = (node as { body?: ts.Node }).body;
    const isFunctionLike =
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node);
    if (isFunctionLike && body && ts.isBlock(body)) {
      const start = node.getStart(sf);
      if (start <= at && at <= node.getEnd()) {
        // innermost: the function that starts last also ends first, so the largest start wins
        if (best === null || start > best.start) best = { start, text: sf.text.slice(body.getStart(sf), body.getEnd()) };
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return best === null ? '' : stripComments((best as { text: string }).text);
}

/**
 * Remove line and block comments, leaving string literals alone.
 *
 * ★ Built on the compiler's scanner rather than on hand-tracked quotes: the hand-tracked version reads
 *   `/` inside a string, a template or a regular expression as a comment opener in the cases where it
 *   cannot tell them apart, and deleting real code from the probed text turns a check silently green.
 */
export function stripComments(src: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, src);
  let out = '';
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) {
      out += src.slice(scanner.getTokenStart(), scanner.getTokenEnd());
    } else {
      // A comment becomes a newline, so line structure survives.
      out += '\n';
    }
    token = scanner.scan();
  }
  return out;
}

/**
 * Cut the body of the function (or arrow function / method) that starts at or after `header`, using the
 * TypeScript parser.
 *
 * Returns `''` when the header is not found, so a check that forgot to assert
 * the header exists fails loudly instead of asserting on an empty string.
 * Pass `header` exactly as it appears in the source; use a fragment that
 * cannot appear twice (e.g. `'const onBulletTouchStart = ('`).
 */
export function fnBody(src: string, header: string, options?: { keepComments?: boolean }): string {
  const start = src.indexOf(header);
  if (start < 0) return '';
  const body = nearestFunctionBody(src, start);
  if (!body) return '';
  const text = src.slice(body.getStart(parse(src)), body.getEnd());
  return options?.keepComments ? text : stripComments(text);
}

/**
 * Cut the body of a function **including** its comments.
 * Use it when the check is about comments themselves (e.g. "the pitfall note
 * is still there"); otherwise prefer `fnBody`, whose result is comment-free.
 */
export function fnBodyWithComments(src: string, header: string): string {
  return fnBody(src, header, { keepComments: true });
}

/**
 * Return the statement whose `{...}` block starts at or after `from` -- **including the header** between
 * `from` and the brace, so a `for (...)` loop's condition is part of the result.
 *
 * Use it to bound a loop or an `if` inside an already-extracted body, instead
 * of guessing a length (`body.slice(loopStart, loopStart + 700)`): a guessed
 * window silently widens or narrows as the surrounding comments change, so the
 * assertion ends up looking at text nobody intended.
 *
 * Returns `''` when there is no block at or after `from`, so a mis-anchored
 * caller fails loudly rather than asserting on the wrong text.
 */
export function braceBlock(src: string, from: number): string {
  if (from < 0) return '';
  const block = nearestBlock(src, from);
  if (!block) return '';
  return src.slice(from, block.getEnd());
}
