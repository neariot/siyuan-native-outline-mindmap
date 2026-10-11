#!/usr/bin/env python3
"""Live smoke verification: these few things **must** have a real browser to be confirmed.

## Why this script exists separately

The vast majority of assertions go through `npm test` (offline, 2 seconds, stricter). But there are three
kinds of things that cannot be tested offline and need a real browser:

  1. **Whether CSS really takes effect** —— who wins in the cascade / `@media` / `!important`
     can only be decided by a real CSS engine. A rule written inside `@media` made the
     desktop side lose everything, and `!important` hid SiYuan's own editor entirely.
  2. **Whether `ResizeObserver` really fires** —— whether the mind map re-fits after the panel width is dragged.
  3. **The round trip with the SiYuan kernel** —— whether the kramdown written back is the shape we want.

## Usage

    python3 scripts/verify-live.py                # run everything
    python3 scripts/verify-live.py css            # run only the CSS-related parts
    python3 scripts/verify-live.py --doc <docId>  # specify a document

Requires: SiYuan running and Chromium with the CDP port open.
The address and port come from `.env` (template in `.env.example`) and are no longer hardcoded.
"""

import argparse
import json
import os
import time
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Tab, close_stale_tabs  # noqa: E402
from env import cfg  # noqa: E402
import script_log  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

results = []


def content_follows_panel(host_w, content_w, tolerance=8.0):
    """Whether the content is as wide as the panel that contains it.

    ★ This is a **comparison**, and it used to be `'"host" in result` —— a criterion the returned JSON
      satisfies whatever the two widths are, so the regression it was written for (a hardcoded
      `max-width: 860px`, after which content stopped growing when the panel was dragged wider) passed.
      The tolerance is for a border or a scrollbar, not for a cap: a cap is what the finding is.
    """
    if host_w is None or content_w is None or host_w <= 0:
        return False
    return content_w >= host_w - tolerance


def panel_width_verdict(raw):
    """`(ok, detail)` for the panel-width check, from the raw JSON the page returned."""
    try:
        m = json.loads(raw or "")
        host_w = float(m["host"])
        content_w = float(m["content"])
    except (TypeError, ValueError, KeyError):
        # Loudly, not silently: a missing measurement is not a passing one.
        return False, f"no usable measurement: {raw!r}"
    return content_follows_panel(host_w, content_w), f"host={host_w:.0f} content={content_w:.0f}"


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"  {'✅' if ok else '❌'} {name}" + (f"  {detail}" if detail else ""))


def open_plugin(tab):
    """Ensures the plugin panel is open (the Dock icon may never have been clicked)."""
    active = tab.ev("""(() => {
      const d = document.querySelector('[data-type*="native-outline"]');
      return !!(d && d.classList.contains('dock__item--active'));
    })()""")
    if not active:
        tab.ev("""(() => {
          const d = document.querySelector('[data-type*="native-outline"]');
          if (d) d.click();
        })()""")
        tab.wait_ready("!!document.querySelector('.om-mm-host')", timeout=30,
                       what="plugin panel (.om-mm-host should be mounted after clicking the Dock)")


def run_css(tab):
    """Whether CSS really takes effect —— every one of these was a real bug."""
    print("\n[CSS effectiveness]")

    # ① Mobile-only controls must be hidden on desktop.
    #    It once was: these classes were written only inside @media(max-width:768px),
    #    so on desktop they showed up precisely because 'there was no rule', producing two toolbars, top and bottom.
    r = tab.ev("""(() => {
      const cls = ['.mobile-keyboard-bar','.mobile-format-drawer','.mobile-bar-main',
                   '.mobile-bar-scroll','.mobile-bar-fixed','.mobile-color-subbar',
                   '.mobile-color-swatch'];
      const shown = cls.filter(c => {
        const e = document.querySelector(c);
        return e && getComputedStyle(e).display !== 'none';
      });
      return JSON.stringify({shown});
    })()""")
    check("desktop does not show the mobile toolbar", r and '"shown":[]' in r.replace(" ", ""), r or "no result")

    # ② Icons must not be painted into solid squares by SiYuan's `svg { fill: currentColor }`.
    #    `.om-mm-host svg[fill="none"]` must explicitly push it back.
    r = tab.ev("""(() => {
      const host = document.querySelector('.om-mm-host');
      if (!host) return 'no host';
      const bad = [...host.querySelectorAll('svg[fill="none"]')]
        .filter(s => getComputedStyle(s).fill !== 'none').length;
      const total = host.querySelectorAll('svg[fill="none"]').length;
      return JSON.stringify({bad, total});
    })()""")
    check("icon fill:none takes effect", r and '"bad":0' in r.replace(" ", ""), r or "no result")

    # ③ Content width must follow the panel and must not stick at a fixed value.
    #    It once hardcoded max-width:860px, so content stopped growing after the panel was dragged wider.
    r = tab.ev("""(() => {
      const host = document.querySelector('.om-mm-host');
      const ti = document.querySelector('.outliner-title')
              || document.querySelector('.om-outline');
      if (!host || !ti) return 'no element';
      return JSON.stringify({
        host: Math.round(host.getBoundingClientRect().width),
        content: Math.round(ti.getBoundingClientRect().width),
      });
    })()""")
    ok, detail = panel_width_verdict(r)
    check("content width follows the panel", ok, detail)

    # ④ SiYuan's own editor must not be hidden.
    #    It once had `[contenteditable]{display:none!important}` with no scope,
    #    so the mobile side hid 66 elements, including .protyle-wysiwyg.
    #    ⚠️ Only judge 'not hidden'; do not assert whether it is block or flex ——
    #       `.protyle-wysiwyg` is normally flex, and hardcoding block reports a false positive.
    r = tab.ev("""(() => {
      const w = document.querySelector('.protyle-wysiwyg');
      if (!w) return JSON.stringify({found: false});
      const d = getComputedStyle(w).display;
      return JSON.stringify({found: true, display: d, hidden: d === 'none'});
    })()""")
    check("SiYuan editor is not hidden",
          r is not None and ('"hidden":false' in r.replace(" ", "")
                             or '"found":false' in r.replace(" ", "")),
          r or "no result")


def run_resize(tab):
    """Whether ResizeObserver really re-fits."""
    print("\n[Size adaptation]")

    tab.ev("""(() => {
      const b = document.querySelectorAll('.om-mm-viewswitch button')[1];
      if (b) b.click();
    })()""")
    tab.wait_ready("!!document.querySelector('.mm-canvas svg g[transform]')",
                   timeout=25, what="mind map canvas (should appear after clicking the mind map tab)")

    before = tab.ev("""(() => {
      const g = document.querySelector('.mm-canvas svg g[transform]');
      return g ? g.getAttribute('transform') : null;
    })()""")

    tab.ev("""(() => {
      const c = document.querySelector('.mm-canvas');
      if (c) { c.style.width = '300px'; c.style.flex = 'none'; }
    })()""")
    tab.wait_for("(() => { const g = document.querySelector('.mm-canvas svg g[transform]');"
                 " return g && g.getAttribute('transform') !== "
                 + repr(before).replace("'", '"') + "; })()", timeout=8)

    after = tab.ev("""(() => {
      const g = document.querySelector('.mm-canvas svg g[transform]');
      return g ? g.getAttribute('transform') : null;
    })()""")
    check("automatic re-fit after the container changes", before != after, f"{before} → {after}")

    # ── Relationship to SiYuan's splitter (the final criterion for root cause 2.3)────────────────────
    #
    # agy once conjectured that `.mm-canvas`'s `touch-action: none` '1px overlaps' the host's
    # `.layout__resize` hot zone, making it undraggable. Measurement ruled that **does not hold** (see .tmp/rc-2-3-verdict.md):
    #   · rectangle overlap area 0 (hot zone right edge 762, canvas left edge 762, adjacent not intersecting);
    #   · really dragging 150px moved the panel width by exactly +150, no failure.
    # Both are pinned here as checks, to prevent a real overlap from being introduced inadvertently when the CSS is changed later.
    geo = tab.ev("""JSON.stringify((() => {
      const c = document.querySelector('.mm-canvas');
      const out = { canvas: null, overlap: 0, resizers: [] };
      if (!c) return JSON.stringify(out);
      const cb = c.getBoundingClientRect();
      out.canvas = { l: Math.round(cb.left), w: Math.round(cb.width) };
      for (const e of document.querySelectorAll('.layout__resize--lr')) {
        const b = e.getBoundingClientRect();
        if (b.width <= 0) continue;
        out.resizers.push({ l: Math.round(b.left), w: Math.round(b.width) });
        const ox = Math.max(0, Math.min(cb.right, b.right) - Math.max(cb.left, b.left));
        const oy = Math.max(0, Math.min(cb.bottom, b.bottom) - Math.max(cb.top, b.top));
        out.overlap += ox * oy;
      }
      return JSON.stringify(out);
    })())""")

    # ev() may already have turned the JS result into a Python object; it may also be a string — handle both.
    # (JSON.stringify is written in the JS, so if the outer layer converts it once more you get a string of a **string**.)
    g = geo
    for _ in range(3):
        if isinstance(g, str):
            try:
                g = json.loads(g)
            except Exception:
                break
        else:
            break
    if not isinstance(g, dict):
        g = {}

    if g.get("canvas") and g.get("resizers"):
        check("★ the mind map canvas and SiYuan's splitter hot zone **do not overlap** (root cause 2.3 does not hold)",
              g["overlap"] == 0,
              f"overlap {g['overlap']} px², hot zone {g['resizers']}")
        # The canvas must be to the **right** of the hot zone (adjacent, not intersecting)
        right_most = max(r["l"] + r["w"] for r in g["resizers"])
        check("★ canvas left edge ≥ hot zone right edge (adjacency)",
              g["canvas"]["l"] >= right_most - 1,
              f"canvas.l={g['canvas']['l']} hot zone right edge={right_most}")
    else:
        check("★ the mind map canvas and SiYuan's splitter hot zone do not overlap", False,
              "could not obtain canvas or hot zone geometry (the selectors may have changed)")


def run_color(tab):
    """Colors must really travel from SiYuan to the mind map (the original bug)."""
    print("\n[Color sync]")

    tab.ev("""(() => {
      const b = document.querySelectorAll('.om-mm-viewswitch button')[1];
      if (b) b.click();
    })()""")
    tab.wait_ready("!!document.querySelector('.mm-canvas')", timeout=25,
                   what="mind map canvas (.mm-canvas)")

    r = tab.ev("""(() => {
      const c = document.querySelector('.mm-canvas');
      if (!c) return 'no canvas';
      // a tspan with an explicit color is the evidence that the fix works (previously it degraded into a single plain text node)
      const colored = [...c.querySelectorAll('tspan')]
        .filter(e => e.getAttribute('fill'))
        .map(e => ({txt: e.textContent, fill: getComputedStyle(e).fill}));
      return JSON.stringify(colored.slice(0, 8));
    })()""")
    check("colored tspans exist in the mind map",
          r and "fill" in r and r != "[]", r or "no result")


def _plugin_style_index(tab):
    """Locates the <style> block injected by the plugin (identified by the .om-mm- prefix)."""
    return tab.ev("""(() => {
      const ss = [...document.querySelectorAll('style')];
      for (let i = 0; i < ss.length; i++) {
        if ((ss[i].textContent || '').includes('.om-mm-')) return String(i);
      }
      return '-1';
    })()""")


def run_theme_isolation(tab):
    """UI-TC-04 theme light/dark variable isolation.

    Asserts two things:
      ① the plugin's `--bg` follows the host's `--b3-theme-background`;
      ② the plugin writes no custom properties into SiYuan's `:root`.

    ★ Switching the theme must **swap theme.css's href**; changing only the `data-theme-mode` attribute is not enough:
      when only the attribute was changed in practice, the attribute changed and `html[data-theme-mode=dark] .om-mm-host`
      matched the element too, yet `--bg` did not move at all —— because the host's
      `--b3-theme-background` was still #fff. The plugin is waiting on the host variable, and the host variable
      is not recomputed from the attribute.

      ⇒ **First confirm the host itself changed, then assert whether the plugin followed.** If the host did not
        change, there is no basis for saying the plugin failed to respond (that is a false negative, not a defect).
    """
    print("\n[Theme variable isolation UI-TC-04]")

    idx = _plugin_style_index(tab)
    if idx == '-1':
        check("plugin style block located", False, "deploy and enable the plugin first")
        return
    check("plugin style block located", True, f"<style> #{idx}")

    def theme_state():
        return {
            "host_bg": tab.ev("getComputedStyle(document.documentElement)"
                              ".getPropertyValue('--b3-theme-background')").strip(),
            "plugin_bg": tab.ev("getComputedStyle(document.querySelector('.om-mm-host'))"
                                ".getPropertyValue('--bg')").strip(),
        }

    before = theme_state()

    # Swap theme.css's target + change the attribute (SiYuan's real theme-switching action)
    switched = tab.ev("""(() => {
      const l = [...document.querySelectorAll('link[rel=stylesheet]')]
        .find(x => x.href.includes('theme'));
      if (!l) return 'no-theme-link';
      l.href = l.href.replace('/daylight/', '/midnight/');
      document.documentElement.setAttribute('data-theme-mode', 'dark');
      return 'switched';
    })()""")
    time.sleep(4)
    after = theme_state()

    host_changed = before["host_bg"] != after["host_bg"]
    check("the host theme really switched (otherwise the plugin's response cannot be discussed)", host_changed,
          f"{before['host_bg']} → {after['host_bg']}")
    if host_changed:
        check("plugin --bg follows the host variable", after["plugin_bg"] == after["host_bg"],
              f"host {after['host_bg']} / plugin {after['plugin_bg']}")
        # Switch back to light so later checks are not affected
        tab.ev("""(() => {
          const l = [...document.querySelectorAll('link[rel=stylesheet]')]
            .find(x => x.href.includes('theme'));
          if (l) l.href = l.href.replace('/midnight/', '/daylight/');
          document.documentElement.setAttribute('data-theme-mode', 'light');
        })()""")
        time.sleep(3.5)

    # ② :root dirtied variables
    dump = """JSON.stringify((() => {
      const cs = getComputedStyle(document.documentElement), o = {};
      for (const n of cs) if (n.startsWith('--')) o[n] = cs.getPropertyValue(n).trim();
      return o;
    })())"""
    tab.ev(f"(() => {{ const s=document.querySelectorAll('style')[{idx}];"
           " s.dataset.__omSv=s.textContent; s.textContent=''; })()")
    time.sleep(1.2)
    without = json.loads(tab.ev(dump))
    tab.ev(f"(() => {{ const s=document.querySelectorAll('style')[{idx}];"
           " s.textContent=s.dataset.__omSv||''; })()")
    time.sleep(1.2)
    with_ = json.loads(tab.ev(dump))

    added = [k for k in with_ if k not in without]
    changed = [k for k in with_ if k in without and with_[k] != without[k]]
    check("no new variables written into SiYuan's :root", not added, f"added {added[:4]}" if added else "")
    check("no existing SiYuan :root variables modified", not changed, f"modified {changed[:4]}" if changed else "")


def run_host_isolation(tab):
    """UI-TC-02 host global styles unaffected: the plugin's CSS must not change the host's body/.toolbar.

    Why a real browser is required: the plugin's CSS is **injected globally** (there is no Shadow DOM),
    so whether the host was changed is decided only by the real CSS cascade. Statically checking 'are the selectors scoped'
    (verify-css-scope.py) is not the same as the host styles being unchanged.

    ★ How to take the baseline: the plugin CSS in SiYuan is already injected **at page load**,
      so there is no 'before the plugin loaded' moment. That <style> block must be
      **removed first** to sample the baseline, then put back to sample the comparison —— otherwise the two samples are bound to be identical,
      and even stuffing `body{font-size:42px!important}` into the artifacts cannot be detected (tripped over in practice).
    """
    print("\n[Host styles unaffected UI-TC-02]")

    props = ["font-size", "margin-top", "margin-bottom", "margin-left",
             "margin-right", "padding-top", "padding-bottom", "padding-left",
             "padding-right", "border-top-width", "border-bottom-width",
             "border-left-width", "border-right-width"]

    idx = tab.ev("""(() => {
      const ss = [...document.querySelectorAll('style')];
      for (let i = 0; i < ss.length; i++) {
        if ((ss[i].textContent || '').includes('.om-mm-')) return String(i);
      }
      return '-1';
    })()""")
    check("plugin style block located", idx != '-1', f"<style> #{idx}")
    if idx == '-1':
        return

    snip = """(() => {
      const props = %s, sels = %s, out = {};
      for (const s of sels) {
        const el = document.querySelector(s);
        if (!el) { out[s] = '(not present)'; continue; }
        const cs = getComputedStyle(el), o = {};
        for (const p of props) o[p] = cs.getPropertyValue(p);
        out[s] = o;
      }
      return JSON.stringify(out);
    })()""" % (json.dumps(props), json.dumps(["body", ".toolbar", ".b3-button",
                                             ".protyle-wysiwyg", ".layout__center"]))

    tab.ev(f"(() => {{ const s=document.querySelectorAll('style')[{idx}];"
           " s.dataset.__omSaved=s.textContent; s.textContent=''; })()")
    time.sleep(1.2)
    before = json.loads(tab.ev(snip))

    tab.ev(f"(() => {{ const s=document.querySelectorAll('style')[{idx}];"
           " s.textContent=s.dataset.__omSaved||''; })()")
    time.sleep(1.2)
    after = json.loads(tab.ev(snip))

    diffs = []
    for sel in before:
        if not isinstance(before[sel], dict) or not isinstance(after.get(sel), dict):
            continue
        for p in before[sel]:
            if before[sel][p] != after[sel][p]:
                diffs.append(f"{sel} {p}: {before[sel][p]} → {after[sel][p]}")

    check("zero style differences on the host's body/.toolbar/.b3-button etc.", not diffs,
          "" if not diffs else f"{len(diffs)} places: {'; '.join(diffs[:4])}")


def selftest():
    """The panel-width criterion, on measurements that need no desktop.

    The last three cases are the point: the **old** criterion (`'"host" in raw`) passed all of them, so it
    could not fail for the regression it named.
    """
    cases = [
        ('{"host":1000,"content":1000}', True, "content fills the panel"),
        ('{"host":1000,"content":994}', True, "a border's worth of difference"),
        ('{"host":1000,"content":860}', False, "★ the regression: content capped at 860 while the panel grew"),
        ('{"host":1000,"content":700}', False, "content narrower still"),
        ('{"host":1000}', False, "★ no measurement of the content at all"),
        ("no element", False, "★ the page could not find the elements"),
        (None, False, "★ no result from the page"),
        ('{"host":0,"content":0}', False, "a zero-width host measures nothing"),
    ]
    bad = 0
    for raw, expected, why in cases:
        ok, detail = panel_width_verdict(raw)
        mark = "✅" if ok == expected else "❌"
        if ok != expected:
            bad += 1
        print(f"  {mark} {why}" + ("" if ok == expected else f" (expected {expected}, got {ok}: {detail})"))
    print(f"selftest: {'PASS' if bad == 0 else 'FAIL'} ({len(cases)} case(s), {bad} failed)")
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("which", nargs="?", default="all",
                    help="css / resize / color / host / theme / all")
    ap.add_argument("--doc", default=None, help="document id")
    ap.add_argument("--selftest", action="store_true",
                    help="the panel-width criterion, on measurements, with no desktop needed")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    doc = args.doc
    if not doc:
        p = os.path.join(ROOT, ".tmp", "demo-docid.txt")
        if os.path.exists(p):
            doc = open(p).read().strip()
    if not doc:
        print("--doc <docId> is required (or .tmp/demo-docid.txt)")
        return 1

    n = close_stale_tabs()
    if n:
        print(f"cleaned up {n} stale tabs")

    url = cfg.build_url("desktop", doc)
    print(f"opening {url}")
    # the desktop build takes about 26-30 seconds
    with Tab(url, w=1600, h=1000, wait=30) as tab:
        open_plugin(tab)
        if args.which in ("all", "css"):
            run_css(tab)
        if args.which in ("all", "resize"):
            run_resize(tab)
        if args.which in ("all", "color"):
            run_color(tab)
        if args.which in ("all", "host"):
            run_host_isolation(tab)
        if args.which in ("all", "theme"):
            run_theme_isolation(tab)

    bad = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(bad)}/{len(results)} passed "
          + ("✅" if not bad else "❌"))
    return 0 if not bad else 1


if __name__ == "__main__":
    with script_log.track("verify-live"):
        sys.exit(main())
