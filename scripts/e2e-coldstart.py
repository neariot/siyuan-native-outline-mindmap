#!/usr/bin/env python3
"""Where does an E2E case's startup time actually go, and is any of it avoidable?

## Why this exists

"Can the E2E suite avoid paying a cold start every time?" is a question that gets answered badly by
reasoning: the obvious answer is "reuse the browser context", and that was **tried and reverted** ——
SiYuan restores its previous UI layout out of localStorage, so a reused context makes later cases wait
forever for a panel that the restored layout does not contain (see `e2e/fixtures.ts`, which records the
measured instability). A second obvious answer is "the browser takes 11 seconds to start", which the
config's own comment says —— and it is not true of the load a case actually pays.

So the numbers come from here instead. This script drives one real startup in the same order the fixtures
do and prints the cost of each phase, plus what the phase would cost a second time, so "unavoidable" and
"we chose this" can be told apart.

## What it measures

    probe   one case's startup, phase by phase, in the fixtures' own order
    repeat  the same page loaded twice, to separate one-off cost from per-case cost
    switch  whether a document can be opened without a full page load

## Reading the output

A phase that is large **in both** columns is paid per case and is a candidate for work.
A phase that is large the first time and small the second is a genuine one-off (a cold browser, a cold
cache) and a warm-up can absorb it.
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from env import cfg  # noqa: E402
import script_log  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

#: One startup, in the fixtures' order. `openSiYuan` and `openDoc` are what every case pays before its
#: first assertion; anything added here must be a step they really take, or the attribution is fiction.
PROBE = r"""
const CHROMIUM = process.env.CHROMIUM_PATH, BASE = process.env.TEST_URL, NB = process.env.NOTEBOOK,
      TOKEN = process.env.TOKEN;
if (!CHROMIUM || !BASE || !NB || !TOKEN) throw new Error('the caller must pass CHROMIUM_PATH/TEST_URL/NOTEBOOK/TOKEN');

const { chromium, request } = await import('@playwright/test');
const api = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: 'Token ' + TOKEN } });
const sql = async (stmt) => (await (await api.post('/api/query/sql', { data: { stmt } })).json()).data || [];

let t = Date.now();
const rows = [];
async function step(label, fn) {
  const started = Date.now();
  const value = await fn();
  rows.push({ label, seconds: (Date.now() - started) / 1000 });
  return value;
}

// --- what the spec pays before the browser is even opened: createTempDoc + waitUntilIndexed
const docId = await step('create the test document (kernel call)', async () => {
  const r = await api.post('/api/filetree/createDocWithMd',
    // ASCII on purpose: this probe measures timing, not text handling, and a CJK fixture here would be a
    // *second* copy of the one the specs own -- in a Python file it reads as a literal in shipped code,
    // which section 2 forbids (the language gate caught exactly that).
    { data: { notebook: NB, path: `/E2E-coldstart-${Date.now()}`, markdown: '- probe node\n' } });
  return (await r.json()).data;
});
await step('wait for the SQL index (waitUntilIndexed)', async () => {
  while (true) {
    if ((await sql(`SELECT id FROM blocks WHERE id='${docId}' LIMIT 1`)).length) return;
    await new Promise((r) => setTimeout(r, 150));
  }
});

const browser = await step('launch the browser', () => chromium.launch({
  headless: true, executablePath: CHROMIUM, args: ['--no-sandbox', '--disable-dev-shm-usage'] }));
let page;
await step('new context + page', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await ctx.newPage();
});

// --- fixtures.openSiYuan()
await step('openSiYuan: goto "/"', () => page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 }));
await step('openSiYuan: window.siyuan.layout', () => page.waitForFunction(
  () => !!(window.siyuan && window.siyuan.layout), undefined, { timeout: 60000 }));
await step('openSiYuan: .layout__center visible',
  () => page.locator('.layout__center').waitFor({ state: 'visible', timeout: 30000 }));
await step('openSiYuan: #toolbar visible',
  () => page.locator('#toolbar').waitFor({ state: 'visible', timeout: 30000 }));
await step('openSiYuan: waitForRendered (screenshot gate)', async () => {
  const { PNG } = await import('pngjs');
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const buf = await page.screenshot({ scale: 'css' });
    const png = PNG.sync.read(buf);
    const seen = new Set(); let sum = 0, n = 0;
    for (let i = 0; i < png.data.length; i += 4 * 97) {
      seen.add((png.data[i] >> 4) * 4096 + (png.data[i + 1] >> 4) * 64 + (png.data[i + 2] >> 4));
      sum += (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3; n++;
    }
    if (seen.size > 30 && sum / n > 100) return;
    await page.waitForTimeout(250);
  }
  throw new Error('never became ready');
});
await step('waitPluginReady: dock button', () => page.locator('[data-type*="native-outline-mindmap"]')
  .first().waitFor({ state: 'visible', timeout: 60000 }));

// --- openDoc(): a second full page load, per case
await step('openDoc: goto "/?id=<doc>" (FULL LOAD)', () => page.goto(`${BASE}/?id=${docId}`,
  { waitUntil: 'domcontentloaded', timeout: 60000 }));
await step('openDoc: window.siyuan.layout (2nd load)', () => page.waitForFunction(
  () => !!(window.siyuan && window.siyuan.layout), undefined, { timeout: 60000 }));

// --- openDoc() continues: the dock has to be open before a case can interact with the panel.
//   ★ This phase was MISSING from the first version of this probe, and the 10.4s it hides is why the
//     table it produced said "startup is cheap" while every case really spent 10.4s here. A probe that
//     stops before the expensive step does not measure the expensive step.
await step('openDoc: ensureDockOpen (the panel really open)', async () => {
  const entry = page.locator('[data-type*="native-outline-mindmap"]').first();
  await entry.waitFor({ state: 'visible', timeout: 60000 });
  const isOpen = () => page.evaluate(() => {
    const all = document.querySelectorAll('.om-mm-viewswitch');
    const last = all[all.length - 1];
    return last ? last.getBoundingClientRect().width > 0 : false;
  });
  if (await isOpen()) return;
  // The same predicate the helper uses: click only a dock that is not already active, then wait.
  const active = () => page.evaluate(() => {
    const icon = document.querySelector('[data-type*="native-outline-mindmap"]');
    const item = icon?.closest('.dock__item') ?? icon?.parentElement;
    return !!(item && item.className.includes('dock__item--active'));
  });
  if (await active()) {
    const dl = Date.now() + 10000;
    while (Date.now() < dl) { if (await isOpen()) return; await page.waitForTimeout(50); }
  }
  for (let a = 1; a <= 3; a++) {
    if (!(await active())) await entry.click({ force: true });
    const dl = Date.now() + 10000;
    while (Date.now() < dl) { if (await isOpen()) return; await page.waitForTimeout(50); }
  }
  throw new Error('the dock never opened');
});

// --- the repeat: the same page, in the same browser, a second time
await step('REPEAT: goto "/" again (same browser)', () => page.goto(BASE,
  { waitUntil: 'domcontentloaded', timeout: 60000 }));
await step('REPEAT: window.siyuan.layout', () => page.waitForFunction(
  () => !!(window.siyuan && window.siyuan.layout), undefined, { timeout: 60000 }));

await step('cleanup', async () => {
  await browser.close();
  await api.post('/api/filetree/removeDocByID', { data: { id: docId } });
});

console.log(JSON.stringify(rows));
"""


def run_probe() -> list:
    env = dict(os.environ)
    env.update({
        "CHROMIUM_PATH": cfg.chromium_path,
        "TEST_URL": cfg.siyuan_test,
        "TOKEN": cfg.test_token(),
        "NOTEBOOK": cfg.test_notebook,
    })
    if not env["NOTEBOOK"]:
        sys.exit("  SIYUAN_TEST_NOTEBOOK is not set —— run `python3 scripts/env.py` and fill it in.")
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", PROBE],
        cwd=ROOT, env=env, capture_output=True, text=True, timeout=900,
    )
    if proc.returncode != 0:
        # ★ Name the likeliest cause instead of pasting a stack: the same reasoning as global-setup, where a
        #   missing kernel used to surface as a 60s timeout that said "test timeout" and nothing else.
        detail = (proc.stderr or proc.stdout).strip().splitlines()
        tail = detail[-1] if detail else "(no output)"
        hint = ""
        if "ECONNREFUSED" in (proc.stderr or "") or "ERR_CONNECTION_REFUSED" in (proc.stderr or ""):
            hint = ("\n  The SiYuan kernel at %s is not answering —— start the isolated test instance, "
                    "which is the only target this script probes." % cfg.siyuan_test)
        sys.exit("  the probe failed (exit %d): %s%s" % (proc.returncode, tail[:300], hint))
    for line in reversed(proc.stdout.strip().splitlines()):
        line = line.strip()
        if line.startswith("["):
            return json.loads(line)
    sys.exit("  the probe printed no result")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--runs", type=int, default=3,
                    help="how many times to repeat the probe (default 3: the variation matters)")
    args = ap.parse_args()

    print()
    print("  One E2E case's startup, in the fixtures' own order.")
    print("  ★ `first`/`repeat` is the same page loaded twice in one browser —— a phase that is large in")
    print("    both columns is paid per case; one that is large only the first time is a genuine cold start.")
    print()

    runs = [run_probe() for _ in range(max(1, args.runs))]
    labels = [row["label"] for row in runs[0]]

    width = max(len(l) for l in labels) + 2
    print(f"  {'phase'.ljust(width)}{'mean':>8}{'min':>8}{'max':>8}")
    print(f"  {'-' * width}{'-' * 8}{'-' * 8}{'-' * 8}")

    totals = []
    for label in labels:
        values = [next((r["seconds"] for r in run if r["label"] == label), 0.0) for run in runs]
        mean = sum(values) / len(values)
        marker = ""
        if "REPEAT" in label:
            marker = "   ← the same work, again"
        elif "launch the browser" in label:
            marker = "   ← paid once per worker, not per case"
        print(f"  {label.ljust(width)}{mean:>7.1f}s{min(values):>7.1f}s{max(values):>7.1f}s{marker}")
    for run in runs:
        totals.append(sum(r["seconds"] for r in run))
    print(f"  {'-' * width}{'-' * 8}{'-' * 8}{'-' * 8}")
    print(f"  {'TOTAL'.ljust(width)}{sum(totals)/len(totals):>7.1f}s{min(totals):>7.1f}s{max(totals):>7.1f}s")

    per_case = [r for r in runs[0] if not r["label"].startswith("REPEAT")]
    print()
    # ★ The comparison is measured now, not quoted: the median case was 16.5s while the dock helper cost
    #   10.4s per case, and a hard-coded "the median case is 16.5s" outlived the fix and made the startup
    #   share look twice as large as it is. `run-e2e.py` writes the real durations into `.logs/e2e-*.log`.
    startup = sum(r['seconds'] for r in per_case)
    print(f"  a case pays {startup:.1f}s before its first assertion")
    print(f"  ★ the per-case floor of a case that only opens the panel is about this number "
          f"({startup:.1f}s); the rest of any case is the test's own work")
    print("  ★ A phase that is unavoidable is not the same as a phase that is free: only what this table")
    print("    shows as per-case and large is worth working on.")
    print()
    return 0


if __name__ == "__main__":
    with script_log.track("e2e-coldstart"):
        sys.exit(main())
