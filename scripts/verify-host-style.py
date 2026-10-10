#!/usr/bin/env python3
"""UI-TC-02 host global styles unaffected: compare the computedStyle of host elements before and after the plugin loads.

The plugin's CSS is **injected globally** (SiYuan attaches it to the host page with <link>; there is no Shadow DOM),
so once a plugin style misses its scope it will change the host's body / .toolbar / .b3-button.

`scripts/verify-css-scope.py` only does a **static** check (whether selectors are scoped).
Static scoping **does not mean** the host styles are unchanged —— a wrong prefix, or a legitimate
global selector, is beyond what the static check can find. This case wants a **runtime** comparison:

    sample the computedStyle of host elements → mount the plugin → sample again → compare item by item

Measured: 5 elements × 13 properties, zero difference before and after.

Usage (SiYuan must be running + CDP available):
    python3 scripts/verify-host-style.py
Exit code 0 = zero difference; 1 = there is a difference (printed item by item).
"""

import sys, time, json
sys.path.insert(0,'scripts')
from cdp import Tab, close_stale_tabs
from env import cfg
import script_log

with script_log.track("verify-host-style"):
    PROPS=['font-size','margin-top','margin-bottom','margin-left','margin-right',
           'padding-top','padding-bottom','padding-left','padding-right',
           'border-top-width','border-bottom-width','border-left-width','border-right-width']
    SEL=['body','.toolbar','.b3-button','.protyle-wysiwyg','.layout__center']

    close_stale_tabs()
    # Address and port both come from .env —— the host and the port are never hardcoded.
    # Hardcoding them means that on another machine / with a changed port it connects somewhere else, or to another instance.
    t = Tab(f"{cfg.siyuan}/stage/build/desktop/", w=1400, h=900,
            ready="!!document.body", wait=120)
    time.sleep(8)

    PROPS_JSON = json.dumps(PROPS)
    SELS_JSON = json.dumps(SEL)

    # ★★ Crucial: SiYuan injects the plugin CSS **at page load** (one <style> block),
    #    so no "before the plugin loads" sampling point exists —— the first version was wrong right here:
    #    both samples were taken in the "already loaded" state, so zero difference was inevitable,
    #    and therefore **injecting a body{font-size:42px!important} would still report a pass**.
    #    A criterion that cannot catch known pollution is as good as none.
    #
    #    The right way: locate the plugin's <style> block, **take it out first** to sample the baseline,
    #    then put it back to sample the comparison. That is what makes the two samples a real before/after.
    FIND_PLUGIN_STYLE = """(() => {
      const ss = [...document.querySelectorAll('style')];
      // The plugin's CSS always carries the .om-mm- prefix (build-time scoping is enforced, guarded by verify-css-scope.py)
      for (let i = 0; i < ss.length; i++) {
        if ((ss[i].textContent || '').includes('.om-mm-')) return String(i);
      }
      return '-1';
    })()"""

    idx = t.ev(FIND_PLUGIN_STYLE)
    if idx == '-1':
        print("  ❌ Plugin style block not found (run npm run deploy first and enable the plugin in SiYuan)")
        t.close()
        sys.exit(2)
    print(f"  ── Located the plugin style block <style> #{idx}")

    SNIP = """(() => {
      const props = %s, sels = %s, out = {};
      for (const s of sels) {
        const el = document.querySelector(s);
        if (!el) { out[s] = '(missing)'; continue; }
        const cs = getComputedStyle(el), o = {};
        for (const p of props) o[p] = cs.getPropertyValue(p);
        out[s] = o;
      }
      return JSON.stringify(out);
    })()""" % (PROPS_JSON, SELS_JSON)

    # ① take the plugin styles out → sample the baseline
    t.ev(f"(() => {{ const s=document.querySelectorAll('style')[{idx}]; s.dataset.__omSaved=s.textContent; s.textContent=''; }})()")
    time.sleep(1.5)
    before = json.loads(t.ev(SNIP))
    print("  ── Sampled the host styles with the plugin styles removed")

    # ② put them back → sample the comparison
    t.ev(f"(() => {{ const s=document.querySelectorAll('style')[{idx}]; s.textContent=s.dataset.__omSaved||''; }})()")
    time.sleep(1.5)
    after = json.loads(t.ev(SNIP))
    print("  ── Sampled the host styles with the plugin styles put back")

    diffs = []
    for sel in before:
        if not isinstance(before[sel], dict) or not isinstance(after.get(sel), dict):
            continue
        for p in before[sel]:
            if before[sel][p] != after[sel][p]:
                diffs.append((sel, p, before[sel][p], after[sel][p]))

    print()
    if not diffs:
        print("  ✅ Zero host style differences —— UI-TC-02 passes")
        rc = 0
    else:
        print(f"  ❌ Found {len(diffs)} differences (the plugin styles changed the host):")
        for sel, p, b, a in diffs:
            print(f"     {sel} {p}: {b} → {a}")
        rc = 1
    t.close()
    # ★ An exit code is mandatory, otherwise this script "passes" forever and serves no purpose as a gate (the first version missed it)
    sys.exit(rc)
