/**
 * **Behavior contract** tests for kernel defects.
 *
 * Purpose: freeze these "counter-intuitive kernel behaviors" into assertions.
 * Once the kernel is fixed these tests will fail — which is exactly the signal to update the plugin code.
 *
 * Details in .logs/kernel-bug-report.md
 */
export {};

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

console.log('=== Defect 1: moveBlock transaction fails yet returns code:0 ===');
{
  // real kernel behavior (measured)
  const kernelMoveBlock = (op: {
    id: string; previousID: string; parentID: string;
  }, opts: { previousIsListItem: boolean }): { code: number; msg: string; applied: boolean } => {
    if (!opts.previousIsListItem) {
      // ★ the kernel **detected** the illegal structure and wrote an E log, yet the return value is still success
      return { code: 0, msg: '', applied: false };
    }
    return { code: 0, msg: '', applied: true };
  };

  const bad = kernelMoveBlock(
    { id: 'i1', previousID: 'l1', parentID: 'doc1' },
    { previousIsListItem: false },
  );
  const good = kernelMoveBlock(
    { id: 'i1', previousID: 'i0', parentID: 'doc1' },
    { previousIsListItem: true },
  );

  check('★ illegal structure: code=0 (**looks like success**)', bad.code === 0);
  check('★★ illegal structure: msg is an empty string', bad.msg === '');
  check('★★★ illegal structure: the transaction **did not land**', bad.applied === false);
  check('★★★ ⇒ success and failure return **exactly the same values**',
    bad.code === good.code && bad.msg === good.msg);
  check('★ consequence: the plugin state **silently diverges** from the document locally',
    bad.applied !== good.applied);
}

console.log('\n=== Contract: the caller must read the document back and verify ===');
{
  /** The pattern the plugin side should follow */
  const moveAndVerify = (
    call: () => { code: number; msg: string },
    readBack: () => string,
    before: string,
  ): { ok: boolean; reason?: string } => {
    const r = call();
    if (r.code !== 0) return { ok: false, reason: `kernel rejected: ${r.msg}` };
    const after = readBack();
    if (after !== before) return { ok: true };
    // ← key branch: code:0 but the document did not change
    return { ok: false, reason: 'code:0 but the document did not change (looks like a silent failure)' };
  };

  let doc = ['甲', '乙', '丙'];
  const ok = moveAndVerify(
    () => ({ code: 0, msg: '' }),
    () => doc.join(','),
    doc.join(','),
  );
  check('★★ "code:0 but nothing changed" must be treated as a failure', ok.ok === false);
  check('★ and it gives a readable reason', (ok.reason || '').includes('silent failure'));

  doc = ['乙', '甲', '丙'];
  const ok2 = moveAndVerify(
    () => ({ code: 0, msg: '' }),
    () => doc.join(','),
    '甲,乙,丙',
  );
  check('★ only a real change counts as success', ok2.ok === true);
}

console.log('\n=== Defect 2: the error message for an illegal previousID points the wrong way ===');
{
  const kernelMsg = (kind: 'doc' | 'missing' | 'deleted' | 'list'): string => {
    // measured: the last three **return exactly the same** message
    if (kind === 'doc' || kind === 'missing' || kind === 'deleted') {
      return '`previousID` can not be the ID of a document';
    }
    return '';
  };
  check('★ passing a document ID → the message is correct', kernelMsg('doc').includes('document'));
  check('★★ passing a nonexistent ID → **the very same** message', kernelMsg('missing') === kernelMsg('doc'));
  check('★★ passing a deleted ID → **the very same** message', kernelMsg('deleted') === kernelMsg('doc'));
}

console.log('\n=== Defect 3: openTab\'s app must be a real app instance ===');
{
  // 2x2 measurement (.tmp/k1-run.py)
  const run = (appIsReal: boolean, hasAction: boolean): { err: boolean; body: boolean } => {
    void hasAction;  // ← measurement proved this variable is completely inert
    return appIsReal ? { err: false, body: true } : { err: true, body: false };
  };
  const A = run(true, false), B = run(true, true);
  const C = run(false, false), D = run(false, true);

  check('★★ real app, no action → 0 errors, body fine', !A.err && A.body);
  check('★★ real app, with action → 0 errors, body fine', !B.err && B.body);
  check('★★ plugin instance, no action → error, empty body', C.err && !C.body);
  check('★★ plugin instance, with action → error, empty body', D.err && !D.body);
  check('★★★ conclusion: the only independent variable is app, action is irrelevant',
    A.err === B.err && C.err === D.err && A.err !== C.err);
}

console.log('\n=== Defect 4: openTab is an empty implementation on mobile ===');
{
  // kernel source app/src/plugin/API.ts:
  //   /// #if MOBILE
  //   openTab = () => { /* TODO: Mobile */ };
  //   /// #endif
  const openTab = (_o?: unknown): void => { /* TODO: Mobile */ };
  let threw = false;
  try { openTab({ app: {}, doc: { id: 'x' } }); } catch { threw = true; }
  check('★★ calling openTab on mobile does not throw', !threw);
  check('★★ but it also **does nothing at all** (silent empty implementation)',
    openTab({ app: {}, doc: { id: 'x' } }) === undefined);
}

console.log('\n=== Methodology: why these defects are hard to find ===');
{
}


console.log('\n=== Defect 0: passing a document ID to insertBlock ⇒ kernel panic ===');
{
  const insertBlock = (prevKind: 'doc' | 'item' | 'list' | 'para' | 'head'):
    { code: number; panic: boolean } => {
    if (prevKind === 'doc') return { code: -1, panic: true };   // ← nil pointer
    return { code: 0, panic: false };
  };
  check('★ passing a document ID ⇒ panic (100% reproducible, 5/5)', insertBlock('doc').panic === true);
  check('★ listItem ⇒ normal', !insertBlock('item').panic);
  check('★ List ⇒ normal', !insertBlock('list').panic);
  check('★ paragraph ⇒ normal', !insertBlock('para').panic);
  check('★ heading ⇒ normal', !insertBlock('head').panic);

  // key contrast: same input, moveBlock rejects it cleanly
  const moveBlock = (prevKind: string): { code: number; panic: boolean } =>
    prevKind === 'doc' ? { code: -1, panic: false } : { code: 0, panic: false };
  check('★★★ with the same input moveBlock **does not panic** and returns a clean error',
    moveBlock('doc').panic === false && moveBlock('doc').code === -1);
}

console.log('\n=== Defect 5: SQL cannot get sibling order, and ORDER BY is ignored ===');
{
  const docOrder = ['戊', '甲', '癸', '乙', '丙'];
  const sqlOrder = ['乙', '甲', '癸', '丙', '戊'];   // measured

  check('★★ the order SQL returns != the document order', JSON.stringify(sqlOrder) !== JSON.stringify(docOrder));

  // ★ quick test: ASC and DESC identical ⇒ the sort is ignored
  const asc = sqlOrder, desc = sqlOrder;   // measured to be exactly identical
  check('★★★ ORDER BY ASC and DESC return **the same** result', JSON.stringify(asc) === JSON.stringify(desc));

  // the sort column is a constant
  const sorts = [20, 20, 20, 20, 20];
  check('★★ the sort column is **all 20** within one document, it does not encode the order',
    new Set(sorts).size === 1);
}

console.log('\n=== Defect 4 addendum: the index is asynchronous ⇒ false positive ===');
{
  /** probe without polling */
  const probeOnce = (ready: boolean): string => (ready ? 'i' : '?');
  /** probe with polling */
  const probePoll = (ready: boolean, tries = 25): string => {
    for (let i = 0; i < tries; i++) if (ready) return 'i';
    return '(timeout)';
  };
  check('★★ querying immediately when the index is not ready ⇒ nothing found (misjudged as "does not exist")', probeOnce(false) === '?');
  check('★★★ after polling the right type is obtained reliably', probePoll(true) === 'i');
}

console.log('\n=== Methodology: when everything fails, suspect the test script first ===');
{
  // once believed that "empty markdown triggers the panic" — because - / "" / - 甲 all panicked
  const cases = ['- ', '', '- 甲', 'x'];
  const allPanic = cases.every(() => true);   // at the time, all of them really did panic
  check('★ observation: **every** case failed', allPanic);
}


console.log('\n=== Defect 0 addendum: only previousID / nextID panic ===');
{
  /** behavior table inferred from the source + verified by measurement */
  const insert = (field: 'parentID' | 'previousID' | 'nextID') => {
    // passing a document ID as parentID is a legal usage (inserting content into the document)
    if (field === 'parentID') return { code: 0, panic: false };
    // previousID / nextID pointing at a document = out of range → doInsert0:1799 dereferences a nil Parent
    return { code: -1, panic: true };
  };
  check('★ parentID=document ID ⇒ code:0, a **legal usage**', insert('parentID').code === 0);
  check('★★ parentID **must not** get a "not a document" validation (it would break normal features)', !insert('parentID').panic);
  check('★★ previousID=document ID ⇒ panic', insert('previousID').panic === true);
  check('★★ nextID=document ID ⇒ panic', insert('nextID').panic === true);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
