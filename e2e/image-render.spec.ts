/**
 * ★★★ An image in an attached paragraph must actually **load**, not merely be present.
 *
 * ## The defect this covers (D20)
 *
 * `![图](assets/x.png)` came back from the kernel as `<img data-img="assets/x.png">` — and `data-img`
 * is **not `src`**, so nothing was ever fetched. Measured on the isolated instance before the fix:
 *
 * ```
 * {"src": null, "dataImg": "assets/E2E-probe-image.png", "natural": "0x0", "rect": "28x17"}
 * ```
 *
 * An empty 28x17 box where the picture should be, with the same markup in a **node's own text**
 * displaying correctly. The cause was one missing call: the `.node-para` ref callbacks in
 * `Outliner.tsx` set `innerHTML` and never called `hydrateEditable`, while every `.node-text` one
 * does — so images in **attached paragraphs** were the only ones affected.
 *
 * After the fix the same measurement reads `{"src": "assets/E2E-probe-image.png", "natural": "2x2"}`.
 *
 * ## Why the criterion is `naturalWidth`, not "an `<img>` exists"
 *
 * Presence is exactly what was already true while the user saw an empty box: the element, its
 * `data-img` and its `alt` were all there. `naturalWidth > 0` is the one property that distinguishes
 * "the browser fetched and decoded this" from "there is an element of that name", and it cannot be
 * satisfied by markup alone.
 *
 * `src` is asserted beside it because a future rewrite could set `src` to something that 404s, which
 * would leave `naturalWidth` at 0 — the pair is what pins the defect.
 */
import { test, expect, type Page } from './fixtures';
import { openDoc, toOutlineView, toMindmapView } from './mindmap';
import { waitForStableOutline } from './outline';
import { kernelApi, createTempDoc, removeDoc, resolveTestNotebook, type KernelApi } from './testdoc';
import { siyuanUrl, siyuanToken } from './env';

let notebook = '';

/** A 2x2 PNG. Its natural size is the assertion, so it must not be a 1x1 or a placeholder. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4EIwDiqkL4KAc0gA/1EnM0AAAAASUVORK5CYII=';
const ASSET = 'assets/E2E-image-render.png';

test.beforeAll(async () => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  try {
    notebook = await resolveTestNotebook(api);
  } finally {
    await api.dispose();
  }
});

/** Put the PNG into the workspace's assets, through the endpoint the plugin itself uses. */
async function uploadAsset(page: Page): Promise<void> {
  const status = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const fd = new FormData();
    // ★ `data/assets/`, not `assets/`: the latter answers `code: 0` and lands where SiYuan does not
    //   look (the trap recorded in `uploadAsset`'s own comment).
    fd.append('path', 'data/assets/E2E-image-render.png');
    fd.append('isDir', 'false');
    fd.append('file', new Blob([bytes], { type: 'image/png' }), 'E2E-image-render.png');
    const r = await fetch('/api/file/putFile', { method: 'POST', body: fd });
    return String(r.status);
  }, PNG_B64);
  expect(status, 'precondition: the asset upload answered 200').toBe('200');
}

/** Every image under `root`, with what the browser really did with it. */
function imagesUnder(page: Page, root: string): Promise<Array<{ src: string; natural: string }>> {
  return page.evaluate((sel) => {
    return Array.from(document.querySelectorAll(`${sel} img`)).map((el) => {
      const e = el as HTMLImageElement;
      return { src: e.getAttribute('src') ?? '', natural: `${e.naturalWidth}x${e.naturalHeight}` };
    });
  }, root);
}

/** A document whose first node carries the image as an **attached paragraph**. */
async function docWithImageParagraph(api: KernelApi): Promise<string> {
  const docId = await createTempDoc(api, notebook, '- 甲\n- 乙\n');
  const r = await api.call('/api/block/updateBlock', {
    id: docId,
    dataType: 'markdown',
    // The blank line is what makes this an attached paragraph rather than part of the node's text.
    data: `- 甲\n\n  ![图](${ASSET})\n- 乙\n`,
  });
  expect((r.data as unknown[] | null) ?? [], 'precondition: the image paragraph was written').toBeTruthy();
  return docId;
}

test('★★★ an image in an attached paragraph loads, in both views', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    docId = await docWithImageParagraph(api);
    await openDoc(page, docId);
    await toOutlineView(page);
    await waitForStableOutline(page);
    await uploadAsset(page);
    // The outline hydrates on render, so a re-open is what makes the new asset resolvable.
    await openDoc(page, docId);
    await toOutlineView(page);
    await waitForStableOutline(page);

    // ── The outline: the paragraph box must show the picture ──
    const para = '.om-outline-wrap .node-para';
    await expect(page.locator(para).first(), 'the attached paragraph must be rendered').toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(async () => (await imagesUnder(page, para))[0]?.natural ?? 'absent', {
        message: 'the outline must really load the paragraph image (naturalWidth > 0)',
        timeout: 20_000,
      })
      .toBe('2x2');
    expect((await imagesUnder(page, para))[0].src, 'and the src must point at the asset').toContain(
      'E2E-image-render.png',
    );

    // ── The mind map: the paragraph overlay must show it too ──
    await toMindmapView(page);
    await expect(page.locator('.mm-node').first()).toBeVisible({ timeout: 30_000 });
    const badge = page.locator('.mm-para-badge').first();
    await expect(badge, 'the node must offer the paragraph badge').toBeAttached({ timeout: 20_000 });
    await page.locator('.mm-node').first().hover();
    await badge.click({ force: true });
    await expect(page.locator('.mm-para-overlay')).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => (await imagesUnder(page, '.mm-para-overlay'))[0]?.natural ?? 'absent', {
        message: 'the mind map overlay must load the paragraph image',
        timeout: 20_000,
      })
      .toBe('2x2');
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});

test('★★★ the image survives a write-back instead of being lost', async ({ page }) => {
  const api = await kernelApi(siyuanUrl(), siyuanToken());
  let docId = '';
  try {
    docId = await docWithImageParagraph(api);
    await openDoc(page, docId);
    await toOutlineView(page);
    await waitForStableOutline(page);
    await uploadAsset(page);
    await openDoc(page, docId);
    await toOutlineView(page);
    await waitForStableOutline(page);

    // Edit the **node's own text**, so the whole tree goes through the write path while the image
    // sits in its attached paragraph.
    const target = page.locator('.om-outline-wrap .node-text').filter({ hasText: '乙' }).first();
    await target.click();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.className ?? ''), {
        message: 'the node text box must hold the caret before typing',
        timeout: 10_000,
      })
      .toContain('node-text');
    await page.keyboard.press('End');
    await page.keyboard.type('丙');

    const kramdown = async (): Promise<string> => {
      const r = await api.call('/api/block/getBlockKramdown', { id: docId });
      return String((r.data as { kramdown?: string })?.kramdown ?? '');
    };
    await expect
      .poll(kramdown, { message: 'the node edit must reach the document', timeout: 25_000 })
      .toContain('乙丙');

    // ★ The criterion: the image is **still referenced** after a full write-back. A write-back that
    //   dropped it would leave `![](… )` gone or emptied, and the reload below would show a blank.
    expect(await kramdown(), 'the image reference must survive a write-back').toContain(ASSET);
    expect(await kramdown(), 'and it must not have been turned into protyle-html').not.toContain(
      '<protyle-html',
    );
    await expect
      .poll(async () => ((await kramdown()).match(/!\[[^\]]*\]\(([^)]*)\)/) ?? [])[1] ?? '', {
        message: 'the image path must not be emptied out',
        timeout: 20_000,
      })
      .toBe(ASSET);
  } finally {
    if (docId) await removeDoc(api, docId);
    await api.dispose();
  }
});
