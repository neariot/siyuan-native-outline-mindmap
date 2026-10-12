import { SiYuanClient, SiYuanError } from './api';

/**
 * ★ `uploadAsset` must go through the client's own `fetchImpl`, not the global `fetch`.
 *
 * The constructor documents that seam as "Custom fetch (makes test injection easy)", and every other call
 * site honours it —— `uploadAsset` did not. So an injected fake could not observe or fail the one path that
 * writes a file into the user's workspace: the upload could return any status, or never be issued at all,
 * and a test would see nothing.
 *
 * These cases fail with the global `fetch` in place, which is what makes them worth having.
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

console.log('=== upload-asset: the client honours its own fetch seam ===');

/** A client whose every request is answered by `handler`, with no network involved. */
function clientWith(handler: (url: string, init?: RequestInit) => Response): SiYuanClient {
  return new SiYuanClient({
    baseUrl: 'http://example.invalid',
    token: 'test-token',
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(String(input), init)) as typeof fetch,
  });
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

(async () => {
  {
    // ① The call is observed by the injected fetch at all, and hits the documented endpoint.
    const seen: string[] = [];
    const client = clientWith((url) => {
      seen.push(url);
      return ok({ code: 0, data: {} });
    });
    const assetPath = await client.uploadAsset(new Blob(['x']), 'shot.png');
    check('the injected fetch sees the upload', seen.length === 1, JSON.stringify(seen));
    check('it posts to /api/file/putFile', seen[0] === 'http://example.invalid/api/file/putFile', seen[0] ?? '');
    // SiYuan references assets without the `data/` prefix.
    check('the returned path drops the data/ prefix', assetPath.startsWith('assets/om-'), assetPath);
    check('the returned path keeps the extension', assetPath.endsWith('.png'), assetPath);
  }

  {
    // ② A failing upload must raise, not be swallowed —— the reason the seam matters.
    const client = clientWith(() => ok({ code: -1, msg: 'disk full' }));
    let threw: unknown = null;
    try {
      await client.uploadAsset(new Blob(['x']), 'shot.png');
    } catch (e) {
      threw = e;
    }
    check('a non-zero kernel code raises', threw instanceof SiYuanError, String(threw));
    check('the error carries the endpoint', threw instanceof SiYuanError && threw.endpoint === '/api/file/putFile');
    check('the error carries the kernel message', String((threw as Error)?.message ?? '').includes('disk full'));
  }

  {
    // ③ The multipart body must carry the path/isdir/file fields the kernel requires. The path must be
    //    relative to the workspace and under data/assets/ —— `assets/...` is accepted with code 0 but lands
    //    where SiYuan never looks, which shows up as "upload succeeded but the image does not display".
    // Typed as a mutable holder, not `FormData | null`: TypeScript narrows a variable assigned inside a
    // callback to `never` at the read site, because it cannot see that the callback ran.
    const sent: { body: FormData | null } = { body: null };
    const client = clientWith((_url, init) => {
      sent.body = init?.body as FormData;
      return ok({ code: 0, data: {} });
    });
    await client.uploadAsset(new Blob(['x']), 'a/b:c.png');
    const path = String(sent.body?.get('path') ?? '');
    check('the body carries a path field', path.length > 0, path);
    check('the path is under data/assets/', path.startsWith('data/assets/om-'), path);
    check('the path is relative (no leading slash)', !path.startsWith('/'), path);
    check('isDir is false', sent.body?.get('isDir') === 'false', String(sent.body?.get('isDir')));
    check('the file part is present', sent.body?.get('file') !== null);
    check(
      'an unsafe filename is sanitised (no colon or slash in the name part)',
      !/[:/]/.test(String((sent.body?.get('file') as File | null)?.name ?? '')),
      String((sent.body?.get('file') as File | null)?.name ?? ''),
    );
  }
})();

console.log(`\n${pass}/${pass + fail} passed`);
if (failures.length) {
  console.log('\nfailures:');
  failures.forEach((f) => console.log('  ❌ ' + f));
  process.exit(1);
}
