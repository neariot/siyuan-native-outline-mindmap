import { test, expect } from './fixtures';
import { openDoc, toMindmapView, toOutlineView, mindmapState, ensureOutlineToolbarOpen } from './mindmap';
import { outlineState, firstParentBullet, selectedTexts } from './outline';
import { siyuanUrl, siyuanToken } from './env';
import {
  kernelApi, ensureTestDoc, createTempDoc, removeDoc,
  resolveTestNotebook, TOP_BRANCHES, TEMP_DOC_MD,
} from './testdoc';

/**
 * E2E for the outline view.
 *
 * ## Why its own suite
 *
 * Of the previous 36 cases, the vast majority hit the mind map view, and the outline was only touched in passing by the "switch view" one.
 * Yet the outline is the plugin's **main view** (it is where you land by default), and none of its own interactions were ever verified.
 *
 * ## The division of labor as measured (probe first, then write the assertion)
 *
 * | Interaction | Real effect |
 * |---|---|
 * | Clicking the **bullet** | **Zooms** into that node's subtree (12 rows → 3 rows), a breadcrumb appears |
 * | Clicking the **sidebar arrow** | **Collapses** (12 rows → 10 rows, with `.collapsed`), breadcrumb unchanged |
 *
 * The two are easy to confuse: both show up as "fewer rows". They are deliberately each other's control group here ——
 * the bullet must not produce `.collapsed`, the arrow must not produce a breadcrumb.
 */

let DOC = '';
let notebook = '';

test.beforeAll(async () => {
  const baseURL = siyuanUrl();
  const token = siyuanToken();
  const api = await kernelApi(baseURL, token);
  try {
    notebook = await resolveTestNotebook(api);
    DOC = await ensureTestDoc(api, notebook);
  } finally {
    await api.dispose();
  }
});

test.beforeEach(async ({ page }) => {
  await openDoc(page, DOC);
  await toOutlineView(page);
});

test('the outline view renders rows matching the document', async ({ page }) => {
  // ★ The title is filled in **asynchronously** (document metadata waits on one kernel round trip).
  //   Reading it directly occasionally returns an empty string —— failing in a mixed run and passing alone is exactly this kind of timing problem.
  //   Wait for it to appear first, then assert the content.
  await expect
    .poll(async () => (await outlineState(page)).title, {
      message: 'the document title should be filled in',
      timeout: 10_000,
      intervals: [200, 400, 800],
    })
    .toContain('E2E');

  const s = await outlineState(page);
  expect(s.rows, 'rows should be rendered').toBeGreaterThan(0);

  // All 4 top-level branches of the test document should be present
  const texts = await page.locator('.node-text').allTextContents();
  const joined = texts.join('|');
  for (const b of TOP_BRANCHES) {
    expect(joined, `the outline should contain "${b}"`).toContain(b);
  }
});

/** ★ Clicking the bullet **zooms** into the subtree, it does not collapse. */
test('clicking the bullet zooms into the subtree and shows a breadcrumb', async ({ page }) => {
  const before = await outlineState(page);
  const idx = await firstParentBullet(page);
  expect(idx, 'a bullet with children should exist').toBeGreaterThanOrEqual(0);

  await page.locator('.om-bullet').nth(idx).locator('.bullet-dot, .dot').click();
  await page.waitForTimeout(700);

  const after = await outlineState(page);
  expect(after.rows, 'the row count should decrease after zooming').toBeLessThan(before.rows);
  expect(after.crumbs.length, 'a breadcrumb should appear after zooming').toBeGreaterThan(0);
  expect(after.hasBack, 'the breadcrumb should contain a back button').toBe(true);
  // Control group: zooming must not change the collapsed state.
  //
  // ★★★ **Both directions** must be asserted.
  //
  //   The original wording was `expect(after.collapsed).toBe(before.collapsed)` ——
  //   but here before/after are **always 0** (measured: 0 initially, 0 after zooming).
  //   So the assertion became `0 === 0`, **always true**, with no defensive value at all.
  //
  //   Verified by injection: adding "give the row a collapsed marker whenever there is a breadcrumb" to the Outliner
  //   still left this case **green**.
  //
  //   ⇒ First make sure the baseline is 0, then assert the result is **also** 0. Only a broken product turns it red.
  expect(before.collapsed, 'precondition: there should be no collapse marker before zooming in').toBe(0);
  expect(
    after.collapsed,
    `zooming **must not** produce a collapse marker (that is the sidebar arrow's job), measured ${after.collapsed}`,
  ).toBe(0);
});

/** ★ The breadcrumb's back button restores the whole tree. */
test('the breadcrumb back button restores the whole tree', async ({ page }) => {
  const before = await outlineState(page);
  const idx = await firstParentBullet(page);

  await page.locator('.om-bullet').nth(idx).locator('.bullet-dot, .dot').click();
  await page.waitForTimeout(700);
  expect(await outlineState(page).then((s) => s.rows)).toBeLessThan(before.rows);

  await page.locator('.crumb-back-btn').first().click();
  await page.waitForTimeout(700);

  const after = await outlineState(page);
  expect(after.rows, 'the row count should be restored after going back').toBe(before.rows);
  expect(after.hasBack, 'the back button should be gone at the top level').toBe(false);
});

/** ★ The sidebar arrow **collapses**, it does not zoom. */
test('the sidebar arrow collapses and expands again', async ({ page }) => {
  const before = await outlineState(page);
  const arrow = page.locator('.node-sidebar-arrow, .outliner-node-sidebar').first();
  await expect(arrow, 'a sidebar arrow should exist').toBeVisible();

  await arrow.click();
  await page.waitForTimeout(700);

  const collapsed = await outlineState(page);
  expect(collapsed.collapsed, 'the arrow should produce one collapse marker').toBe(1);
  expect(collapsed.rows, 'the row count should decrease after collapsing').toBeLessThan(before.rows);
  // Control group: collapsing must not produce a breadcrumb.
  // ★ Same as above: `before.crumbs.length` is always 0, so the original wording `0 === 0` was always true.
  expect(before.crumbs.length, 'precondition: there should be no breadcrumb before collapsing').toBe(0);
  expect(
    collapsed.crumbs.length,
    `collapsing **must not** produce a breadcrumb (that is the bullet's job), measured ${collapsed.crumbs.length}`,
  ).toBe(0);

  await arrow.click();
  await page.waitForTimeout(700);
  const restored = await outlineState(page);
  expect(restored.collapsed, 'clicking again should expand it').toBe(0);
  expect(restored.rows, 'the row count should be restored').toBe(before.rows);
});

/**
 * ★ Typing after clicking a node text must land in **that one** node.
 *
 * ## Probe first, then write the assertion
 *
 * Note: the outline is **permanently editable**
 * (all 12 `.node-text` elements are `contenteditable="true"` from the start),
 * unlike the mind map where "the input box only appears on F2". So the `editing` value is not a criterion for edit state at all.
 *
 * A second version tried asserting the `.focused` class —— also wrong. Measured: after clicking the text `.focused` stays at 0.
 *
 * The really reliable criterion is **the behavior itself**: focus lands on `.node-text`, and the characters typed
 * appear in the correct node. That is also closer to what the user sees.
 */
test('typing after clicking a node text lands the characters in that node', async ({ page }) => {
  const idx = 1;
  const target = page.locator('.node-text').nth(idx);
  const before = (await target.textContent()) ?? '';

  await target.click();
  await page.waitForTimeout(300);
  const active = await page.evaluate(() =>
    document.activeElement ? (document.activeElement.className || '').toString() : '',
  );
  expect(active, 'focus should land on .node-text').toContain('node-text');

  const marker = 'Z';
  await page.keyboard.type(marker);
  await page.waitForTimeout(500);

  const after = (await target.textContent()) ?? '';
  expect(after, `the node text should become "${before}${marker}"`).toBe(before + marker);
  // The other nodes must not be affected
  const others = await page.locator('.node-text').allTextContents();
  expect(others.filter((t) => t.includes(marker)).length, 'only that one node should change').toBe(1);

  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
});

/**
 * ★ Verify on a **temporary document** that "characters edited in the outline are written back to SiYuan".
 *
 * The case above only proves the UI changed. This one proves the **data really was persisted**:
 * after the edit, wait for the write-back to finish, then ask the kernel directly for this node's text.
 *
 * A temporary document is used because this is a destructive operation and must not pollute the shared test document.
 */
test('characters edited in the outline are written back to SiYuan', async ({ page }) => {
  const baseURL = siyuanUrl();
  const token = siyuanToken();
  const api = await kernelApi(baseURL, token);
  let tempId = '';
  try {
    tempId = await createTempDoc(api, notebook || (await resolveTestNotebook(api)), TEMP_DOC_MD);
    await openDoc(page, tempId);
    await toOutlineView(page);

    const marker = '节点五';
    const target = page.locator('.node-text').nth(1);
    await target.click();
    await page.waitForTimeout(300);
    await page.keyboard.press('End');
    await page.keyboard.type(marker);

    // ★ Poll instead of sleeping for a fixed duration: the write-back has debounce + a kernel round trip,
    //   measured to arrive within 1 second when fast, while a fixed 2.5 seconds is not enough when slow
    //   (passing alone and failing in a mixed run is exactly this kind of timing problem).
    await expect
      .poll(
        async () => {
          const rows = await api.sql(
            `SELECT content FROM blocks WHERE type = 'p' AND content LIKE '%${marker}%' LIMIT 5`,
          );
          return rows.length;
        },
        { message: `SiYuan should have a paragraph containing "${marker}"`, timeout: 15_000, intervals: [300, 500, 1000, 2000] },
      )
      .toBeGreaterThan(0);
  } finally {
    if (tempId) await removeDoc(api, tempId);
    await api.dispose();
  }
});

/**
 * ★ Cross-view consistency: the outline's row count and the mind map's node count should line up.
 *
 * The two views read the same tree. This case specifically watches for "one view under- or over-renders" ——
 * the most likely mistake when switching views, and one you cannot spot by looking at a single view.
 */
test('the outline row count matches the mind map node count', async ({ page }) => {
  const outline = await outlineState(page);

  await toMindmapView(page);
  const mm = await mindmapState(page);

  // The mind map's root node corresponds to the "document title" and is not an outline row, hence the difference of 1
  expect(
    mm.nodes,
    `the mind map node count (${mm.nodes}) should be 1 more than the outline row count (${outline.rows}) (the extra one is the root node)`,
  ).toBe(outline.rows + 1);

  // Switching back should still give the outline
  await toOutlineView(page);
  expect(await outlineState(page).then((s) => s.rows), 'the row count should be unchanged after switching back').toBe(outline.rows);
});

/**
 * ★ Empty document: it offers a **clickable placeholder row**, and the panel must follow once content is added in the body.
 *
 * ## Why this case is mandatory
 *
 * The original bug report: "after creating a notebook / creating a document, it keeps saying this document has no content".
 *
 * The fix at the time was "empty document shows a notice → the notice disappears once the body has content".
 *  It was changed to a **better shape**:
 * an empty document no longer blocks with a page of notice, it directly offers one editable placeholder row
 * ("Click or press Enter to start typing..."); clicking it starts building from zero ——
 * an empty document and "has content but only one row" are the same thing interaction-wise, with one less switch.
 *
 * ⇒ So this case now guards two things:
 *     ① empty document → there is a placeholder row and **no** notice page;
 *     ② adding a list item in the body → the panel really follows (the line of defense for that original real bug).
 *
 * ## Why the criterion is a "list item" rather than a "bare paragraph"
 *
 * The outline **only takes list items** (document block → list block → list item → paragraph block).
 * A bare paragraph never enters the outline tree, so adding one produces no row —— that is by design,
 * not a bug. So this case must type a list item with the `- ` syntax;
 * using a bare paragraph would give an **always-green** fake test.
 *
 * ## ★ Why `.node-row-empty` must be excluded
 *
 * The placeholder row **reuses the `.node-row` class name** (to inherit the row-height/indent layout).
 * So when "counting rows" without excluding it, an empty document counts as 1 too ——
 * criteria like "an empty document should have no rows" would silently reach a wrong conclusion.
 * Counting real nodes always uses `.node-row:not(.node-row-empty)`.
 */
test('★ Empty document: a clickable placeholder row; the panel follows once a list item is added in the body', async ({ page }) => {
  const baseURL = siyuanUrl();
  const token = siyuanToken();
  const api = await kernelApi(baseURL, token);
  let tempId = '';
  try {
    // An empty document —— exactly the reported scenario
    tempId = await createTempDoc(api, notebook || (await resolveTestNotebook(api)), '');
    await openDoc(page, tempId);
    await toOutlineView(page);

    // ① An empty document should show a **clickable placeholder row** (this is by design, do not "fix" it as a bug)
    const placeholder = page.locator('.node-row-empty').last();
    await expect(placeholder).toBeVisible({ timeout: 15_000 });
    // ★ A stable fragment, not the whole sentence. The wording of the placeholder is a catalogue value
    //   (`lblEmptyClickToStart`) and belongs to the i18n gate; a spec that pins the sentence goes stale
    //   the moment the wording is improved, and it did (it expected the previous wording and could not
    //   have passed since). What this case is about is that the row is **there and clickable**.
    await expect(placeholder).toContainText(/按 Enter 开始输入/);
    // And the notice page should **not** be there any more (removed by the new design)
    expect(
      await page.locator('.om-mm-empty__title').count(),
      'an empty document no longer shows the notice page, it offers the placeholder row directly',
    ).toBe(0);
    // The placeholder row is not a real node
    expect(
      await page.locator('.node-row:not(.node-row-empty)').count(),
      'an empty document should have no real node rows',
    ).toBe(0);

    // ② Type a **list item** in the SiYuan body (not a bare paragraph —— a bare paragraph does not enter the outline)
    await page.locator('.protyle-wysiwyg').first().click();
    await page.waitForTimeout(300);
    await page.keyboard.type('- 项一');

    // ③ The panel must follow.
    //    Poll instead of sleeping for a fixed duration: reverse sync has debounce + a kernel round trip.
    //    ★ Count "real rows": while the placeholder row is still there, counting it would misjudge as "it already appeared".
    await expect
      .poll(async () => page.locator('.node-row:not(.node-row-empty)').count(), {
        message: 'a list item was added in the body, so the panel should grow real nodes out of the placeholder row',
        timeout: 20_000,
      })
      .toBeGreaterThan(0);

    // ④ And it has to be **that row**, not just any row that showed up
    await expect(page.locator('.node-text').first()).toContainText('项一', {
      timeout: 10_000,
    });
    // ⑤ The placeholder row should be gone —— "placeholder row + real row" must not both hang there.
    //    ★ This one has real discriminating power: if the product did not update displayedNodes,
    //      the placeholder row would stay and this would turn red (when changing the implementation, verify it can go red).
    await expect
      .poll(async () => page.locator('.node-row-empty').count(), {
        message: 'there are real nodes now, so the placeholder row should disappear',
        timeout: 10_000,
      })
      .toBe(0);
  } finally {
    if (tempId) await removeDoc(api, tempId).catch(() => {});
    await api.dispose();
  }
});

/**
 * ★★★ The case above **only proves "one row appeared"**, while the product got stuck at exactly "row 1".
 *
 * Measured:
 *   create a document → sidebar plugin → type 5 list items in a row in the body
 *   → the panel **stays at 1 forever**, only a page refresh turns it into 5.
 *
 * Root cause: the reverse sync's "re-read the whole document" criterion was written as "the current tree is empty".
 *   As soon as the panel has 1 node the criterion no longer holds → it falls back to the incremental path →
 *   and the incremental path relies on `blockToNodeRef` (built during the last loadDoc, it only knows block 1)
 *   → everything from the 2nd item on is not found → **silently dropped**.
 *
 * ⇒ The value of this case is in **quantity, not existence**:
 *   asserting only `count > 0` lets "stuck at the first one" pass perfectly.
 */
test('★ adding several list items in a row must make the panel follow **all** of them (not just the first)', async ({ page }) => {
  const baseURL = siyuanUrl();
  const token = siyuanToken();
  const api = await kernelApi(baseURL, token);
  let tempId = '';
  const N = 4;
  try {
    tempId = await createTempDoc(api, notebook || (await resolveTestNotebook(api)), '');
    await openDoc(page, tempId);
    await toOutlineView(page);

    await page.locator('.protyle-wysiwyg').first().click();
    await page.waitForTimeout(400);
    for (let i = 1; i <= N; i += 1) {
      await page.keyboard.type(`- 输入${i}`);
      await page.waitForTimeout(250);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(250);
    }

    // ★ The criterion is **quantity**: if the kernel really has N list items, the panel must have N nodes.
    //   Writing only `> 0` would leave "stuck at the first one" green —— which is exactly what this case hunts.
    //   ★ The placeholder row must be excluded (it reuses `.node-row`): starting from an empty document it hands out 1 free row,
    //     which satisfies an "N=1" expectation and robs the case of its discriminating power.
    await expect
      .poll(async () => page.locator('.node-row:not(.node-row-empty)').count(), {
        message: `after typing ${N} list items in a row, the panel should have at least ${N} rows (stuck at 1 row is the bug)`,
        timeout: 25_000,
      })
      .toBeGreaterThanOrEqual(N);

    // Check once more: every node text is there (not just enough rows, the content must be right too)
    const texts = (await page.locator('.node-text').allTextContents()).join('|');
    for (let i = 1; i <= N; i += 1) {
      expect(texts, `the panel should contain "输入${i}"`).toContain(`输入${i}`);
    }
  } finally {
    if (tempId) await removeDoc(api, tempId).catch(() => {});
    await api.dispose();
  }
});

/**
 * ★★★ The second pitfall in the same place: a re-read **must not** throw the UI back to loading state.
 *
 * Calling `setNodes(null)` before a re-read does not work: every keystroke while typing brings a
 * "block I do not know about yet" → null on every keystroke → the UI **flashes loading state constantly**.
 *
 * Criterion: **not once** during the whole typing session should loading state appear.
 */
test('★ the UI must not flash loading state while typing', async ({ page }) => {
  const baseURL = siyuanUrl();
  const token = siyuanToken();
  const api = await kernelApi(baseURL, token);
  let tempId = '';
  try {
    tempId = await createTempDoc(api, notebook || (await resolveTestNotebook(api)), '');
    await openDoc(page, tempId);
    await toOutlineView(page);

    // Install an observer that counts how many times loading state appears
    await page.evaluate(() => {
      const w = window as unknown as { __loadingCount: number; __last: boolean };
      w.__loadingCount = 0;
      w.__last = false;
      setInterval(() => {
        const els = Array.from(document.querySelectorAll('.om-mm-host *')).filter(
          (e) => (e.textContent || '').trim() === '加载中…',
        );
        const on = els.length > 0;
        if (on && !w.__last) w.__loadingCount += 1;
        w.__last = on;
      }, 100);
    });

    await page.locator('.protyle-wysiwyg').first().click();
    await page.waitForTimeout(400);
    for (let i = 1; i <= 3; i += 1) {
      await page.keyboard.type(`- 闪${i}`);
      await page.waitForTimeout(250);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(3000);

    const count = await page.evaluate(
      () => (window as unknown as { __loadingCount: number }).__loadingCount,
    );
    // One occurrence is allowed on the first render (there really is no data yet); it must not appear again while typing.
    expect(count, 'the UI must not keep falling back to loading state while typing —— that is exactly the "constant flashing"').toBeLessThanOrEqual(1);
  } finally {
    if (tempId) await removeDoc(api, tempId).catch(() => {});
    await api.dispose();
  }
});

/**
 * ## Multi-select and batch operations (`selected`)
 *
 * This area had **zero coverage** before: `selSet` / `.selbar` / 11 batch buttons had not a single case.
 * The very first case added caught a real bug —— **Shift+click range selection was completely broken** (see below).
 *
 * ### Bug root cause (fixed)
 *
 * The Shift branch of `onRowClick` used `anchor` as the range start, but `anchor` is
 * set in **two places**: Ctrl+click, and the node editor's `onFocus`.
 * The browser **focuses before it clicks** on `mousedown`:
 *
 *     mousedown 丁 → focusin 丁 (setAnchor(丁)) → click 丁 (shift)
 *
 * So after Ctrl+clicking 甲 and then Shift+clicking 丁, `anchor` has already been changed to 丁 ⇒ `lo === hi`
 * ⇒ `flat.slice(3, 4)` ⇒ **only 1 is selected**.
 *
 * ★ The fix is "make onFocus leave anchor alone", not "patch it up inside the Shift branch" ——
 *   because focus is a **side effect**, while the selection start must be decided by a **deliberate action**.
 */

test.describe('multi-select and batch operations', () => {
  test('Ctrl+click adds one at a time, clicking the same row again deselects it', async ({ page }) => {
    const rows = page.locator('.node-row');
    expect(await rows.count(), 'the test document should have several rows').toBeGreaterThan(3);

    await rows.nth(0).click({ modifiers: ['Control'] });
    await page.waitForTimeout(200);
    expect(await selectedTexts(page), 'one Ctrl+click should select 1').toHaveLength(1);

    await rows.nth(1).click({ modifiers: ['Control'] });
    await page.waitForTimeout(200);
    expect(await selectedTexts(page), 'another Ctrl+click should accumulate to 2').toHaveLength(2);

    await rows.nth(0).click({ modifiers: ['Control'] });
    await page.waitForTimeout(200);
    expect(await selectedTexts(page), 'Ctrl+clicking an already selected row should deselect it, leaving 1').toHaveLength(1);
  });

  test('★ Shift+click selects a range (click 甲 then Shift+click 丁 → 4)', async ({ page }) => {
    const rows = page.locator('.node-row');
    const n = await rows.count();
    expect(n, 'the test document should have at least 4 rows').toBeGreaterThanOrEqual(4);

    // Scenario A: Ctrl to pick the start → Shift to pick the end
    await rows.nth(0).click({ modifiers: ['Control'] });
    await page.waitForTimeout(200);
    await rows.nth(3).click({ modifiers: ['Shift'] });
    await page.waitForTimeout(300);
    expect(
      await selectedTexts(page),
      'Ctrl+click 甲 then Shift+click 丁 should select 甲..丁, 4 in total',
    ).toHaveLength(4);

    // Scenario B: plain click for the start → Shift for the end (the more intuitive path)
    await page.reload({ waitUntil: 'domcontentloaded' });
    await toOutlineView(page);
    const rows2 = page.locator('.node-row');
    await rows2.nth(0).click();
    await page.waitForTimeout(200);
    await rows2.nth(3).click({ modifiers: ['Shift'] });
    await page.waitForTimeout(300);
    expect(
      await selectedTexts(page),
      'plain click 甲 then Shift+click 丁 should also select 4 (a plain click must set the range start properly)',
    ).toHaveLength(4);
  });

  test('★ a plain click clears the old selection (otherwise the caret and the highlight contradict each other)', async ({ page }) => {
    const rows = page.locator('.node-row');
    await rows.nth(0).click({ modifiers: ['Control'] });
    await rows.nth(1).click({ modifiers: ['Control'] });
    await page.waitForTimeout(300);
    expect(await selectedTexts(page), 'precondition: Ctrl selected 2').toHaveLength(2);
    await expect(page.locator('.selbar'), 'precondition: the batch toolbar appeared').toHaveCount(1);

    // Plain click on row 4 —— the semantics are "I want to edit this row", not "I want to add to the selection"
    await rows.nth(3).click();
    await page.waitForTimeout(400);

    expect(
      await selectedTexts(page),
      'a plain click should clear the selection: otherwise the caret is on this row while the highlight is still on the first two, showing the user a contradictory state',
    ).toHaveLength(0);
    await expect(page.locator('.selbar'), 'the batch toolbar should collapse once the selection is cleared').toHaveCount(0);
  });

  test('★ keyboard Shift+arrow multi-select uses the same selection state as clicking', async ({ page }) => {
    await page.locator('.node-row').nth(0).click();
    await page.waitForTimeout(300);

    await page.keyboard.press('Shift+ArrowDown');
    await page.waitForTimeout(250);
    expect(await selectedTexts(page), 'one Shift+↓ should select 2 rows').toHaveLength(2);

    await page.keyboard.press('Shift+ArrowDown');
    await page.waitForTimeout(250);
    expect(await selectedTexts(page), 'two Shift+↓ should select 3 rows').toHaveLength(3);

    // ★ A keyboard selection must also bring up the batch toolbar ——
    //   otherwise "keyboard select" and "mouse select" would be two unrelated states.
    await expect(
      page.locator('.selbar'),
      'keyboard multi-select should drive the batch toolbar too (the same selected state)',
    ).toHaveCount(1);
  });

  test('★ "+summary" distinguishes by level: usable for siblings below the top, top-level siblings get the **real reason**', async ({ page }) => {
    const baseURL = siyuanUrl();
    const token = siyuanToken();
    const api = await kernelApi(baseURL, token);
    let docId = '';
    try {
      docId = await createTempDoc(
        api, notebook || (await resolveTestNotebook(api)),
        '- 甲\n  - 节点一\n  - 节点二\n- 乙\n',
      );
      await openDoc(page, docId);
      await toOutlineView(page);

      const rowIdx = (txt: string) =>
        page.evaluate((t) => {
          const rows = [...document.querySelectorAll('.node-row')];
          for (let i = 0; i < rows.length; i++) {
            const nt = rows[i].querySelector('.node-text');
            if (nt && (nt.textContent || '').trim() === t) return i;
          }
          return -1;
        }, txt);
      const ctrl = async (txt: string) => {
        const i = await rowIdx(txt);
        expect(i, `the row "${txt}" should be found`).toBeGreaterThanOrEqual(0);
        await page.locator('.node-row').nth(i).click({ modifiers: ['Control'] });
        await page.waitForTimeout(250);
      };

      // ① Siblings below the top (节点一 + 节点二, the parent is 甲) → summary **available**
      await ctrl('节点一');
      await ctrl('节点二');
      await expect(
        page.locator('.selbar button', { hasText: '概要' }),
        'two sibling children should be able to take a summary (the summary hangs on the parent topic 甲)',
      ).toHaveCount(1);

      // ② Top-level siblings (甲 + 乙) → the summary button **does not appear**, and clicking summary in the toolbar
      //    must give the **real reason** (there is nothing to attach it to at the top level), instead of telling the user to "select siblings again".
      await page.reload({ waitUntil: 'domcontentloaded' });
      await toOutlineView(page);
      await ctrl('甲');
      await ctrl('乙');
      await expect(
        page.locator('.selbar button', { hasText: '概要' }),
        'top-level siblings should not show the summary button (there is no parent node to attach to)',
      ).toHaveCount(0);

      let msg = '';
      page.on('dialog', async (d) => {
        msg = d.message();
        await d.accept();
      });
      await page.locator('button', { hasText: '概要' }).first().click();
      await page.waitForTimeout(700);

      expect(msg, 'a message should pop up').not.toBe('');
      expect(
        msg,
        'the user **already** selected 2 siblings, so the message must state the real reason (a top-level topic has no parent node to attach to),'
          + 'instead of telling them to "select 2 or more sibling topics first" —— that says nothing',
      ).toContain('顶层');
    } finally {
      if (docId) await removeDoc(api, docId);
      await api.dispose();
    }
  });

  test('the batch toolbar appears only with 2 or more selected, and shows the right count', async ({ page }) => {
    const rows = page.locator('.node-row');
    await expect(page.locator('.selbar'), 'there should be no batch toolbar initially').toHaveCount(0);

    await rows.nth(0).click({ modifiers: ['Control'] });
    await page.waitForTimeout(250);
    await expect(page.locator('.selbar'), 'the batch toolbar should not appear with only 1 selected').toHaveCount(0);

    await rows.nth(1).click({ modifiers: ['Control'] });
    await page.waitForTimeout(300);
    await expect(page.locator('.selbar'), 'selecting 2 should bring up the batch toolbar').toHaveCount(1);
    await expect(page.locator('.selbar'), 'the toolbar should report the number of selected rows').toContainText('2');
  });

  test('"Select all nodes" selects all rows', async ({ page }) => {
    const total = await page.locator('.node-row').count();
    // ★ The control is in the format toolbar, which starts collapsed in a narrow dock (see
    //   `ensureOutlineToolbarOpen`). Getting it into a clickable state is the test's job, not the product's.
    await ensureOutlineToolbarOpen(page);
    await page.locator('button[title*="全选"]').first().click();
    await page.waitForTimeout(400);

    expect(await selectedTexts(page), `select-all should select all ${total} rows`).toHaveLength(total);
    await expect(page.locator('.selbar'), 'the batch toolbar should appear after select-all').toHaveCount(1);
  });

  test('batch indent moves the selected rows down one level as a whole', async ({ page }) => {
    const baseURL = siyuanUrl();
    const token = siyuanToken();
    const api = await kernelApi(baseURL, token);
    let docId = '';
    try {
      docId = await createTempDoc(api, notebook || (await resolveTestNotebook(api)), TEMP_DOC_MD);
      await openDoc(page, docId);
      await toOutlineView(page);
      const rows = page.locator('.node-row');
      const n = await rows.count();
      expect(n, 'the temporary document should have several rows').toBeGreaterThanOrEqual(2);

      await rows.nth(0).click({ modifiers: ['Control'] });
      await rows.nth(1).click({ modifiers: ['Control'] });
      await page.waitForTimeout(300);
      await expect(page.locator('.selbar')).toHaveCount(1);

      const beforeRows = await outlineState(page).then((s) => s.rows);
      await page.locator('.selbar button', { hasText: '缩进' }).first().click();
      await page.waitForTimeout(800);

      // ★ Indent changes the **level**, not the row count —— the row count must stay the same,
      //   otherwise indent has been implemented as some other operation.
      expect(
        await outlineState(page).then((s) => s.rows),
        'indent only changes the level, the row count should not change',
      ).toBe(beforeRows);
    } finally {
      if (docId) await removeDoc(api, docId);
      await api.dispose();
    }
  });
});
