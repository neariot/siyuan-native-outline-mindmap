/**
 * An optional callback prop that the component invokes but that **no call site ever supplies**.
 *
 * Why this is a defect and not a style question: the component calls it, so the code reads as
 * "the caller is told when this happens", and the prop is optional, so nothing complains. The result
 * is an affordance that looks wired and is not —— measured in this repository: the mind map drew a
 * to-do's checkbox with a pointer cursor and a click handler, and no caller ever passed
 * `onToggleTask`, so clicking it did nothing at all.
 *
 * Parsed with the TypeScript compiler rather than with a regex over the source text, because the
 * question is a syntactic one (is this name ever a property of a JSX element?) and a regex answers
 * it wrongly in both directions: a `foo:` inside a comment, a type literal or a string matches; a
 * call spread across a variable (`<C {...p} />`) does not.
 *
 * Usage: npx tsx scripts/check-dead-props.ts [--selftest]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const REPO = path.resolve(__dirname, '..');
const SRC = path.join(REPO, 'src');

interface DeadProp {
  name: string;
  declaredIn: string;
  line: number;
  invokedAt: string[];
}

function filesUnder(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

/**
 * Names declared as an optional callback in a **props** type/interface: `onX?: (id: string) => void;`
 * Restricted to `*Props` types so that an ordinary optional function member (a store's own
 * `expect`, say) is not mistaken for a component prop.
 */
function optionalCallbackProps(sf: ts.SourceFile): Map<string, ts.Node> {
  const found = new Map<string, ts.Node>();
  const visit = (node: ts.Node, inProps: boolean): void => {
    const isPropsType = inProps
      || ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node))
        && ts.isIdentifier(node.name) && node.name.text.endsWith('Props'));
    if (ts.isPropertySignature(node) && isPropsType
      && node.questionToken && node.name && ts.isIdentifier(node.name)) {
      const t = node.type;
      if (t && ts.isFunctionTypeNode(t)) found.set(node.name.text, node);
    }
    ts.forEachChild(node, (c) => visit(c, isPropsType));
  };
  visit(sf, false);
  return found;
}

/**
 * Names a call site actually supplies.
 *
 * Two shapes carry props in this codebase and both count: a JSX attribute (`<C onX={...} />`) and the
 * object literal in `React.createElement(C, { onX })` —— the plugin's own call site builds its
 * element that way, so reading only JSX would report every prop of every component as unsupplied.
 * A spread (`<C {...rest} />`) can supply anything, so a prop spread from a named object is skipped
 * rather than reported: the honest answer there is "cannot see", not "dead".
 */
function suppliedProps(sf: ts.SourceFile): { names: Set<string>; spreadFrom: Set<string> } {
  const names = new Set<string>();
  const spreadFrom = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name)) names.add(node.name.text);
    if (ts.isJsxSpreadAttribute(node) && ts.isIdentifier(node.expression)) {
      spreadFrom.add(node.expression.text);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'createElement' && node.arguments.length > 1) {
      const props = node.arguments[1];
      if (ts.isObjectLiteralExpression(props)) {
        for (const p of props.properties) {
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) names.add(p.name.text);
          else if (ts.isShorthandPropertyAssignment(p)) names.add(p.name.text);
          else if (ts.isSpreadAssignment(p) && ts.isIdentifier(p.expression)) spreadFrom.add(p.expression.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { names, spreadFrom };
}

/** Names invoked somewhere: `onX?.(` or `onX(`. */
function invokedNames(sf: ts.SourceFile): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  const at = (n: ts.Node): string => {
    const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    return `${path.relative(REPO, sf.fileName)}:${line + 1}`;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      // Three shapes, and the name has to come out of the right one of them:
      //   `foo?.()`          -> a destructured prop, the identifier itself
      //   `p.onProbe?.()`    -> a prop reached through the props object, the **property**
      //   `p.onProbe!()`     -> same, non-optional
      // Taking the object (`p`) instead of the property is the mistake that makes a whole props
      // interface invisible to the tool, which is what the selftest exists to catch.
      const e = node.expression;
      let name: string | undefined;
      if (ts.isPropertyAccessExpression(e)) {
        name = ts.isIdentifier(e.name) ? e.name.text : undefined;
      } else if (ts.isIdentifier(e)) {
        name = e.text;
      }
      if (name) {
        const list = hits.get(name) ?? [];
        list.push(at(node));
        hits.set(name, list);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function parse(files: string[]): ts.SourceFile[] {
  return files.map((f) =>
    ts.createSourceFile(f, fs.readFileSync(f, 'utf-8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
}

/** `extraDir` is how the selftest shows the failure path without putting a file in `src/`. */
export function analyse(extraDir?: string): DeadProp[] {
  // Test files declare their own props to drive a component; they are not call sites of it.
  const files = [...filesUnder(SRC, ['.ts', '.tsx']), ...(extraDir ? filesUnder(extraDir, ['.ts', '.tsx']) : [])]
    .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'));
  const parsed = parse(files);
  const supplied = new Set<string>();
  for (const sf of parsed) {
    for (const n of suppliedProps(sf).names) supplied.add(n);
  }
  const invoked = new Map<string, string[]>();
  for (const sf of parsed) {
    for (const [name, where] of invokedNames(sf)) {
      invoked.set(name, [...(invoked.get(name) ?? []), ...where]);
    }
  }
  const dead: DeadProp[] = [];
  for (const sf of parsed) {
    for (const [name, decl] of optionalCallbackProps(sf)) {
      if (supplied.has(name)) continue;
      const called = invoked.get(name);
      if (!called || called.length === 0) continue; // declared and never used at all: a different smell
      const { line } = sf.getLineAndCharacterOfPosition(decl.getStart(sf));
      dead.push({ name, declaredIn: path.relative(REPO, sf.fileName), line: line + 1, invokedAt: called });
    }
  }
  return dead;
}

function selftest(): number {
  // The failure path has to be demonstrable, or the tool cannot tell "clean" from "cannot see".
  const before = analyse();
  // The probe lives in scratch, never in `src/`: a selftest that leaves a file where the build reads
  // it is a selftest that can break the build by being interrupted.
  const dir = path.join(REPO, '.tmp', 'dead-props-selftest');
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, 'probe.tsx');
  const decl = 'interface ProbeProps { onProbe?: (id: string) => void; }\n';
  const body = `${decl}export const C = (p: ProbeProps) => <g onClick={() => p.onProbe?.('x')} />;\n`;
  const suppliedBody = `${decl}export const D = () => <C onProbe={() => {}} />;\n${decl}export const E = () => React.createElement(C, { onProbe: () => {} });\n`;
  let failures = 0;
  try {
    fs.writeFileSync(probe, body);
    const found = analyse(dir);
    if (!found.some((d) => d.name === 'onProbe')) {
      console.error('selftest FAILED: a callback nothing supplies was not reported');
      failures++;
    }
    fs.writeFileSync(probe, `${body}${suppliedBody}`);
    const after = analyse(dir);
    if (after.some((d) => d.name === 'onProbe')) {
      console.error('selftest FAILED: a callback a call site supplies was still reported');
      failures++;
    }
    fs.writeFileSync(probe, '');
    const blank = analyse(dir);
    if (blank.length !== before.length) {
      console.error('selftest FAILED: an empty file changed the result');
      failures++;
    }
  } finally {
    fs.rmSync(probe, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(failures === 0 ? 'selftest ok: reported when unsupplied, quiet when supplied' : `selftest: ${failures} failure(s)`);
  return failures;
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) {
    process.exit(selftest() === 0 ? 0 : 1);
  }
  const dead = analyse();
  if (dead.length === 0) {
    console.log('dead props: none —— every optional callback a component invokes is supplied by a call site');
    process.exit(0);
  }
  console.error(`dead props: ${dead.length} optional callback prop(s) invoked but never supplied:`);
  for (const d of dead) {
    console.error(`  ${d.name}  declared ${d.declaredIn}:${d.line}, invoked at ${d.invokedAt.join(', ')}`);
  }
  console.error('  An invoked prop nothing supplies is an affordance that looks wired and is not.');
  process.exit(1);
}