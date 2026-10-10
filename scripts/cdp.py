"""Lightweight CDP (Chrome DevTools Protocol) client: open a tab → evaluate / screenshot → close it.

## When to use it

Only verification that **genuinely needs a browser** requires it:

- whether CSS really takes effect (who wins the cascade / `@media` / `!important`)
- whether `ResizeObserver` and event handlers really fire
- end-to-end round trips with the SiYuan kernel, screenshots, screen recording

Verification of pure functions / rendered structure should go through `npm test` (offline, 2 seconds, stricter).
See `docs/TESTING.md`.

## Usage

    import sys; sys.path.insert(0, 'scripts')
    from cdp import Tab
    from env import cfg

    with Tab(cfg.build_url('desktop', doc_id),
             ready="!!document.querySelector('.protyle-wysiwyg')") as t:
        print(t.ev("document.title"))
        t.shot(".tmp/shot.png")

    Pass a boolean expression as `ready`; the function polls until it turns true —— do not use a fixed `wait`:
    the UI was measured ready in 1.3 seconds, so a fixed 30-second wait is 28.7 seconds of waiting for nothing.

Ports and addresses come from `.env` (see `.env.example`); no longer hardcoded.

## Pitfalls already hit (each is written down where it belongs)

- `/json/new` **must use PUT**; GET returns 405.
- After 12+ accumulated tabs the websocket times out in `readinto` —— hence
  `close_stale_tabs()`, call it once before opening a new page.
- The SiYuan desktop build needs ~26-30 seconds, mobile ~38-40 seconds; give `wait` enough.
"""

import base64
import json
import os
import time
import urllib.request

try:
    import websocket  # websocket-client
except ImportError:  # pragma: no cover
    websocket = None

# Configuration is centralized in scripts/env.py (which reads .env); no hardcoded ports here, and no fallback either.
#
# Why no fallback: a fallback makes "missing configuration" show up as "used a guessed address",
# so the script may debug the wrong machine with no hint at all. Better to raise an error right here.
sys_path = os.path.dirname(os.path.abspath(__file__))
if sys_path not in __import__("sys").path:
    __import__("sys").path.insert(0, sys_path)

from env import cfg  # noqa: E402

DEFAULT_HOST = cfg.cdp_host
DEFAULT_PORT = cfg.cdp_port


def _base(host=None, port=None):
    """HTTP base URL for CDP. Every /json/... request is built from it; do not hardcode a host again."""
    return "http://%s:%s" % (host or DEFAULT_HOST, port or DEFAULT_PORT)


def _http(url, method="GET", timeout=10):
    req = urllib.request.Request(url, method=method)
    return urllib.request.urlopen(req, timeout=timeout)


def list_tabs(host=DEFAULT_HOST, port=DEFAULT_PORT):
    """Return information for every tab (including webSocketDebuggerUrl)."""
    try:
        return json.load(_http(_base(host, port) + "/json/list"))
    except Exception:
        return []


def close_stale_tabs(host=DEFAULT_HOST, port=DEFAULT_PORT, keep_first=True,
                     settle=5, timeout=15):
    """Close every tab except the first, avoiding websocket timeouts.

    Returns how many were closed. CDP tab leaks are a very common problem ——
    every `Tab()` opens a new one, and forgetting to close it makes them pile up,
    and from around 12 they start timing out randomly, showing up as "the script works sometimes and not others".

    After closing, wait until **the tab count really drops**, instead of a fixed `settle` seconds of sleep:
    closing is asynchronous but usually finishes within tens of milliseconds, so a fixed 5-second wait is pure waste.
    `settle` is only a fallback wait once the polling has timed out.
    """
    tabs = list_tabs(host, port)
    if not tabs:
        return 0
    targets = tabs[1:] if keep_first else tabs
    want = len(tabs) - len(targets)          # the expected remaining count
    n = 0
    for t in targets:
        try:
            _http(_base(host, port) + "/json/close/" + t["id"], timeout=8).read()
            n += 1
        except Exception:
            pass
    if not n:
        return 0
    deadline = time.time() + timeout
    while time.time() < deadline:
        if len(list_tabs(host, port)) <= want:
            return n
        time.sleep(0.2)
    # Timeout fallback: in a few environments tabs linger for a while, so give one fixed wait anyway.
    time.sleep(settle)
    return n


class Tab:
    """A browser tab that can be operated and screenshotted.

    Always call `close()` on exit, or use `with Tab(...) as t:` to guarantee release.
    """

    def __init__(self, url, w=1600, h=1000, mobile=False, scale=2, wait=None,
                 host=DEFAULT_HOST, port=DEFAULT_PORT, ready=None):
        """Open a new tab and navigate to url.

        ## About `ready`

        By default it returns once `document.readyState === 'complete'` ——
        that is the **page itself** being ready, not the SiYuan UI being usable.

        The SiYuan UI is assembled from a pile of asynchronous resources (frontend assets + kernel APIs),
        so when `readyState` completes the plugin panel often is not mounted yet. Callers therefore usually pass
        another `ready` expression (a boolean expression) and return only after it turns true:

            Tab(url, ready="!!document.querySelector('.om-mm-host')")

        This way "how long to wait" is decided by a **real condition**, rather than a guessed fixed number of seconds.
        Measured: with a fixed sleep of 30 seconds the UI was in fact ready in 1.3 seconds —— 28.7 seconds wasted;
        while on a slow machine or a cold start, 30 seconds may not be enough.

        ## About `wait`

        Kept for compatibility with old callers; if passed, it sleeps that long after settling.
        Do not use it in new code —— use `ready`.
        """
        if websocket is None:
            raise RuntimeError("websocket-client is required: pip install websocket-client")
        self.host = host
        self.port = port
        # must be PUT: GET returns 405
        req = urllib.request.Request(
            _base(host, port) + "/json/new?" + url, method="PUT")
        info = json.load(urllib.request.urlopen(req, timeout=10))
        self.ws = websocket.create_connection(info["webSocketDebuggerUrl"], timeout=180)
        self._mid = 0
        self.send("Runtime.enable")
        self.send("Page.enable")
        self.send("Emulation.setDeviceMetricsOverride",
                  {"width": w, "height": h, "deviceScaleFactor": scale, "mobile": mobile})
        # First wait for the document to finish parsing, then for the specific condition the caller gives.
        self.wait_for("document.readyState === 'complete'", timeout=60)
        if ready:
            self.wait_ready(ready)
        if wait:
            time.sleep(wait)

    # ---- Low level ----
    def send(self, method, params=None):
        """Send one CDP command and wait for its response (matched by id, skipping event pushes)."""
        self._mid += 1
        self.ws.send(json.dumps({"id": self._mid, "method": method,
                                 "params": params or {}}))
        while True:
            r = json.loads(self.ws.recv())
            if r.get("id") == self._mid:
                return r.get("result", {})

    def ev(self, expr):
        """Evaluate in the page, returning the JS value (await supported)."""
        return self.send("Runtime.evaluate", {
            "expression": expr, "returnByValue": True, "awaitPromise": True,
        }).get("result", {}).get("value")

    def shot(self, path):
        """Screenshot into path (PNG)."""
        r = self.send("Page.captureScreenshot", {"format": "png"})
        with open(path, "wb") as f:
            f.write(base64.b64decode(r["data"]))
        return path

    def wait_for(self, expr, timeout=30, interval=0.4):
        """Poll until expr is true, returning its value; returns None on timeout.

        More reliable than `time.sleep(N)`: the SiYuan build completion time fluctuates,
        so a fixed wait is either too short (occasional failure) or too long (wasted time).

        Note that expr must be a **boolean expression**: this function judges "ready or not" by truthiness,
        so an expression that itself returns 0 / '' / false is treated as "not ready yet" and polled forever.
        """
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.ev(expr):
                return True
            time.sleep(interval)
        return None

    def wait_ready(self, expr, timeout=60, interval=0.3, what=None):
        """Wait for expr to turn true; on timeout it **raises**, leaving no illusion of "it looks like it ran".

        The difference from `wait_for` is the behavior on failure:
        `wait_for` returns None and callers often forget to check it, so the later assertions run against
        a page that is not ready yet, and the error they report has nothing to do with the real cause;
        `wait_ready` says outright "what was awaited and never arrived", saving one round of diagnosis.
        """
        t0 = time.time()
        if self.wait_for(expr, timeout=timeout, interval=interval):
            return time.time() - t0
        raise TimeoutError(
            f"Timed out waiting ({timeout}s): {what or expr}\n"
            f"  current URL: {self.ev('location.href')}\n"
            f"  page title: {self.ev('document.title')}")

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass

    # ---- Context management, so resources are released even on exception ----
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False
