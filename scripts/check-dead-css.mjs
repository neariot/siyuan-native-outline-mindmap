// Which class selectors in `src/styles.css` can never match anything?
//
// Why this exists
//   `.om-outline { width: 100%; padding: 0 32px; box-sizing: border-box; }` sat in the stylesheet while
//   the JSX wrote `className="outline"` —— a name that matches **no rule at all**. So the 32px left
//   margin the rule was written for was never applied to anything, the panel had no gutter, and the
//   cross-node selection rectangle that is dragged in that gutter could not work. Nothing failed along
//   the way: an unmatched selector is perfectly legal CSS, the build says nothing, and a screenshot
//   shows a panel that merely looks a little tight. The bug was found by hand, by reading the markup.
//
//   The reverse of this file already exists: `scripts/verify-css-scope.py` fails the build when a
//   selector is **not scoped**. Nothing asked whether a scoped selector matches anything at all.
//
// Reach, and what it cannot see
//   Checked: class names in the plugin's own namespaces (`om-`, `mm-`), which are unambiguous.
//   Not checked: every other class token. A bare `.node-row` is the plugin's, but `.b3-menu` and
//   `.protyle-*` are the host's DOM, and nothing in this repository can tell the two apart statically ——
//   so guessing would either miss dead rules or report the host's. The count of what was skipped is
//   printed on every run rather than left for the reader to assume.
//
// A class counts as reachable when some string in `src/**/*.ts(x)` produces it: a literal
// (`className="om-outline"`), or a template literal pattern (`om-h${n.heading}` produces `om-h1`), which
// is why the templates are compiled into anchored regexes instead of being read as plain text.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS_FILE = path.join(ROOT, 'src', 'styles.css');
const SRC_DIR = path.join(ROOT, 'src');
/** The namespaces this repository owns outright. */
const OWN_PREFIXES = ['om-', 'mm-'];

/** Every `.ts`/`.tsx` file under `dir`, recursively. */
const sourceFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });

/**
 * The class names the source can put on an element.
 *
 * ★ Only the positions that **carry a class** count: a `className` attribute, `classList.add/toggle/remove`,
 *   and the class argument of `setAttribute`. Counting every string in the tree was the first version and it
 *   could not fail: `querySelector('.om-outline')` is a string too, so the class that no element carried was
 *   "produced" by the very code that looked for it. "It appears somewhere in the source" is not the
 *   question —— "can an element wear it" is.
 *
 * ★ Read through the TypeScript parser, not by searching the text: a name in a comment or a doc string would
 *   otherwise count as used and hide the dead rule.
 *
 * A `className` may be composed, so a template literal becomes an anchored pattern (`om-h${n.heading}`
 * produces `om-h1`) rather than a plain token.
 */
const reachableClasses = (files) => {
  const tokens = new Set();
  const patterns = [];
  /** Class names the source builds entirely from a value: reported, because nothing can check them. */
  const dynamicClassNames = [];
  /** The file being read, so a dynamic class name can be reported where it is written. */
  let current = { file: '', sf: null };
  const addText = (text) => {
    for (const t of text.split(/\s+/)) if (t) tokens.add(t);
  };
  /** Adds every class-shaped string inside a class-carrying expression. */
  const addClassValue = (node) => {
    if (!node) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      addText(node.text);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      // A placeholder inside a class list splits it: `om-h${n.heading}` makes one class whose name starts
      // with the text before the placeholder. ✕ Joining the quasis into one pattern and anchoring it does
      // not work, because the static text of a class carries its neighbours' whitespace (`" om-h"`) and no
      // class name has that leading space —— which is how `om-h1` was still reported dead after the fix
      // that was supposed to find it. So the quasis are walked **piece by piece**: an interior piece is a
      // complete class name, and only the last piece of a quasi that ends inside an identifier is a prefix.
      const MARK = '\u0000';
      const joined = [node.head.text, ...node.templateSpans.flatMap((s) => [MARK, s.literal.text])].join('');
      const pieces = joined.split(/\s+/).filter(Boolean);
      for (const piece of pieces) {
        if (!piece.includes(MARK)) { addText(piece); continue; }
        // A piece that begins with the marker is a class name coming from a value; whether it is knowable
        // is decided per placeholder below, where the expression can be inspected.
        if (piece.startsWith(MARK)) continue;
        const prefix = piece.slice(0, piece.indexOf(MARK));
        addText(prefix);
        patterns.push(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`));
      }
      // ★ ...and the parts *inside* the placeholders: `mm-node${sel ? ' mm-selected' : ''}` carries the
      //   class in the expression, and a placeholder may hold another template.
      for (const span of node.templateSpans) {
        // Only a placeholder with no string literal at all is unknowable. `${sel ? ' mm-selected' : ''}`
        // is fully known once the branches are read, and calling that "dynamic" was noise that made the
        // real blind spot invisible.
        let hasLiteral = false;
        const scan = (n) => {
          if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) hasLiteral = true;
          ts.forEachChild(n, scan);
        };
        scan(span.expression);
        if (!hasLiteral) {
          const line = current.sf.getLineAndCharacterOfPosition(span.expression.getStart()).line + 1;
          dynamicClassNames.push(`${path.relative(ROOT, current.file)}:${line}`);
        }
        addClassValue(span.expression);
      }
      return;
    }
    ts.forEachChild(node, addClassValue); // `cond ? 'a' : 'b'`, concatenation, `filter(Boolean)`, ...
  };
  for (const file of files) {
    const sf = ts.createSourceFile(
      file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
    );
    current = { file, sf };
    const visit = (node) => {
      if (ts.isJsxAttribute(node) && ['className', 'class'].includes(node.name.getText())) {
        addClassValue(node.initializer);
      } else if (
        // ★ A props object carries a class too: `React.createElement('div', { className: 'om-mm-saving' })`
        //   is how part of this plugin builds its DOM, and reading only JSX attributes reported every class
        //   built that way as a dead rule.
        ts.isPropertyAssignment(node) &&
        ['className', 'class'].includes(node.name.getText().replace(/['"]/g, ''))
      ) {
        addClassValue(node.initializer);
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const isClassList =
          ts.isPropertyAccessExpression(callee) &&
          ['add', 'toggle', 'remove'].includes(callee.name.getText()) &&
          /classList$/.test(callee.expression.getText());
        const isSetClassAttr =
          ts.isPropertyAccessExpression(callee) &&
          callee.name.getText() === 'setAttribute' &&
          node.arguments.length === 2 &&
          /^['"](class|className)['"]$/.test(node.arguments[0].getText());
        if (isClassList) node.arguments.forEach(addClassValue);
        else if (isSetClassAttr) addClassValue(node.arguments[1]);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { tokens, patterns, dynamicClassNames };
};

const main = () => {
  const { tokens, patterns, dynamicClassNames } = reachableClasses(sourceFiles(SRC_DIR));
  const css = fs.readFileSync(CSS_FILE, 'utf-8');
  const root = postcss.parse(css, { from: CSS_FILE });

  /** class name -> the places the stylesheet declares it (file:line of the rule) */
  const declared = new Map();
  let skipped = new Set();
  root.walkRules((rule) => {
    selectorParser((selectors) => {
      selectors.walkClasses((cls) => {
        if (!OWN_PREFIXES.some((p) => cls.value.startsWith(p))) {
          skipped.add(cls.value);
          return;
        }
        if (!declared.has(cls.value)) declared.set(cls.value, []);
        declared.get(cls.value).push(rule.source.start.line);
      });
    }).processSync(rule.selector);
  });

  const dead = [...declared.entries()].filter(
    ([name]) => !tokens.has(name) && !patterns.some((re) => re.test(name)),
  );

  console.log(
    `dead CSS classes: ${declared.size} plugin class(es) declared in src/styles.css; ` +
      `${skipped.size} class token(s) skipped (not in the plugin's own namespaces)`,
  );
  // Honest about the blind spot: a class assembled from a value cannot be checked against a list, and
  // staying silent about it would read as "all clear".
  if (dynamicClassNames.length > 0) {
    console.log(
      `dead CSS classes: ${dynamicClassNames.length} class name(s) are built from a value, so nothing here ` +
        `can check the rules they might match: ${dynamicClassNames.slice(0, 5).join(', ')}` +
        (dynamicClassNames.length > 5 ? ', ...' : ''),
    );
  }
  if (dead.length === 0) {
    console.log('dead CSS classes: every `om-` / `mm-` class the stylesheet declares can be produced by the source');
    return 0;
  }
  console.log(
    `dead CSS classes: ${dead.length} class(es) declared but producible by nothing in src/ —— ` +
      'the rule is legal CSS, applies to no element, and fails nothing:',
  );
  for (const [name, lines] of dead) {
    console.log(`  · .${name}  (src/styles.css:${[...new Set(lines)].join(',')})`);
  }
  return 1;
};

process.exit(main());
