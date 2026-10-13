#!/usr/bin/env python3
"""Export the whole mind map as a PNG —— for visually verifying the mind map rendering, an order of magnitude faster than a full-page screenshot.

★ Why not call `Tab.shot()` directly:
    A full-page screenshot needs **a new tab + waiting for the plugin to mount + waiting for the document to load**, measured at about 40 seconds;
    this script **reuses the already-open SiYuan tab**, does no navigation at all, measured at about 2.6 seconds.
    And verifying the mind map rendering does not care about the SiYuan shell anyway, only about what the SVG draws.

Usage::

    python3 scripts/mindmap-shot.py                     # use the currently open page
    python3 scripts/mindmap-shot.py -o .tmp/mm.png      # specify the output
    python3 scripts/mindmap-shot.py --structure right   # switch to some structure first, then export

★ What it draws is **the SVG the product itself rendered** (taken straight from `.mm-canvas svg` in the page);
   this script only adds one step, "SVG → PNG rasterization", and never redraws any shape.
"""

from __future__ import annotations

import argparse
import base64
import json
import pathlib
import sys
import time
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import env  # noqa: E402
import script_log  # noqa: E402

CDP_LIST = f"http://{env.cfg.cdp_host}:{env.cfg.cdp_port}/json/list"

# The export script (runs in the page context).
#
# ★★ Here is a pitfall actually hit: **do not iterate the child elements calling getBBox() on each and union the results**.
#    Each node is wrapped in its own `<g transform="translate(...)">`,
#    so getBBox() on a child element returns the rect in **that element's own local coordinate system**,
#    which comes out as a pile of 0,0 and ends with the viewBox turned into a blank 350x180 frame ——
#    **the export "succeeds" and produces a pure white image**, which you cannot notice without looking at the image.
#    The right way: call getBBox() directly on the transformed `<g>`;
#    what it returns is already the union of the children in the **same local space**.
EXPORT_JS = r"""
(async () => {
  const svg = document.querySelector('.mm-canvas svg');
  const g = svg && svg.querySelector('g[transform]');
  if (!g) return null;

  // ★★ The plugin styles **must be embedded into the SVG along with it** (measured, hit this).
  //   The collapse button `.mm-badge` next to a node has no inline style; its "invisibility"
  //   rests entirely on the page CSS rule `.mm-node:not(.mm-collapsed) .mm-badge { opacity: 0 }`.
  //   cloneNode + XMLSerializer carries over only the class attribute and **does not carry the page CSS**,
  //   so when the SVG renders as a standalone document opacity falls back to 1 ——
  //   a big "−" circle pops up at every branch junction, completely unlike what is seen on screen.
  //   With the styles embedded, the export matches what is seen on screen.
  const css = [...document.querySelectorAll('style')]
    .map(s => s.textContent || '')
    .join('\n');
  const st = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  st.textContent = css;
  svg.insertBefore(st, svg.firstChild);
  try {

  const bb = g.getBBox();                    // ← ask g for the union, not a walk over the children
  const pad = 28;
  const W = Math.max(1, Math.ceil(bb.width + pad * 2));
  const H = Math.max(1, Math.ceil(bb.height + pad * 2));

  const clone = svg.cloneNode(true);
  // ★★ Embedding the styles alone is not enough —— the collapse-button rule in the plugin styles is
  //      `.om-mm-host .mm-node:not(.mm-collapsed) .mm-badge { opacity: 0 }`
  //    and it requires an ancestor with `.om-mm-host`. The cloned SVG is a standalone document whose root has no such class,
  //    so the rule never matches → a big "−" circle pops up at every branch junction all the same.
  //    Add that class to the root node and the descendant selector connects.
  clone.setAttribute('class',
    ((svg.getAttribute('class') || '') + ' om-mm-host').trim());
  clone.setAttribute('width', W);
  clone.setAttribute('height', H);
  clone.setAttribute('viewBox', `${bb.x - pad} ${bb.y - pad} ${W} ${H}`);
  clone.removeAttribute('style');            // style holds width:100%, which would override the size set above
  const cg = clone.querySelector('g');
  if (cg) cg.setAttribute('transform', '');  // drop the translate/scale → export the whole map instead of the current viewport

  const xml = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });

  const S = 2, cv = document.createElement('canvas');   // 2x resolution, so the details are legible
  cv.width = W * S; cv.height = H * S;
  const ctx = cv.getContext('2d');
  const bg = getComputedStyle(document.body).backgroundColor || '#ffffff';
  ctx.fillStyle = bg; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.scale(S, S); ctx.drawImage(img, 0, 0, W, H);
  const out = cv.toDataURL('image/png');
  } finally {
    // ★ The injected <style> served the clone only — remove it from the LIVE page on every path,
    //   or each run accumulates one extra <style> in the user's open svg. Same for the blob URL.
    if (typeof url !== 'undefined' && url) { try { URL.revokeObjectURL(url); } catch (e) {} }
    if (st.parentNode) st.parentNode.removeChild(st);
  }
  return typeof out !== 'undefined' ? out : null;
})()
"""


def _probe(conn, expr: str):
    """A single evaluate (used to pick a tab)."""
    conn.send(json.dumps({
        "id": 1, "method": "Runtime.evaluate",
        "params": {"expression": expr, "returnByValue": True},
    }))
    while True:
        msg = json.loads(conn.recv())
        if msg.get("id") == 1:
            return msg.get("result", {}).get("result", {}).get("value")


def _connect(prefer_mindmap: bool = True):
    """Connect to **an already-open** SiYuan page.

    ★ No new tab, no navigation —— this is the only reason this script is over ten times faster than a full-page screenshot.

    SiYuan may have several pages open at once, so probe them one by one and pick **the one where the mind map is already mounted**;
    if there is none, fall back to the first (later `ensure_mindmap` will click the mind map button).
    """
    from websocket import create_connection

    tabs = json.loads(urllib.request.urlopen(CDP_LIST, timeout=5).read())
    pages = [t for t in tabs if t.get("type") == "page"]
    if not pages:
        sys.exit("No open SiYuan page found —— open a SiYuan window by hand first.")

    fallback = None
    opened = []  # every probed connection, so rejects can be closed instead of leaked
    for t in pages:
        try:
            conn = create_connection(t["webSocketDebuggerUrl"], timeout=30)
        except Exception:
            continue
        opened.append(conn)
        try:
            if _probe(conn, "!!document.querySelector('.mm-canvas')"):
                # ★ Close the rejects: every probed tab that is NOT picked used to leak its
                #   websocket, accumulating connections against the CDP endpoint run after run.
                for c in opened:
                    if c is not conn:
                        try:
                            c.close()
                        except Exception:
                            pass
                return conn
        except Exception:
            pass
        fallback = fallback or conn
    # ★ Same cleanup on the fallback path: keep one, close the rest.
    for c in opened:
        if c is not fallback:
            try:
                c.close()
            except Exception:
                pass
    return fallback


class Session:
    """A minimal CDP session that reuses an already-open tab (evaluate only, no navigation)."""

    def __init__(self) -> None:
        self.conn = _connect()
        self._id = 0

    def ev(self, expr: str):
        self._id += 1
        self.conn.send(json.dumps({
            "id": self._id, "method": "Runtime.evaluate",
            "params": {"expression": expr, "returnByValue": True, "awaitPromise": True},
        }))
        while True:
            msg = json.loads(self.conn.recv())
            if msg.get("id") == self._id:
                return msg.get("result", {}).get("result", {}).get("value")

    def close(self) -> None:
        self.conn.close()


def ensure_mindmap(s: Session) -> None:
    """Switch to the mind map view (if not already there)."""
    s.ev("""(() => {
      const el = [...document.querySelectorAll('.om-mm-viewswitch button')]
        .filter(x => x.textContent.trim() === 'Mindmap' || x.textContent.trim() === '\\u5bfc\\u56fe');
      if (el.length) el[el.length - 1].click();
      return el.length;
    })()""")
    # Wait until the canvas really appears —— the plugin mounts asynchronously, so querying right after the click may find nothing yet.
    for _ in range(20):
        if s.ev("!!document.querySelector('.mm-canvas svg g[transform]')"):
            return
        time.sleep(0.4)
    print("  ⚠️ Waited 8 seconds and the mind map canvas still is not there (the page may not be in the mind map view, or the document is empty)")


def set_structure(s: Session, structure: str) -> str | None:
    """Switch the structure. Returns the value actually switched to; None on failure."""
    got = s.ev(f"""(() => {{
      const sel = document.querySelector('.mm-bar select');
      if (!sel) return null;
      sel.value = {structure!r};
      sel.dispatchEvent(new Event('change', {{ bubbles: true }}));
      return sel.value;
    }})()""")
    time.sleep(1.5)
    return got


def main() -> int:
    ap = argparse.ArgumentParser(description="Export the whole mind map as a PNG")
    ap.add_argument("-o", "--out", default=".tmp/mindmap.png", help="output PNG path")
    ap.add_argument("--structure", default=None,
                    help="switch to this structure before exporting (default/right/left/org/treeRight/timeline)")
    args = ap.parse_args()

    t0 = time.time()
    s = Session()
    try:
        ensure_mindmap(s)
        if args.structure:
            got = set_structure(s, args.structure)
            print(f"  structure switched to {got!r}" + ("" if got else "  ❌ did not switch (dropdown not found?)"))

        n = s.ev("document.querySelectorAll('.mm-node').length")
        if not n:
            print("  ⚠️ No .mm-node on the page —— maybe not in the mind map view, or the document is empty.")

        data = s.ev(EXPORT_JS)
        if not data:
            print("  ❌ Could not get the SVG (is the page not in the mind map view?)")
            return 1

        out = pathlib.Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        raw = base64.b64decode(data.split(",", 1)[1])
        out.write_bytes(raw)
        print(f"  ✅ {out}  {len(raw) // 1024} KB  {n} nodes  took {time.time() - t0:.1f}s")
        print("  ★ Remember to look at the image to confirm it is not blank —— a \"successful\" export can still be a pure white image.")
        return 0
    finally:
        s.close()


if __name__ == "__main__":
    with script_log.track("mindmap-shot"):
        raise SystemExit(main())