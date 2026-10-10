import { test, expect } from './fixtures';
import { siyuanUrl, siyuanToken } from './env';
import {
  openDoc, toMindmapView, clickBarButton, setStructure, revealInBar,
  clickBadgeOn, firstBadgeOwner,
} from './mindmap';
import {
  kernelApi, ensureTestDoc, resolveTestNotebook, createTempDoc, removeDoc,
  TOP_BRANCHES, SPECIAL_DOC_MD, type KernelApi,
} from './testdoc';

/**
 * E2E for export.
 *
 * ## Why it gets a file of its own
 *
 * The export is the **deliverable**: what the user takes away is that file, not the screen.
 * If the UI renders correctly but the export is wrong, what the user sees is still wrong —— and they only find out **after leaving the app**
 * (the image gets pasted into a PPT deck, the `.mm` gets dragged into another tool), by which time it can no longer be traced back.
 *
 * The old coverage stopped at "the PNG is a valid image and not a solid color",
 * which means: **exporting an image unrelated to the screen would still pass.**
 * This file adds "the exported content really reflects this mind map".
 *
 * ## What it captures is a real download
 *
 * It takes the **file written to disk** from Playwright's download event and does not hijack internal functions ——
 * hijacking would only prove "it was called", not "the file the user gets is right".
 * File name, byte count and byte content are all asserted against the real artifact.
 */

let api: KernelApi;
let DOC = '';
let notebook = '';

test.beforeAll(async () => {
  const baseURL = siyuanUrl();
  const token = siyuanToken();
  api = await kernelApi(baseURL, token);
  notebook = await resolveTestNotebook(api);
  DOC = await ensureTestDoc(api, notebook);
});

test.afterAll(async () => {
  await api.dispose();
});

/** Click an export button, wait for the download to really land on disk, then read the bytes back. */
async function exportAndRead(
  page: Parameters<typeof openDoc>[0],
  label: string,
): Promise<{ name: string; buf: Buffer }> {
  const btn = await revealInBar(page, label);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    btn.click({ timeout: 10_000 }),
  ]);
  const path = await download.path();
  expect(path, `${label} should really have produced a file`).toBeTruthy();
  const fs = await import('node:fs');
  return { name: download.suggestedFilename(), buf: fs.readFileSync(path as string) };
}

test.beforeEach(async ({ page }) => {
  await openDoc(page, DOC);
  await toMindmapView(page);
});

/**
 * ★ The exported PNG size should **follow the mind map content**, not be a hardcoded size.
 *
 * "Exporting a blank image at a fixed size" is the most typical way this kind of feature breaks ——
 * and asserting only "it is a valid PNG" will never catch it.
 */
test('the exported PNG size follows the content', async ({ page }) => {
  const png1 = await exportAndRead(page, '导出图片');
  const w1 = png1.buf.readUInt32BE(16);
  const h1 = png1.buf.readUInt32BE(20);
  expect(w1, 'the PNG width should be positive').toBeGreaterThan(0);
  expect(h1, 'the PNG height should be positive').toBeGreaterThan(0);

  // Switch to "Down": the tree gets taller and narrower, so the export size has to change with it
  await setStructure(page, 'org');
  await page.waitForTimeout(800);
  const png2 = await exportAndRead(page, '导出图片');
  const w2 = png2.buf.readUInt32BE(16);
  const h2 = png2.buf.readUInt32BE(20);

  expect(
    w1 !== w2 || h1 !== h2,
    `the export size should change after switching the structure (Right ${w1}x${h1} → Down ${w2}x${h2})`,
  ).toBe(true);
});

/** The exported PNG file name comes from the document title —— the user relies on it to tell which image this is. */
test('the exported PNG is named after the document title', async ({ page }) => {
  const png = await exportAndRead(page, '导出图片');
  expect(png.name, 'the file name should be "<document title>.png"').toBe('E2E-导图结构测试.png');
});

/**
 * ★ The `.mm` must contain **every node of the current mind map**.
 *
 * This was never tested at all before. The `.mm` is consumed by other tools, so a missing node is not something the user notices right away.
 */
test('the exported .mm contains every node and its structure matches the document', async ({ page }) => {
  const mm = await exportAndRead(page, '导出 .mm');
  const xml = mm.buf.toString('utf8');

  expect(mm.name, '.mm file name should be "<document title>.mm"').toBe('E2E-导图结构测试.mm');
  expect(xml, 'it should be FreeMind format').toContain('<map version="1.0.1">');
  expect(xml, 'the XML should be closed').toContain('</map>');

  // All four top-level branches are present
  for (const branch of TOP_BRANCHES) {
    expect(xml, `"${branch}" should be in the export`).toContain(`TEXT="${branch}"`);
  }
  // The child nodes are there too (the top level alone does not count as "every node")
  for (const child of ['甲一', '甲二', '乙一', '乙二', '丙一', '丙二', '丁一', '丁二']) {
    expect(xml, `"${child}" should be in the export`).toContain(`TEXT="${child}"`);
  }
});

/**
 * ★ After collapsing: the PNG gets **smaller**, while the `.mm` is still **complete data**.
 *
 * ## This one was written wrong at first; note why
 *
 * The first version asserted "after collapsing, the `.mm` should no longer contain the child nodes", and it went red.
 * Reading the implementation: `exportFreemind(nodes, title)` walks the **whole node tree**,
 * and knows nothing about `collapsedIds` (which is fed only to the layout).
 *
 * This is not a bug, it is that the **two exports have different purposes**:
 *
 * | Export | Semantics | After collapsing |
 * |---|---|---|
 * | PNG | WYSIWYG —— it clones **the SVG on screen** | gets smaller |
 * | `.mm` | a data interchange format —— fed to other mind map tools | still the whole tree |
 *
 * Measured corroboration: collapsing one branch takes the canvas from 13 to 11 nodes,
 * the PNG size goes 1200×980 → 1200×884 (smaller), while the `.mm` bytes stay the same.
 *
 * The assertions now pin down **that distinction**: which one changes and which one does not, both explicitly.
 * Otherwise, if someone later makes the `.mm` export only what is visible, or the PNG stops following collapsing,
 * neither would be noticed.
 */
test('after collapsing the PNG shrinks but the .mm is still the whole tree', async ({ page }) => {
  const pngBefore = await exportAndRead(page, '导出图片');
  const mmBefore = (await exportAndRead(page, '导出 .mm')).buf.toString('utf8');
  const nodesBefore = await page.locator('.mm-node').count();

  expect(mmBefore, 'precondition: the .mm has child nodes while expanded').toContain('TEXT="甲一"');

  // Collapse the first branch.
  // ★ You cannot just `click('.mm-badge')` —— the badge is **covered** by the node's own rect,
  //   Playwright decides the click is intercepted and retries until it times out (2.1 minutes as measured).
  //   You have to hover the owning node first (only hovering reveals the badge), which is exactly `clickBadgeOn`.
  const owner = await firstBadgeOwner(page);
  expect(owner, 'precondition: there should be a node with a collapse button').toBeGreaterThanOrEqual(0);
  await clickBadgeOn(page, owner);

  // ① The canvas really lost nodes (confirm the collapse took effect first, otherwise the assertions below are meaningless)
  const nodesAfter = await page.locator('.mm-node').count();
  expect(nodesAfter, 'the canvas should have fewer nodes after collapsing').toBeLessThan(nodesBefore);

  // ② The PNG shrinks with it
  const pngAfter = await exportAndRead(page, '导出图片');
  const sizeBefore = `${pngBefore.buf.readUInt32BE(16)}x${pngBefore.buf.readUInt32BE(20)}`;
  const sizeAfter = `${pngAfter.buf.readUInt32BE(16)}x${pngAfter.buf.readUInt32BE(20)}`;
  expect(
    sizeBefore !== sizeAfter || pngBefore.buf.length !== pngAfter.buf.length,
    `the PNG should shrink with the collapse (${sizeBefore}/${pngBefore.buf.length}B → ${sizeAfter}/${pngAfter.buf.length}B)`,
  ).toBe(true);

  // ③ The `.mm` **stays the same** —— it is a data snapshot, not a screenshot
  const mmAfter = (await exportAndRead(page, '导出 .mm')).buf.toString('utf8');
  expect(mmAfter, 'collapsing should not affect the .mm: its purpose is data interchange, not WYSIWYG').toBe(mmBefore);
  expect(mmAfter, 'the collapsed subtree should still be complete in the .mm').toContain('TEXT="甲一"');
});

/**
 * ★ In the exported SVG the collapse button's "−" circle must be **hidden**.
 *
 * How this differs from the test in `mindmap.spec.ts`: that one verifies "the fix is still there"
 * (styles inlined, om-mm-host present), while this one verifies the **result**
 * —— it really renders the exported SVG and counts pixels, looking for an extra filled circle.
 *
 * Comparing exported PNGs pixel by pixel was tried before and did not catch it (the difference is only 0.275%).
 * This uses a more direct criterion instead: **render the exported SVG and measure the badge's actual opacity**.
 */
test('the collapse circle is invisible when the exported SVG is rendered', async ({ page }) => {
  // Capture the SVG that gets serialized during export (no hijacking of the export logic itself, only listening in on the serialization)
  await page.evaluate(() => {
    (window as unknown as { __svg?: string }).__svg = undefined;
    const orig = XMLSerializer.prototype.serializeToString;
    XMLSerializer.prototype.serializeToString = function (node: Node) {
      const out = orig.call(this, node);
      if (out.startsWith('<svg')) (window as unknown as { __svg?: string }).__svg = out;
      return out;
    };
  });

  await clickBarButton(page, '导出图片');
  await page.waitForTimeout(1500);

  const svg = await page.evaluate(() => (window as unknown as { __svg?: string }).__svg);
  expect(svg, 'the exported SVG should have been captured').toBeTruthy();

  // ★ The key point: render this SVG **as a standalone document**, then measure the badge's computed style.
  //   Measuring inside the page is useless —— the page has a `.om-mm-host` ancestor, so the style of course looks right;
  //   the exported file is a **standalone document**, and with no om-mm-host at the root it gives itself away (which is exactly the original defect).
  const opacity = await page.evaluate((markup: string) => {
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-9999px;top:0;width:1200px;height:980px';
    holder.innerHTML = markup;
    document.body.appendChild(holder);
    const badge = holder.querySelector('.mm-badge');
    const v = badge ? getComputedStyle(badge).opacity : 'missing';
    holder.remove();
    return v;
  }, svg as string);

  expect(opacity, 'the collapse circle opacity in the exported SVG should be 0 (invisible)').toBe('0');
});

/**
 * ★ Exporting the same tree twice should give nearly identical bytes (deterministic content).
 *
 * A non-deterministic export breaks the "export → something goes wrong → export again and compare" way of investigating.
 * A little variation is allowed (timestamps and the like), but not most of the file every time.
 */
test('two exports of the same mind map produce identical .mm content', async ({ page }) => {
  const a = (await exportAndRead(page, '导出 .mm')).buf.toString('utf8');
  const b = (await exportAndRead(page, '导出 .mm')).buf.toString('utf8');
  expect(b, 'two exports of the same state should be exactly identical').toBe(a);
});

/**
 * ★ XML special characters in node text must be escaped, otherwise the exported `.mm` is **broken XML**.
 *
 * ## Why a test of its own
 *
 * The test document used by the "`.mm` contains every node" test is entirely Chinese and has **no special characters at all** ——
 * so replacing `esc()` with the identity function still left it green (surfaced by mutation testing).
 * which means the escaping feature was **not tested at all**.
 *
 * And if it breaks, the consequence is **a file that will not open**: the user takes the `.mm` to another mind map tool
 * and gets an XML parse error on import, with nothing pointing to our export as the cause.
 */
test('XML special characters in nodes are escaped', async ({ page }) => {
  const tempId = await createTempDoc(api, notebook, SPECIAL_DOC_MD);
  try {
    await openDoc(page, tempId);
    await toMindmapView(page);
    await page.waitForTimeout(800);

    const mm = await exportAndRead(page, '导出 .mm');
    const xml = mm.buf.toString('utf8');

    // ① Dangerous characters must not appear **bare** in an attribute value
    expect(xml, 'a bare `<alpha>` should not appear in a TEXT attribute').not.toContain('TEXT="SVR<alpha>');
    expect(xml, '`&` must be escaped as &amp;').toContain('&amp;');
    expect(xml, '`<` must be escaped as &lt;').toContain('&lt;');
    expect(xml, '`>` must be escaped as &gt;').toContain('&gt;');

    // ② And the export really is **well-formed XML** —— let the browser parse it
    const ok = await page.evaluate((markup: string) => {
      const doc = new DOMParser().parseFromString(markup, 'application/xml');
      const err = doc.querySelector('parsererror');
      if (err) return `parse failed: ${err.textContent?.slice(0, 120)}`;
      return 'ok';
    }, xml);
    expect(ok, 'the exported .mm should be well-formed XML').toBe('ok');

    // ③ Once parsed back, the node text should be restored to the **original** (escaping must not lose content)
    const texts = await page.evaluate((markup: string) => {
      const doc = new DOMParser().parseFromString(markup, 'application/xml');
      return [...doc.querySelectorAll('node')].map((n) => n.getAttribute('TEXT'));
    }, xml);
    expect(texts, 'parsing it back should restore the original text').toContain('SVR<alpha> & 阈值');
    expect(texts, 'a child node containing < > & should be restored too').toContain('x > 10 & y < 20');
    expect(texts, 'the quoted node should be restored').toContain('引号 "测试"');
  } finally {
    await removeDoc(api, tempId);
  }
});
