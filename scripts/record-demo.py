#!/usr/bin/env python3
"""Record a demo video of plugin operations (desktop).

## Two pitfalls you are bound to hit (each hit once already, do not hit them again)

### 1. Interaction must use CDP's `Input.dispatchMouseEvent` (real mouse events)

Events synthesized by JS `dispatchEvent` **cannot enter React's synthetic event system** —— the click does nothing,
and no error is raised either —— so not one of the 9 actions took effect, and the video showed only the picture moving while the UI never changed.

### 2. You must actively produce repaints, or the screencast emits no frames

`Page.startScreencast` only emits frames when the page **repaints**. When purely static, 2 seconds yield only 4 frames.
The approach that measured effective is in `_NUDGE_ON`: use a ~12fps **timer** (not rAF)
to keep changing a CSS variable that neither the plugin nor SiYuan uses, pulling the frame rate from ~2fps up to ~27fps.

★ Why not `requestAnimationFrame`: rAF paints frames endlessly at the display refresh rate,
which floods the screencast send queue, so all frames arrive bunched into the first instant,
and no further frames arrive afterwards (measured: 50 frames in the first stage, then 0 frames for all 9 following stages).

### 3. Duration cannot be derived from frame arrival times

screencast frames get buffered —— measured: in a 25-second recording all frame timestamps were squeezed into the last
3 seconds, so the composite came out only 3 seconds long. Hence `act(seconds, label)` has the **script** state each stage's
duration explicitly, and the frames received in that stage are spread evenly across the duration.

## Usage

    python3 scripts/record-demo.py            # use the default script
    python3 scripts/record-demo.py --doc <id> --out .tmp/demo.mp4

Artifacts are written to `.tmp/` by default (demo videos are not committed, and Releases do not contain them).
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import script_log  # noqa: E402
from env import cfg  # noqa: E402

import base64
import json
import subprocess

import websocket

# Repository root (this file lives under <root>/scripts/)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Intermediate frames and artifacts all go to .tmp/ (already ignored by .gitignore; demo videos are not committed)
OUT_DIR = os.path.join(ROOT, ".tmp", "screencast")

DOCK = '[data-type*="native-outline"]'

NUDGE_ON = """
(() => {
  if (window.__omRecNudge) return 'already';
  window.__omRecNudge = true;
  let i = 0;
  // ★ Use a ~12fps timer rather than requestAnimationFrame.
  //   rAF paints frames endlessly at the display refresh rate (60fps+), flooding the screencast send queue,
  //   so all frames arrive bunched into the first instant of the recording and no further frames arrive afterwards
  //   (measured: 50 frames in the first stage, then 0 frames for all 9 following stages).
  window.__omRecNudgeTimer = setInterval(() => {
    if (!window.__omRecNudge) return;
    // Change three places at once, so that whichever view is current there is a real repaint:
    //   ① the CSS variable on documentElement
    //   ② the outline of the plugin root container (barely visible, but it forces layout)
    //   ③ the position of a 1px element floating in a corner
    document.documentElement.style.setProperty('--om-rec-nudge', String(i % 2));
    const root = document.querySelector('.om-mm-root');
    if (root) root.style.opacity = i % 2 ? '0.999' : '1';
    i++;
  }, 83);
  return 'started';
})()
"""
NUDGE_OFF = """
(() => {
  window.__omRecNudge = false;
  clearInterval(window.__omRecNudgeTimer);
  document.documentElement.style.removeProperty('--om-rec-nudge');
  return 'stopped';
})()
"""


class Recorder:
    def __init__(self, url, w=1600, h=1000, ready=None, timeout=90):
        req = urllib.request.Request(
            f"{cfg.cdp_http}/json/new?{url}", method="PUT")
        info = json.load(urllib.request.urlopen(req, timeout=15))
        self.ws = websocket.create_connection(info['webSocketDebuggerUrl'],
                                              timeout=60)
        self.tab_id = info['id']
        self.mid = 0
        self.frames = []
        self.t0 = None
        self.assigned = 0.0
        self.send("Runtime.enable")
        self.send("Page.enable")
        self.send("Emulation.setDeviceMetricsOverride",
                  {"width": w, "height": h, "deviceScaleFactor": 1,
                   "mobile": False})

        # Return only once a **real condition** holds; do not guess with a fixed number of seconds.
        self.wait_for("document.readyState === 'complete'", timeout=timeout)
        if ready:
            self.wait_for(ready, timeout=timeout)

    def wait_for(self, expr, timeout=90, interval=0.3):
        """Poll until expr is true; on timeout it raises, leaving no illusion of "it looks like it ran"."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.ev(expr):
                return True
            time.sleep(interval)
        raise TimeoutError(f"Timed out waiting ({timeout}s): {expr}")


    def send(self, method, params=None):
        self.mid += 1
        self.ws.send(json.dumps({"id": self.mid, "method": method,
                                 "params": params or {}}))
        while True:
            r = json.loads(self.ws.recv())
            if r.get('id') == self.mid:
                # ★ Same contract as scripts/cdp.py: a CDP-level error raises, never dissolves
                #   into {} where callers would read it as empty data.
                if 'error' in r:
                    raise RuntimeError(f"CDP {method} failed: {r['error']}")
                # ★ Carry a JS-side exception on the result (see cdp.py): `ev` reads only the
                #   result dict, so top-level exceptionDetails would otherwise be stripped here.
                res = r.get('result', {})
                if 'exceptionDetails' in r and isinstance(res, dict):
                    res = dict(res, exceptionDetails=r['exceptionDetails'])
                return res

    def ev(self, expr):
        res = self.send("Runtime.evaluate",
                        {"expression": expr, "returnByValue": True,
                         "awaitPromise": True})
        # ★ Same contract as scripts/cdp.py: a JS exception raises, never dissolves into None.
        if 'exceptionDetails' in res:
            text = res['exceptionDetails'].get('text', '')
            desc = ((res.get('result') or {}).get('description') or '')
            raise RuntimeError(f"JS evaluation failed [{text}]: {desc or expr[:120]}")
        return res.get('result', {}).get('value')

    def rect(self, sel, nth=0):
        return self.ev(f"""(()=>{{
          const es=[...document.querySelectorAll({json.dumps(sel)})];
          const e=es[{nth}]; if(!e) return null;
          const r=e.getBoundingClientRect();
          if(r.width<1||r.height<1) return null;
          return {{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}};
        }})()""")

    def move_to(self, sel, nth=0, alt=False):
        b = self.rect(sel, nth)
        if not b:
            return False
        self.send("Input.dispatchMouseEvent",
                  {"type": "mouseMoved", "x": b['x'], "y": b['y'],
                   "modifiers": 1 if alt else 0})
        return True

    def click(self, sel, nth=0, alt=False):
        """★ A real mouse click (synthetic events do not work with React)"""
        b = self.rect(sel, nth)
        if not b:
            print(f"       ⚠ cannot click {sel}[{nth}]")
            return False
        mods = 1 if alt else 0          # CDP modifier bits: Alt = 1
        self.send("Input.dispatchMouseEvent",
                  {"type": "mouseMoved", "x": b['x'], "y": b['y'],
                   "modifiers": mods})
        self.pump(0.3)
        self.send("Input.dispatchMouseEvent",
                  {"type": "mousePressed", "x": b['x'], "y": b['y'],
                   "button": "left", "clickCount": 1, "modifiers": mods})
        self.pump(0.1)
        self.send("Input.dispatchMouseEvent",
                  {"type": "mouseReleased", "x": b['x'], "y": b['y'],
                   "button": "left", "clickCount": 1, "modifiers": mods})
        return True

    def select_option(self, sel, nth=0, step=1):
        """Change a <select>'s option —— go through the native setter + change (React receives it)."""
        js = json.dumps(sel)
        return self.ev(
            "(()=>{"
            f"const s=[...document.querySelectorAll({js})][{nth}];"
            "if(!s) return null;"
            f"const idx=(s.selectedIndex+{step})%s.options.length;"
            "const set=Object.getOwnPropertyDescriptor("
            "window.HTMLSelectElement.prototype,'value').set;"
            "set.call(s,s.options[idx].value);"
            "s.dispatchEvent(new Event('change',{bubbles:true}));"
            "return s.options[idx].text;"
            "})()")

    # ---------- Recording ----------
    def start(self):
        self.t0 = time.time()
        self.send("Page.startScreencast", {"format": "jpeg", "quality": 90,
                                           "maxWidth": 1600, "maxHeight": 1000,
                                           "everyNthFrame": 1})
        print("  ● recording started")

    def pump(self, seconds):
        deadline = time.time() + seconds
        self.ws.settimeout(0.2)
        while time.time() < deadline:
            try:
                m = json.loads(self.ws.recv())
            except Exception:
                continue
            if m.get('method') != 'Page.screencastFrame':
                continue
            p = m['params']
            path = os.path.join(OUT_DIR, f"f{len(self.frames):05d}.jpg")
            with open(path, 'wb') as fh:
                fh.write(base64.b64decode(p['data']))
            self.frames.append((time.time() - self.t0, path))
            self.send("Page.screencastFrameAck", {"sessionId": p['sessionId']})
        self.ws.settimeout(60)

    def act(self, seconds, label=''):
        """Present one stage for `seconds` seconds.

        ★ The duration cannot be derived from "frame arrival times" —— screencast frames get buffered,
        measured: in a 25-second recording all frame timestamps were squeezed into the last 3 seconds,
        so the composite came out only 3 seconds long.
        Hence the **script** states each stage's duration explicitly,
        and the frames received in that stage are spread evenly across the stage duration.
        """
        print(f"     · {label} ({seconds}s)")
        before = len(self.frames)
        self.pump(seconds)
        after = len(self.frames)
        # Assign evenly spaced timestamps to the frames newly received in this stage
        n = after - before
        print(f"       [{n} frames received in this stage]")
        if n <= 0:
            self.assigned += seconds      # ★ advance the timeline even with no frames
            return
        for i in range(n):
            # stage start = the total duration assigned so far; frames are spread evenly within it
            self.frames[before + i] = (
                self.assigned + seconds * (i / n),
                self.frames[before + i][1],
            )
        self.assigned += seconds

    def stop(self):
        self.send("Page.stopScreencast")
        print(f"  ● finished, {len(self.frames)} frames")
        return self.frames

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass
        try:
            urllib.request.urlopen(
                f"{cfg.cdp_http}/json/close/{self.tab_id}", timeout=5)
        except Exception:
            pass


def build_video(frames, out_webm, out_mp4):
    """Compose the video from "frame arrival times"; frames arrive in bursts, so the gaps are uneven."""
    if not frames:
        raise SystemExit("no frames")
    listfile = os.path.join(OUT_DIR, "frames.txt")
    with open(listfile, 'w') as fh:
        for i, (ts, path) in enumerate(frames):
            nxt = frames[i + 1][0] if i + 1 < len(frames) else ts + 0.2
            dur = max(0.02, nxt - ts)
            fh.write(f"file '{os.path.abspath(path)}'\n")
            fh.write(f"duration {dur:.4f}\n")
        fh.write(f"file '{os.path.abspath(frames[-1][1])}'\n")
    base = ["ffmpeg", "-y", "-loglevel", "error",
            "-f", "concat", "-safe", "0", "-i", listfile,
            "-fps_mode", "vfr", "-pix_fmt", "yuv420p"]
    subprocess.run(base + ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32",
                           out_webm], check=True)
    subprocess.run(base + ["-c:v", "libx264", "-crf", "22",
                           "-movflags", "+faststart", out_mp4], check=True)
    print(f"  ✓ {out_webm}")
    print(f"  ✓ {out_mp4}")

def default_story(r):
    """Default demo script: covers the main outline / mind map operations.

    Every step is `(action, narration)` —— the action uses a method of `r`,
    and the narration is how many seconds this stage stays plus the text that gets printed.
    """
    r.act(3.0, "① The right sidebar's 'Mindmap' panel follows the current document automatically")

    r.click('.node-row', 0)
    r.act(2.2, "② Click a node; the top toolbar becomes available")

    r.move_to('.om-bullet.has-children', 0)
    r.act(1.0, "③ Bullet: click to focus / Alt+click to collapse")

    r.click('.om-bullet.has-children', 0, alt=True)
    r.act(2.0, "④ Alt+click the bullet → collapse the whole branch")

    r.click('.om-bullet.has-children', 0, alt=True)
    r.act(2.0, "⑤ Alt+click again → expand it back")

    r.click('.om-mm-viewswitch button', 1)
    r.act(3.0, "⑥ Switch to the 'Mindmap' view")

    r.click('.dock-btn', 0)
    r.act(2.2, "⑦ Switch to a different color theme")

    t = r.select_option('.mm-bar select', 0, 1)
    r.act(2.6, f"⑧ Change the layout structure → {t}")

    t = r.select_option('.mm-bar select', 1, 1)
    r.act(2.2, f"⑨ Change the line style → {t}")

    r.click('.om-mm-viewswitch button', 0)
    r.act(2.6, "⑩ Switch back to the 'Outline' view")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc", default=None)
    ap.add_argument("--url", default=None)
    ap.add_argument("--out", default=None, help="output mp4 path")
    # There is no --wait any more: readiness is decided by the page's real state, not by guessing seconds.
    args = ap.parse_args()

    doc = args.doc
    if not doc and not args.url:
        p = os.path.join(ROOT, ".tmp", "demo-docid.txt")
        if os.path.exists(p):
            doc = open(p).read().strip()
    # ★ Test **the value that must be present**, not a substring of the URL built from it.
    #
    #   This used to be `if "none" in url`, which is wrong in both directions at once (measured):
    #     · `--doc None` was accepted, because Python's `None` stringifies to `None` and the test was for
    #       the lowercase `none` —— so the recording started against a page with no document;
    #     · a real document id containing the letters n-o-n-e was **refused**, because the check looked at
    #       the whole URL rather than at the id.
    #   The real precondition is "we have a document id, or an explicit url" —— so say that.
    if not doc and not args.url:
        print("--doc <docId> or --url is required", file=sys.stderr)
        print("   (a document id can also be left in .tmp/demo-docid.txt)", file=sys.stderr)
        return 1
    url = args.url or cfg.build_url("desktop", doc)

    os.makedirs(OUT_DIR, exist_ok=True)
    mp4 = args.out or os.path.join(OUT_DIR, "demo-desktop.mp4")
    webm = os.path.splitext(mp4)[0] + ".webm"

    # Wait until the editor is really mounted —— do not use a fixed sleep (the UI was measured ready in 1.3 seconds,
    # while this parameter used to be a fixed 26 seconds).
    print("  waiting for SiYuan to be ready…")
    t0 = time.time()
    r = Recorder(url, ready="!!document.querySelector('.protyle-wysiwyg')")
    print(f"  ready ({time.time() - t0:.1f}s)")

    if not r.ev(f"""(()=>{{const d=document.querySelector('{DOCK}');
        return d&&d.classList.contains('dock__item--active')}})()"""):
        r.click(DOCK)
        r.wait_for("!!document.querySelector('.om-mm-host')", timeout=30)

    r.ev(NUDGE_ON)      # ★ turn repaints on → then there are frames
    time.sleep(0.6)
    try:
        r.start()
        default_story(r)
        frames = r.stop()
    finally:
        # ★ Release on every path, not just success: an exception inside the story used to leave
        #   the 12fps repaint-nudge setInterval mutating the user's open SiYuan page (and the tab
        #   open) after the script died. Stop the screencast if still running, turn the nudge off,
        #   and close the tab — each step guarded so one failure cannot block the rest.
        #   (An exception still propagates after cleanup: a failed story must not build a video.)
        try:
            r.send("Page.stopScreencast")
        except Exception:
            pass
        try:
            r.ev(NUDGE_OFF)     # ★ turn the repaint side effect off
        except Exception:
            pass
        try:
            r.close()
        except Exception:
            pass
    build_video(frames, webm, mp4)
    return 0


if __name__ == '__main__':
    with script_log.track("record-demo"):
        sys.exit(main())
