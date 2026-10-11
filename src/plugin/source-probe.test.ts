/**
 * The **source probes** every structural check in this repository is built on.
 *
 * ★ Why this file exists: the probes assert on source text, and the text they read must not contain comments
 *   —— an assertion whose matched text lives in a comment passes while the output claims it was made about
 *   code (the same trap that turned three red proofs green; AGENTS.md section 7). `stripComments` was written
 *   on a TypeScript **scanner** and was silently wrong on any file containing JSX: lexed in the `Standard`
 *   variant, JSX text desynchronises the scanner at the first apostrophe or backtick inside it, and from
 *   there on comments are swallowed into whatever token spans them. Measured on `outline/Outliner.tsx`: a
 *   body of 11,058 characters came back with **41** comment markers in it, and a comment at offset 95,952 was
 *   part of a 277-character `FirstTemplateToken`.
 *
 *   The direction matters and is why this is a test rather than a note: text that survives stripping makes a
 *   check pass, not fail.
 *
 *   The stripper now reads the comments the **parser** attached (trivia between children, before a closing
 *   brace, and at the head and tail of the file), which is variant-independent. The cases below are the shapes
 *   that had to be got right, each of which was wrong at some point in this file's history: an own-line
 *   comment, a comment on the same line as code (the compiler calls that one *trailing*), a comment right
 *   after an opening brace, one before a closing brace, and a string that contains slashes and must survive.
 */
export {};

import fs from 'node:fs';
import path from 'node:path';
import { enclosingBody, fnBody, stripComments } from './source-probe';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? `  ${detail}` : ''}`);
  }
};

const has = (out: string, needle: string) => out.includes(needle);

console.log('=== every shape of comment is removed ===');
{
  const ownLine = stripComments('const f = () => {\n  const t = 1;\n  // inner note\n  return t;\n};\n// tail note\n');
  check('★★ an own-line comment goes', !has(ownLine, 'inner note') && !has(ownLine, 'tail note'), JSON.stringify(ownLine));
  check('★ and the code around it stays', has(ownLine, 'const t = 1;') && has(ownLine, 'return t;'));

  const sameLine = stripComments('const a = 1; /* why */ const b = 2; // eol\n');
  check('★★★ a comment on the same line as code goes too (the compiler files it as *trailing*)',
    !has(sameLine, 'why') && !has(sameLine, 'eol'), JSON.stringify(sameLine));
  check('★ its code stays', has(sameLine, 'const a = 1;') && has(sameLine, 'const b = 2;'));

  const afterBrace = stripComments('if (a) {\n  // first line of the block\n  b();\n}\n');
  check('★★★ a comment on the first line of a block goes (this was the last case to stay unstripped)',
    !has(afterBrace, 'first line of the block'), JSON.stringify(afterBrace));

  const beforeBrace = stripComments('function f() {\n  doThing();\n  // note\n}\n');
  check('★★ a comment before a closing brace goes (no node follows it)',
    !has(beforeBrace, 'note'), JSON.stringify(beforeBrace));

  const inStrings = stripComments('const u = "https://x/y"; // real\n');
  check('★★★ a string holding slashes survives —— deleting real code turns a check green the other way',
    has(inStrings, '"https://x/y"') && !has(inStrings, 'real'), JSON.stringify(inStrings));

  const jsx = stripComments('const v = <div title="a // b">it\'s fine</div>;\n// after jsx\n');
  check('★★★ JSX text (the apostrophe that desynchronised the scanner) does not hide the comment after it',
    !has(jsx, 'after jsx'), JSON.stringify(jsx));
  check('★ and the JSX itself is untouched', has(jsx, '<div title="a // b">'));
}

console.log('\n=== the probes that use it strip comments from what they return ===');
{
  const src = fs.readFileSync(path.join(__dirname, 'outline', 'Outliner.tsx'), 'utf8');
  // ★ The measured case: a handler body whose comments used to survive in full.
  const body = enclosingBody(src, 'const action = deleteKeyAction({');
  check('★ the body was found (precondition)', body.length > 500, `len=${body.length}`);
  check('★★★ the real file\'s comments are gone from it', !body.includes('//'), `${(body.match(/\/\//g) || []).length} left`);
  check('★ the code it does contain is intact', body.includes("if (action === 'deleteNode')"));

  const fn = fnBody(src, 'const openPanel = (name:');
  check('★ fnBody strips them too', fn.length > 0 && !fn.includes('★'), fn.slice(0, 60));

  // A header that is not there returns '' rather than something plausible —— the failure has to be loud.
  check('★★ a missing header returns an empty body, not a wrong one', fnBody(src, 'const notThere = (') === '');
  check('★★ a missing anchor returns nothing', enclosingBody(src, 'notThereEither') === '');
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
