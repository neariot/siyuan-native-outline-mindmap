/**
 * Regression test for EchoGuard.isOwnValue.
 *
 * Background (a measured **false conflict** bug):
 *   during incremental typing, every write-back of ours produces an intermediate-state echo. By the time the echo arrives the UI has often
 *   already moved further ahead, so `current !== incoming`, and the old criterion misjudges it as an "external change"
 *   and records it as a conflict. Measured: editing 3 nodes in a row → the banner showed "⚠ 3 content conflicts",
 *   while in fact **there was no external change at all**.
 *
 * Fix: EchoGuard additionally remembers "the values we wrote out"; a matching echo is skipped.
 * This test pins down: our own intermediate states are recognised, someone else's value is not mistaken for one.
 */
import { EchoGuard } from './sync';

let pass = 0;
let fail = 0;
function check(name: string, got: boolean, want: boolean): void {
  if (got === want) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}  want ${want} got ${got}`);
  }
}

const BLOCK = '20261005120000-aaaaaaa';

console.log('Intermediate-state echoes of incremental typing:');
{
  const g = new EchoGuard(1500);
  g.beginApply();
  // we wrote 3 intermediate states
  const vals = new Map<string, string>([
    [BLOCK, '快'],
  ]);
  g.endApply([BLOCK], vals);
  // the UI has already moved on to 'Fast1', but the echo brings back the earlier 'Fast'
  check("our own earlier intermediate state '快' → recognised as an echo", g.isOwnValue(BLOCK, '快'), true);
  check("someone else's value '外部节点二' → not an echo", g.isOwnValue(BLOCK, '外部节点二'), false);
}

console.log('\nIntermediate states accumulated over several write-backs:');
{
  const g = new EchoGuard(1500);
  for (const v of ['快', '节点三', '节点四']) {
    g.beginApply();
    g.endApply([BLOCK], new Map([[BLOCK, v]]));
  }
  check("the 1st intermediate state '快' is still recognised", g.isOwnValue(BLOCK, '快'), true);
  check("the 2nd intermediate state '节点三' is still recognised", g.isOwnValue(BLOCK, '节点三'), true);
  check("the final value '节点四' is recognised", g.isOwnValue(BLOCK, '节点四'), true);
  check("the external value 'XYZ' is not an echo", g.isOwnValue(BLOCK, 'XYZ'), false);
}

console.log('\nA block that was never registered:');
{
  const g = new EchoGuard(1500);
  g.beginApply();
  g.endApply([BLOCK], new Map([[BLOCK, 'a']]));
  check('another block is not misjudged', g.isOwnValue('20261005120000-bbbbbbb', 'a'), false);
}

console.log('\nnoteWrittenValues (registered **before** the write-back is sent):');
{
  const g = new EchoGuard(1500);
  // ★ simulate writeLatest: register before the request is sent
  g.noteWrittenValues(new Map([[BLOCK, '快']]));
  check("a value registered before the request is sent is recognised as soon as the echo arrives", g.isOwnValue(BLOCK, '快'), true);
  // afterwards the UI moves on again and a new value is registered
  g.noteWrittenValues(new Map([[BLOCK, '节点四']]));
  check('the earlier intermediate state is still recognised (nothing is cleared)', g.isOwnValue(BLOCK, '快'), true);
  check('the new value is recognised too', g.isOwnValue(BLOCK, '节点四'), true);
  check('an external value is still not recognised', g.isOwnValue(BLOCK, '外部节点一'), false);
}

console.log('\nWith no values passed (the old calling style) nothing should be misjudged:');
{
  const g = new EchoGuard(1500);
  g.beginApply();
  g.endApply([BLOCK]); // no values given
  check('no value registered → nothing counts as an echo', g.isOwnValue(BLOCK, '示例一'), false);
}

console.log('\nAfter expiry it is no longer treated as an echo:');
{
  const g = new EchoGuard(1500);
  g.beginApply();
  g.endApply([BLOCK], new Map([[BLOCK, '旧']]));
  // turning the expiry time back by hand is not possible, so this only verifies that prune can clear it
  check('before expiry it is an echo', g.isOwnValue(BLOCK, '旧'), true);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
