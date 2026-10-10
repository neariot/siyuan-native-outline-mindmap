import { request, type APIRequestContext } from '@playwright/test';

/**
 * The E2E test document —— created by the tests themselves, not dependent on whichever document happens to exist in the workspace.
 *
 * ## ★ Why one has to be created on purpose
 *
 * At first an existing "product planning demo" document from the workspace was reused, and it **reported a false bug**:
 * that document's tree was `root → 1 child node → 6 → 10`,
 * so the synthetic root has **only one child node**, `calcSplitIndex` returns 1,
 * and "balanced" puts every node on the right —— which is in fact **correct behavior** (one node cannot be split in half),
 * but the test asserted "the two structures must differ geometrically", so it went red.
 *
 * Lesson: **the shape of the test document must actually exercise the feature under test.**
 * What is created here is "root + 4 branches × 2 child nodes",
 * where balanced splits 2/2 and alternating assigns by odd/even to the two sides, so the two differ.
 *
 * Besides, with equal-weight subtrees "balanced" and "alternating" give the **same left/right counts** (6/6 each),
 * and the set of x coordinates can match as well —— so the assertion must compare "which node is on which side",
 * not just the set of coordinates, otherwise the two cannot be told apart (this pitfall was hit too).
 */

const TEST_DOC_TITLE = 'E2E-导图结构测试';

/** 4 branches × 2 child nodes —— balanced and alternating assign them differently. */
const TEST_DOC_MD = `- 甲分支
  - 甲一
  - 甲二
- 乙分支
  - 乙一
  - 乙二
- 丙分支
  - 丙一
  - 丙二
- 丁分支
  - 丁一
  - 丁二
`;

export interface KernelApi {
  /** Release the underlying connection when done (`request.newContext` does not reclaim it by itself). */
  dispose(): Promise<void>;
  sql(stmt: string): Promise<unknown[]>;
  call(path: string, payload?: Record<string, unknown>): Promise<{ code: number; data: unknown; msg: string }>;
}

/** Build a client that talks to the kernel API (using Playwright's request, with baseURL applied automatically). */
export async function kernelApi(baseURL: string, token: string): Promise<KernelApi> {
  const ctx: APIRequestContext = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
  });
  return {
    dispose: () => ctx.dispose(),
    async call(path, payload = {}) {
      const r = await ctx.post(path, { data: payload });
      return r.json();
    },
    async sql(stmt) {
      const r = await ctx.post('/api/query/sql', { data: { stmt } });
      const j = await r.json();
      return (j?.data ?? []) as unknown[];
    },
  };
}

/** Make sure the test document exists and return its ID (reused if present, so runs do not pile up documents). */
/**
 * Get the test document **and make sure its content is exactly `TEST_DOC_MD`**.
 *
 * ## Why it is not "reuse it if it exists"
 *
 * "Reuse it if it exists" gets polluted by probe scripts: a probe typed text into the shared document (`甲一XZZZ`),
 * and from then on every test that depends on the document's shape runs against a **document that has already been modified**.
 * The failures look all sorts of ways (wrong row count, wrong structure), while the real cause (the document is dirty)
 * is completely invisible —— which makes investigating extremely expensive.
 *
 * A test's **precondition** has to be deterministic.
 *
 * ## Two wrong reset routes were tried; both are recorded
 *
 * 1. **Using `createDocWithMd` to write the same hpath and overwrite** —— does not work.
 *    SiYuan **creates another document with the same name** (document count 1 → 2 as measured),
 *    and a SQL `LIMIT 1` afterwards picks one at random, so the test then runs against "one of the two".
 *    This pitfall is extremely subtle: the test passes and fails intermittently and looks like a flake, but the document was actually duplicated.
 * 2. **Using `updateBlock` to modify the document block** —— it returns `code: 0` but the content is not really replaced;
 *    reading it back still gives the old text plus a pile of scrambled order. A document block is not an ordinary block, so do not modify it as one.
 *
 * What works is to **delete and recreate** (`removeDocByID` + `createDocWithMd`):
 * it is the most deterministic and goes through the official entry point —— the old `removeDoc` makes the kernel panic.
 *
 * ⚠️ So the document id **changes every time**; callers must use the returned value and must not cache it.
 */
export async function ensureTestDoc(api: KernelApi, notebook: string): Promise<string> {
  const rows = await api.sql(
    `SELECT id FROM blocks WHERE type='d' AND content='${TEST_DOC_TITLE}' LIMIT 20`,
  );
  // There may be more than one document with the same name (createDocWithMd duplicated them in the past), so delete them all
  for (const row of rows) {
    const id = (row as { id?: string }).id;
    if (id) await api.call('/api/filetree/removeDocByID', { id });
  }

  const r = await api.call('/api/filetree/createDocWithMd', {
    notebook,
    path: `/${TEST_DOC_TITLE}`,
    markdown: TEST_DOC_MD,
  });
  if (r.code !== 0 || !r.data) throw new Error(`failed to create the test document: ${JSON.stringify(r)}`);
  const id = r.data as string;

  // ★ Wait for the kernel to **index this document into SQL** before handing it out.
  //
  //   After SiYuan creates a document, the `blocks` table is not queryable right away (about 0.5~2s of lag as measured).
  //   And the plugin reads the **document title** through
  //   `SELECT content FROM blocks WHERE id='<docId>'` (see loadDoc in store.ts) ——
  //   while the index is not ready that query returns nothing, and the title stays an empty string **permanently** (reloading does not heal it either,
  //   because the plugin reads it only once, on mount).
  //
  //   Measured symptom: roughly a 1/3 chance that "the outline panel title bar is empty".
  //   This is not a timing illusion of a plugin bug, it is caused by **the test using a document immediately after creating it**.
  //   Waiting here is what makes the test's precondition deterministic.
  await waitUntilIndexed(api, id);
  return id;
}

/**
 * Poll until the document can be found in the `blocks` table.
 *
 * ## Why the timeout is 45 seconds (adjusted from measurement)
 *
 * It used to be 15 seconds, on the reasoning that "beyond that something is really wrong". **Measurement showed that reasoning does not hold**:
 * three documents in a row took **2.7s / 8.5s / 2.3s** to be indexed ——
 * the variation alone is large, and SiYuan occasionally does a full index rebuild, which takes even longer.
 * So 15 seconds would **occasionally** kill a good run (hit once in practice, reporting "created but not indexed",
 * which looks like the product is broken when the machine is simply slow).
 *
 * Lengthening it is not the same as papering over: what is waited on here is **the kernel's own progress**, not a hidden race.
 * When something is really wrong (the document was never created, say) the 45 seconds still reports it, with the same message.
 */
async function waitUntilIndexed(api: KernelApi, id: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await api.sql(`SELECT id FROM blocks WHERE id='${id}' LIMIT 1`);
    if (rows.length > 0) return;
    await new Promise((res) => setTimeout(res, 150));
  }
  throw new Error(`document ${id} was created but did not reach the SQL index within ${timeoutMs}ms`);
}

/**
 * Read the document's node texts **in hierarchy order**, to assert drag results.
 *
 * ## Why SQL is not queried
 *
 * `SELECT content FROM blocks WHERE parent_id='<docId>'` was tried —— it finds nothing.
 * SiYuan's structure was measured to be four levels:
 *
 * ```
 * d document block
 * └ l  list block        parent_id = document id
 *   └ i  list item       parent_id = list id
 *     └ p  paragraph block   parent_id = list item id   ← the text lives here
 * ```
 *
 * Moreover the `sort` column is **not the sibling order**, it is a "node type priority"
 * (every paragraph is 10 and every list item is 20 as measured), so sorting by it does not yield the document order.
 *
 * ## Use kramdown
 *
 * `getBlockKramdown` returns the whole document's **ordered** text for a document block, with indentation as the level ——
 * which is exactly how the plugin itself reads a document, so using it to verify the "write back" stays closest to reality.
 *
 * It returns a sequence of `{ text, depth }` (in render order); callers filter as needed.
 */
export async function docOutline(api: KernelApi, id: string): Promise<{ text: string; depth: number }[]> {
  const r = await api.call('/api/block/getBlockKramdown', { id });
  const md = String((r.data as { kramdown?: string } | null)?.kramdown ?? '');
  const out: { text: string; depth: number }[] = [];
  for (const line of md.split('\n')) {
    // Only list lines count; `{: id=...}` is SiYuan's attribute marker and is not part of the content
    const m = /^(\s*)-\s+(?:\{:.*?\}\s*)?(.*)$/.exec(line);
    if (!m) continue;
    const text = m[2].trim();
    if (!text) continue;
    out.push({ text, depth: Math.floor(m[1].length / 2) });
  }
  return out;
}

/** Only the top-level (depth 0) texts, in order. */
export async function topLevelTexts(api: KernelApi, id: string): Promise<string[]> {
  return (await docOutline(api, id)).filter((n) => n.depth === 0).map((n) => n.text);
}

/** Titles of the top-level branches in the test document (used to assert "which node is on which side"). */
export const TOP_BRANCHES = ['甲分支', '乙分支', '丙分支', '丁分支'];

/** The test notebook (the fixture one; its name is invented, never a real one). */
/**
 * The notebook used for testing.
 *
 * ★ Do not hardcode the id —— that is a **machine-specific** value and stops working on another machine (explicitly forbidden by AGENTS.md).
 * Resolution order: the `SIYUAN_TEST_NOTEBOOK` environment variable > the first open notebook.
 *
 * ⚠️ A notebook the user is actually working in **must not** be a test target ——
 * the tests really delete and modify. So by default only names that clearly mark a test purpose are picked;
 * if none is found it demands an explicit value and **does not guess**.
 */
const TEST_NOTEBOOK_ENV = process.env.SIYUAN_TEST_NOTEBOOK ?? '';

/** Only notebooks with these names are accepted as test targets (to avoid damaging user data). */
const SAFE_NOTEBOOK_NAMES = ['e2e-fixture-notebook'];

export async function resolveTestNotebook(api: KernelApi): Promise<string> {
  if (TEST_NOTEBOOK_ENV) return TEST_NOTEBOOK_ENV;

  const r = await api.call('/api/notebook/lsNotebooks', {});
  const list = ((r.data as { notebooks?: { id: string; name: string; closed?: boolean }[] } | null)?.notebooks) ?? [];
  const open = list.filter((n) => !n.closed);
  const safe = open.find((n) => SAFE_NOTEBOOK_NAMES.includes(n.name));
  if (safe) return safe.id;

  throw new Error(
    `No usable test notebook found. Currently open: ${open.map((n) => `${n.name}(${n.id})`).join(', ') || '(none)'}\n` +
      `pass SIYUAN_TEST_NOTEBOOK=<id> to explicitly name a notebook that is **free to be modified** —— ` +
      `the tests really create and delete documents, so do not point it at one you are working in.`,
  );
}

/**
 * Create a temp document that is **deleted once it has been used**.
 *
 * Keyboard shortcuts and the context menu **really modify the document** (add nodes, delete nodes, edit text).
 * Testing against the shared test document pollutes it on every run and breaks the next assertion.
 * So every test that writes runs against its own temp document and deletes it in `afterEach`.
 */
export async function createTempDoc(api: KernelApi, notebook: string, markdown: string): Promise<string> {
  const title = `E2E-临时-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const r = await api.call('/api/filetree/createDocWithMd', {
    notebook,
    path: `/${title}`,
    markdown,
  });
  if (r.code !== 0 || !r.data) throw new Error(`failed to create the temp document: ${JSON.stringify(r)}`);
  const id = r.data as string;
  await waitUntilIndexed(api, id); // same as ensureTestDoc: opening it right away would miss the title
  return id;
}

/** Delete a document (using removeDocByID; the old removeDoc makes the kernel panic). */
export async function removeDoc(api: KernelApi, id: string): Promise<void> {
  await api.call('/api/filetree/removeDocByID', { id });
}

/** Initial content of a temp document: a root + 2 branches, enough to test add/delete/edit. */
export const TEMP_DOC_MD = `- 甲
  - 甲一
- 乙
  - 乙一
`;

/**
 * A document with XML special characters —— for the export escaping test only.
 *
 * `&` `<` `>` `"` must be escaped inside FreeMind's `TEXT="..."`,
 * otherwise the exported `.mm` is **broken XML** and other tools cannot open it at all.
 * Testing with ordinary Chinese does not catch it (no special characters, so escaping changes nothing) ——
 * that is how the first mutation-testing run slipped past.
 */
export const SPECIAL_DOC_MD = `- SVR<alpha> & 阈值
  - x > 10 & y < 20
  - 引号 "测试"
- 正常分支
  - 普通子节点
`;

/** The "&" should appear in the export, but as the escaped `&amp;`. */
export const SPECIAL_TOP = 'SVR<alpha> & 阈值';
