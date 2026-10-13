/**
 * A module under `src/` that only its own tests import.
 *
 * Why this is a finding and not a style question: such a module is fully built, fully typechecked,
 * and its tests pass —— so the suite is green and the feature looks shipped, while no shipped code
 * can reach it. Measured in this repository: the Host Abstraction Layer added
 * `src/core/reconciler.ts`, `src/siyuan/host-driver.ts`, `native-driver.ts` and `virtual-driver.ts`
 * (about a thousand lines) and an architecture document presenting them as the system's data flow,
 * while every non-test importer of all four was **nothing**. `check-dead-methods.py` cannot see this
 * (it scans class methods, and these are free functions and interfaces), and `check-dead-css.mjs`
 * solves the same problem one layer down for CSS classes.
 *
 * The rule is deliberately narrow, and each exclusion is a stated reason rather than a convenience:
 *
 *   · **entry points** (`src/index.ts`, `plugin/index.ts`) are imported by the host, not by us;
 *   · a module **re-exported by an entry point** is reachable through it;
 *   · a module whose top level has a **side effect** (a call, an assignment, a registration) is not
 *     dead code even with no importer —— something must run it, and this tool cannot tell whether
 *     that is the host;
 *   · `.test.ts` files and `e2e/` are not "shipped code" and are never counted as an importer.
 *
 * It reports the whole list and fails when it is non-empty, because "it is only imported by tests"
 * is a decision someone must make on purpose: either wire it up, delete it, or record the reason.
 *
 * Usage: npx tsx scripts/check-unreachable-modules.ts [--selftest]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

/** Entry points the host loads; nothing in this repository imports them. */
const ENTRY_POINTS = ['src/index.ts', 'src/plugin/index.ts'];

/**
 * Modules that are intentionally reachable only from tests, each with the reason. An entry here is a
 * decision on record, not a way to silence the check —— the tool prints the list every run, so an
 * entry that stops being true is visible rather than load-bearing.
 */
const ALLOWED: Record<string, string> = {
  'src/perf/loadgen.ts':
    'a benchmark load generator: its only product is the measurement, so the "caller" is the perf suite',
  'src/siyuan/virtual-kernel.ts':
    'a test double for the live kernel (the mirror the sync/race cases answer against), never shipped',
  'src/siyuan/virtual-driver.ts':
    'HAL target architecture — the offline half of the same driver SPI (docs/ARCHITECTURE.md §2). Its live half, `native-driver.ts`, is now reachable: `mount.ts` constructs it and routes host navigation through it',
};

interface Finding {
  file: string;
  exports: string[];
  testImporters: string[];
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...listSourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** The module specifiers this file imports or re-exports, plus whether its top level does anything. */
function analyse(file: string): { specifiers: string[]; hasSideEffect: boolean; exports: string[] } {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

  const specifiers: string[] = [];
  const exports: string[] = [];
  let hasSideEffect = false;

  const recordExport = (name: string): void => {
    if (name && name !== 'default' && !exports.includes(name)) exports.push(name);
  };

  const visit = (node: ts.Node): void => {
    // import ... from 'x' / export ... from 'x'
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) specifiers.push(spec.text);
      // `export { a } from './x'` / `export * from './x'` make the target reachable.
      if (ts.isExportDeclaration(node) && spec && ts.isStringLiteral(spec)) {
        recordExport('*reexport*');
      }
    }
    // `export function f`, `export const c`, `export class C`, `export interface I`, `export type T`
    const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) recordExport(d.name.text);
        }
      } else if (
        (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) ||
         ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
         ts.isEnumDeclaration(node)) && node.name
      ) {
        recordExport(node.name.text);
      }
    }
    // A top-level statement that is not a declaration/import/export is a side effect (a call,
    // an assignment, a registration). `export const x = f()` is a declaration AND a call, so it
    // counts as a side effect too: importing it would run f().
    if (ts.isSourceFile(node) === false && node.parent === sf) {
      if (ts.isExpressionStatement(node) || ts.isIfStatement(node) || ts.isForStatement(node)) {
        hasSideEffect = true;
      }
      if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) {
          if (d.initializer && !ts.isArrowFunction(d.initializer) && !ts.isFunctionExpression(d.initializer)) {
            // A literal or a plain object is data, not a side effect; a call is.
            const isCall = (n: ts.Node): boolean => {
              let found = false;
              const walk = (x: ts.Node): void => {
                if (ts.isCallExpression(x) || ts.isNewExpression(x)) found = true;
                ts.forEachChild(x, walk);
              };
              walk(n);
              return found;
            };
            if (isCall(d.initializer)) hasSideEffect = true;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { specifiers, hasSideEffect, exports };
}

/** Resolve `./x` from `fromFile` to a repo-relative path, or null. */
function resolveSpecifier(spec: string, fromFile: string): string | null {
  if (!spec.startsWith('.')) return null; // a package, not our module
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base + '.ts', base + '.tsx', path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (fs.existsSync(cand)) return path.relative(ROOT, cand);
  }
  return null;
}

function main(): number {
  const files = listSourceFiles(SRC);
  const shipped = files.filter((f) => !/\.test\.tsx?$/.test(f));

  // importer[target] = [importing files], tests tracked separately
  const importers = new Map<string, string[]>();
  const testImporters = new Map<string, string[]>();
  const sideEffectModules = new Set<string>();
  const exportsOf = new Map<string, string[]>();

  for (const f of files) {
    const rel = path.relative(ROOT, f);
    const { specifiers, hasSideEffect, exports } = analyse(f);
    if (hasSideEffect) sideEffectModules.add(rel);
    if (!/\.test\.tsx?$/.test(f)) exportsOf.set(rel, exports);
    for (const spec of specifiers) {
      const target = resolveSpecifier(spec, f);
      if (!target) continue;
      const bucket = /\.test\.tsx?$/.test(f) ? testImporters : importers;
      bucket.set(target, [...(bucket.get(target) ?? []), rel]);
    }
  }

  const findings: Finding[] = [];
  const allowedSeen = new Set<string>();
  for (const f of shipped) {
    const rel = path.relative(ROOT, f);
    if (ENTRY_POINTS.includes(rel)) continue;
    if (sideEffectModules.has(rel)) continue;
    const real = importers.get(rel) ?? [];
    if (real.length > 0) continue;
    const tests = testImporters.get(rel) ?? [];
    if (tests.length === 0) continue; // nothing imports it at all: `tsc --noUnusedLocals`/review, not this rule
    if (ALLOWED[rel]) {
      allowedSeen.add(rel);
      continue;
    }
    findings.push({ file: rel, exports: exportsOf.get(rel) ?? [], testImporters: tests });
  }

  // An allowlist entry that no longer describes reality is itself stale —— print it, so it is
  // removed rather than left as a rule nobody re-reads.
  const staleAllowed = Object.keys(ALLOWED).filter((k) => !allowedSeen.has(k));

  findings.sort((a, b) => a.file.localeCompare(b.file));

  if (findings.length === 0) {
    console.log(`check-unreachable-modules: ${shipped.length} shipped module(s), none reachable only from tests`);
    if (staleAllowed.length) {
      console.log(`  ⚠ ${staleAllowed.length} allowlist entr${staleAllowed.length === 1 ? 'y is' : 'ies are'} stale ` +
        '(the module is now reachable, or gone) —— remove:');
      for (const k of staleAllowed) console.log(`      · ${k}`);
      return 1;
    }
    return 0;
  }

  console.log(`check-unreachable-modules: ${findings.length} shipped module(s) imported ONLY by tests:`);
  for (const f of findings) {
    console.log(`  · ${f.file}`);
    console.log(`      exports   : ${f.exports.slice(0, 6).join(', ') || '(none)'}${f.exports.length > 6 ? ', …' : ''}`);
    console.log(`      test-only : ${f.testImporters.join(', ')}`);
  }
  console.log(
    '\n  Each is a decision, not automatically a deletion: wire it into the shipped path, delete it,\n' +
    '  or record why it is intentionally unreachable. A module the suite exercises while no shipped\n' +
    '  code can reach it is the shape that makes a green run describe a feature nobody can use.',
  );
  return 1;
}

function selftest(): number {
  let failures = 0;
  const check = (name: string, got: unknown, want: unknown): void => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
    if (!ok) failures++;
  };

  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'unreachable-'));
  const write = (rel: string, body: string): void => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  };
  // a.ts: test-only → reported.  b.ts ← c.ts (shipped) → not reported.
  // c.ts ← d.ts (shipped) → not reported.  d.ts: test-only → reported.
  write('a.ts', 'export const f = (): number => 1;\n');
  write('a.test.ts', "import { f } from './a';\nexport const t = f();\n");
  write('b.ts', 'export const g = (): number => 2;\n');
  write('c.ts', "import { g } from './b';\nexport const h = (): number => g();\n");
  write('d.ts', "import { h } from './c';\nexport const k = (): number => h();\n");
  write('c.test.ts', "import { h } from './c';\nexport const t2 = h();\n");
  write('d.test.ts', "import { k } from './d';\nexport const t3 = k();\n");
  write('side.ts', 'export const s = (): void => {};\nregisterThing();\nfunction registerThing(): void {}\n');

  try {
    const files = listSourceFiles(dir).map((f) => path.relative(dir, f));
    const shipped = files.filter((f) => !/\.test\.ts$/.test(f));
    const importerSets = new Map<string, string[]>();
    const testSets = new Map<string, string[]>();
    const sideEffects = new Set<string>();
    for (const f of files) {
      const { specifiers, hasSideEffect } = analyse(path.join(dir, f));
      if (hasSideEffect) sideEffects.add(f);
      for (const spec of specifiers) {
        const base = path.resolve(path.dirname(path.join(dir, f)), spec);
        const target = [base + '.ts', base + '.tsx'].find((c) => fs.existsSync(c));
        if (!target) continue;
        const rel = path.relative(dir, target);
        const bucket = /\.test\.ts$/.test(f) ? testSets : importerSets;
        bucket.set(rel, [...(bucket.get(rel) ?? []), f]);
      }
    }
    const unreachable = shipped.filter(
      (f) => !sideEffects.has(f) && (importerSets.get(f) ?? []).length === 0 && (testSets.get(f) ?? []).length > 0,
    );
    check('a module imported only by its test is reported', unreachable, ['a.ts', 'd.ts']);
    check('a module reached through a shipped importer is not', unreachable.includes('b.ts'), false);
    check('a module reached through a shipped chain is not', unreachable.includes('c.ts'), false);
    check('a module with a top-level side effect is not reported', unreachable.includes('side.ts'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (failures) {
    console.log(`check-unreachable-modules --selftest: ${failures} case(s) failed`);
    return 1;
  }
  console.log('check-unreachable-modules --selftest: all cases pass');
  return 0;
}

if (process.argv.includes('--selftest')) {
  process.exit(selftest());
}
process.exit(main());
