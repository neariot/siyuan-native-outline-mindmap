/**
 * Every string literal in the given files, with its position.
 *
 * ★ Why the compiler and not a regex: a regex over source text cannot tell a string from a comment, from
 * a template expression, or from text inside one already-quoted string, and it is wrong exactly where it
 * matters (`//` inside a URL, an escaped quote, a multi-line template). The tests this powers decide
 * whether a fixture carries real material, so "probably a string" is not good enough.
 *
 * Usage:  node scripts/extract-literals.mjs <file> [<file>...]
 * Output: JSON on stdout —— [{ file, line, column, kind, text }]
 *         kind: "string" | "template" | "jsx-text"
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/extract-literals.mjs <file> [<file>...]');
  process.exit(2);
}

const out = [];
for (const file of files) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    let kind = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) kind = 'string';
    else if (ts.isTemplateExpression(node)) kind = 'template';
    if (kind) {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      out.push({ file, line: line + 1, column: character + 1, kind, text: node.getText(source),
                 start: node.getStart(source), end: node.getEnd() });
    } else if (ts.isJsxText(node)) {
      const text = node.getText(source).trim();
      if (text) {
        const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
        out.push({ file, line: line + 1, column: character + 1, kind: 'jsx-text', text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
process.stdout.write(JSON.stringify(out));
