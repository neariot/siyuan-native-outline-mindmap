// Regression test for "opening the panel first flashes 'this document has no content'".
//
// ## Background (a real defect)
//
// Every time the plugin panel opens, it first shows "this document has no content", and only after a second or two does the real content appear.
//
// ## Root cause
//
// In Dock mode `docId` is resolved **asynchronously** (`OmTabApp` subscribes to SiYuan's
// `switch-protyle` event to update it). On the first render it is still an empty string, so:
//
//     loadDoc() sees !docId -> returns [] directly      // mount.ts's early-return branch
//     setNodes([]) -> nodes.length === 0 -> renders "empty document"
//
// But "not asked yet" and "asked and it turned out empty" are two different things; the code merged them into one `[]`.
//
// Fix: add a `docResolved` flag -- only when the document ID is really obtained is resolution done,
// and until then render "loading" instead of "empty document".
//
// ## Why assert on the source instead of on rendering
//
// `OmTabApp` is not an exported component, and its behaviour depends on SiYuan's event bus and
// on globals, so SSR cannot render it (it takes the `!followActive` branch, which cannot be tested).
// What is asserted here is **that easily-mistyped branch order**:
// the "loading" check must come before the "empty document" one, and must look at `docResolved`.
//
// Such "ordering" defects can also be verified in a browser, but that needs a 40-second build plus opening a browser;
// the essence is a source-structure problem, so reading the source and asserting on it is more direct and more stable.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'mount.ts'), 'utf8');

test('shows "loading" while docId is unresolved, not "this document has no content"', () => {
  // (1) the docResolved flag must exist, and its initial value must follow followActive:
  //    Dock (followActive) must wait for resolution; tab (givenDocId known) need not.
  assert.match(
    SRC,
    /const \[docResolved, setDocResolved\] = React\.useState<boolean>\(!followActive\)/,
    'missing the docResolved flag (or its initial value does not follow followActive) -- ' +
      'in Dock mode docId is resolved asynchronously, so the first frame must not be treated as an "empty document"',
  );

  // (2) it must be set when resolution succeeds, otherwise it stays on "loading" forever.
  assert.match(
    SRC,
    /if \(id\) setDocResolved\(true\)/,
    'docResolved was not set after the document ID was resolved -- it will be stuck on "loading" forever',
  );

  // (3) the key point: the `!docResolved` branch must exist and must come before `lblNoDocLinked` (no linked document).
  const iResolved = SRC.indexOf('if (!docResolved)');
  const iNoDoc = SRC.indexOf('lblNoDocLinked');
  assert.ok(iResolved > 0, 'missing the !docResolved loading branch');
  assert.ok(iNoDoc > 0, 'missing the lblNoDocLinked unlinked-document branch');
  assert.ok(
    iResolved < iNoDoc,
    'the "loading" check must come before the "no linked document" one, otherwise it still flashes the empty state first',
  );

  // (4) when switching documents, nodes must be set back to null so the previous `[]` does not linger.
  //    Without this line, the moment docId turns from an empty string into a real ID it renders once with the stale empty array.
  assert.match(
    SRC,
    /if \(docId\) setNodes\(null\)/,
    'nodes was not reset to null when switching documents -- the stale empty array lingers and flashes the empty state once',
  );
});
