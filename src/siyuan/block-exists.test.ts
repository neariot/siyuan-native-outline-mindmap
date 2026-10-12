import { SiYuanClient, SiYuanError } from './api';

/**
 * ★★ `blockExists` must answer "is it still there?" reliably, including where the write path cannot.
 *
 * The defect it exists for: a write-back whose target document was deleted makes the kernel answer **two
 * different messages for one situation**, depending on when the write lands (measured: `failed: indexing`
 * before ~100 ms, `failed: tree not found` after). Only the second is recognised today, and the first names
 * the **child** block being written, so it fails the `docId` guard as well —— the user gets a raw kernel
 * message and no recovery entry point.
 *
 * A read has no such window, which is why this method is a query rather than another substring.
 *
 * ★ The third state is the one worth testing hardest: `null` means "could not tell". A transport failure is
 *   not evidence of deletion, and a method that turned it into `false` would raise a false "your document
 *   was deleted" alarm —— the exact false positive `isTargetGoneError`'s comment records.
 */

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(`${name} ${extra}`);
  }
}

console.log('=== block-exists: a read answers what a write message cannot ===');

/** A client whose requests are answered by `handler` —— no network. */
function clientWith(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): SiYuanClient {
  return new SiYuanClient({
    baseUrl: 'http://example.invalid',
    token: 't',
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as typeof fetch,
  });
}

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

void (async () => {
  {
    // ① Alive: the kernel returns code 0 and a DOM.
    const c = clientWith(() => ok({ code: 0, data: { id: 'x', dom: '<div></div>' } }));
    check('a live block answers true', (await c.blockExists('x')) === true);
  }

  {
    // ② Gone: the kernel returns code -1 with `block not found` (measured at every moment after deletion).
    const c = clientWith(() => ok({ code: -1, msg: 'block not found' }));
    check('a deleted block answers false', (await c.blockExists('x')) === false);
  }

  {
    // ③ Could not tell —— the state that must NOT be reported as deletion.
    const c = clientWith(() => {
      throw new TypeError('Failed to fetch');
    });
    check('★ a transport failure answers null, not false', (await c.blockExists('x')) === null);
  }

  {
    // ④ A permission/other kernel error is also "could not tell", not "gone".
    const c = clientWith(() => ok({ code: -1, msg: 'permission denied' }));
    check('★ a non-"not found" kernel error answers null, not false', (await c.blockExists('x')) === null);
  }

  {
    // ⑤ An empty id is not a question that can be answered.
    const c = clientWith(() => ok({ code: 0, data: { id: '', dom: '' } }));
    check('an empty id answers null', (await c.blockExists('')) === null);
  }

  {
    // ⑥ It really asks the kernel about THIS id (not a cached or other one).
    const seen: string[] = [];
    const c = clientWith((_url, init) => {
      seen.push(String((JSON.parse(String(init?.body ?? '{}')) as { id?: string }).id ?? ''));
      return ok({ code: 0, data: { id: 'x', dom: '' } });
    });
    await c.blockExists('the-doc-id');
    check('the request names the id it was asked about', seen[0] === 'the-doc-id', JSON.stringify(seen));
  }

  {
    // ⑦ It surfaces a real SiYuanError from the read path, so the caller's own error handling still sees one.
    const c = clientWith(() => ok({ code: -1, msg: 'boom' }));
    let threw: unknown = null;
    try {
      await c.getBlockDOM('x');
    } catch (e) {
      threw = e;
    }
    check('the underlying read still raises SiYuanError', threw instanceof SiYuanError, String(threw));
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (failures.length) {
    console.log('\nfailures:');
    failures.forEach((f) => console.log('  ❌ ' + f));
    process.exit(1);
  }
})();
