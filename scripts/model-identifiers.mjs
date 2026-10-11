// Identifier inventory for `scripts/check-unsaved-fields.py`, printed as JSON.
//
// Uses the TypeScript compiler rather than a regex over source text: a field name mentioned in a comment
// is not a read path, and "does this line look like a comment" is exactly the hand-rolled analysis that
// is wrong where it matters (AGENTS.md section 7).
//
//   node scripts/model-identifiers.mjs <model.ts> <persistence.ts>...
//
// prints { "fields": { "<interface>.<field>": "<type>" }, "persistence": { "<file>": ["ident", ...] } }

import { readFileSync } from 'node:fs';
import ts from 'typescript';

const [modelPath, ...persistencePaths] = process.argv.slice(2);
if (!modelPath) {
  console.error('usage: model-identifiers.mjs <model.ts> <persistence.ts>...');
  process.exit(2);
}

function parse(path) {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Property names declared directly on each exported interface, with their type text. */
function interfaceFields(path) {
  const sf = parse(path);
  const out = {};
  for (const stmt of sf.statements) {
    if (!ts.isInterfaceDeclaration(stmt)) continue;
    if (!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const member of stmt.members) {
      if (!ts.isPropertySignature(member) || !member.name) continue;
      const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : null;
      if (!name) continue;
      out[`${stmt.name.text}.${name}`] = member.type ? member.type.getText(sf) : 'any';
    }
  }
  return out;
}

/** Every identifier that survives parsing, i.e. comments and string literals are excluded by construction. */
function identifiers(path) {
  const sf = parse(path);
  const names = new Set();
  const visit = (node) => {
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const text = ts.isIdentifier(node) ? node.text : node.name.getText(sf);
      if (text) names.add(text);
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...names].sort();
}

const fields = interfaceFields(modelPath);
const persistence = {};
for (const p of persistencePaths) persistence[p] = identifiers(p);
process.stdout.write(JSON.stringify({ fields, persistence }));
