// "Following the active document" must go through events, not polling.
//
// ## Background
//
// In dock form, `docId` is resolved at runtime (not bound to a fixed document), so when the user switches documents
// the panel content has to follow. The original approach polled with `setInterval(read, 1200)`.
//
// ## Why polling does not work
//
// The polling interval is the lower bound of the delay. Measured with 1200ms polling, after a switch it took **1021ms**
// before the panel caught up; and it spun idle even when no document was switched.
//
// Switched to subscribing to SiYuan's `switch-protyle` event (emitted by `app/src/editor/util.ts`,
// present on both desktop and mobile); measured: 19~91ms after the event it entered the loading state,
// 129~211ms and the content was in place —— about an order of magnitude faster, with zero cost when nothing is switched.
//
// ## Why assert on the source instead of running a browser
//
// Verifying "latency after a switch" needs a browser, two documents created and switched back and forth —— tens of seconds per round;
// whereas what needs locking here is a **structural constraint**: "no more setInterval polling" +
// "must subscribe to switch-protyle". That is something reading the source can settle,
// in milliseconds, and it will not flicker just because the machine is slow.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'mount.ts'), 'utf8');

test('follows the active document through the switch-protyle event, no polling', () => {
  // ① Must subscribe to switch-protyle.
  assert.match(
    SRC,
    /eventBus\?\.on\(\s*'switch-protyle'/,
    'switch-protyle is not subscribed —— the panel will not follow a document switch',
  );

  // ② Must unbind as a pair, otherwise remounting accumulates listeners.
  assert.match(
    SRC,
    /eventBus\?\.off\(\s*'switch-protyle'/,
    'switch-protyle is subscribed but there is no off —— remounting accumulates listeners',
  );

  // ③ No timer polling may reappear.
  //    (`setInterval` has no legitimate use in this file any more; if it is ever really needed,
  //     the comment must explain why the event is not enough.)
  assert.doesNotMatch(
    SRC,
    /setInterval\(\s*read\s*,/,
    'back to setInterval polling —— the polling interval is the lower bound of switch latency (measured 1021ms)',
  );

  // ④ The event callback must re-resolve from the DOM instead of using the protyle carried by the event.
  //    With a split view there are several editors, and the event carries "the one just switched",
  //    which is not necessarily the one the user is looking at; only going through resolveActiveDocId shares a source with the initial value.
  //
  //    ★ **Strip the comments first** before asserting: the characters between these two call sites are all comments,
  //      matching by character window equals asserting the wording of comments —— changing one comment would raise a false alarm.
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(
    CODE,
    /const onSwitch = \(\): void => \{[\s\S]{0,120}?requestAnimationFrame\(\s*read\s*\)/,
    'the event callback does not re-resolve the active document on the next frame —— with a split view it will follow the wrong editor',
  );
  assert.match(
    CODE,
    /const read = \(\): void => \{[\s\S]{0,200}?resolveActiveDocId\(\)/,
    'reading the active document does not go through resolveActiveDocId —— a different source from the initial value, so the two paths give different answers',
  );
});
