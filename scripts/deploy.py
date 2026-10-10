#!/usr/bin/env python3
"""Build output → deploy into the running SiYuan, and reload the plugin on the way if you like.

## Why it is needed

After changing code you have to verify it, which means manually `cp dist-plugin/*  <workspace>/data/plugins/<plugin-name>/`
and then going back into SiYuan to click reload —— a long path is hard to remember, and a script with hardcoded paths is useless on another machine.

    npm run deploy            # build + deploy
    npm run deploy -- --reload  # after deploying, make SiYuan reload the plugin

All paths come from `.env` (see `.env.example`).
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import script_log  # noqa: E402
from env import cfg  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist-plugin")
# Deploy targets always come from PLUGIN_DIRS in `.env` (see cfg.plugin_dirs); no paths are assembled here.

#: Deploy = sync **the entire build output directory** over.
#:
#: ★ It used to be a hardcoded file list (7 entries) that **missed the `i18n/` directory**.
#:   The consequences were severe: the plugin produced by `npm run deploy` lacks i18n, so the
#:   `` `${this.i18n.insertMindmap}` `` line in the plugin's `onload` throws
#:   `Cannot read properties of null` —— **the whole plugin fails to load**,
#:   with no sidebar entry and no feature at all.
#:
#:   Why it went unnoticed for so long: the user's instance is installed from the bazaar/install package, and that package is
#:   produced by `npm run package` (`zip` of the whole dist), **with i18n**;
#:   only the `npm run deploy` path was broken.
#:   It surfaced only when deploying onto a brand-new empty instance.
#:
#:   Now it is "sync by directory" —— adding a file no longer requires maintaining two lists,
#:   and the content matches the zip produced by `package` by construction.
SKIP_DIR_ENTRIES = {"__pycache__", "node_modules"}


def api(path, payload):
    """Call the SiYuan API (POST + JSON + Token auth)."""
    token = cfg.token()
    if not token:
        return None, "cannot get the API token"
    req = urllib.request.Request(
        f"{cfg.siyuan}{path}",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Token {token}",
                 "Content-Type": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r), None
    except Exception as e:
        return None, str(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reload", action="store_true",
                    help="make SiYuan reload the plugin after deploying")
    ap.add_argument("--no-build", action="store_true",
                    help="skip the build, only deploy the existing output")
    ap.add_argument("--target", action="append", default=[], metavar="DIR",
                    help="add one extra deploy target (repeatable). Regular targets come from PLUGIN_DIRS in .env.")
    ap.add_argument("--include-reference-instance", action="store_true",
                    help="also deploy into the workspace the user works in (off by default: that "
                         "installation is reference-only, see AGENTS.md 5.1)")
    ap.add_argument("--list", action="store_true",
                    help="only print which directories this run would deploy to, doing nothing else")
    args = ap.parse_args()

    if not args.no_build:
        print("  building...")
        r = subprocess.run(["npm", "run", "build"], cwd=ROOT,
                           capture_output=True, text=True)
        if r.returncode != 0:
            print(r.stdout + r.stderr)
            return 1

    if not os.path.isdir(DIST):
        print(f"  ❌ Build output not found: {DIST}")
        return 1

    # Deploy targets = PLUGIN_DIRS from `.env` (colon-separated, may be several) + the command-line --target.
    # ★ Several must be supported: two instances each hold a copy of the plugin, and deploying to only one
    #   leaves the other running tests against old code.
    dsts = cfg.plugin_dirs + [os.path.abspath(t) for t in args.target]
    # deduplicate but keep the order
    seen, uniq = set(), []
    for d in dsts:
        d = os.path.normpath(d)
        if d not in seen:
            seen.add(d)
            uniq.append(d)
    dsts = uniq

    # ★ The test instance is the only target a build may be deployed to; the workspace the user works in
    #   is **reference only**. This used to be a docstring claim in another script, which passed an
    #   unrelated variable and so deployed into the user's editor on every run. A rule that matters is a
    #   check here, not a note there.
    reference = os.path.normpath(cfg.plugin_dir)
    blocked = [d for d in dsts if os.path.normpath(d) == reference]

    if args.list:
        print(f"  Deploy targets ({len(dsts)}, from PLUGIN_DIRS in .env):")
        for d in dsts:
            note = ""
            if not os.path.isdir(d):
                note = "   (does not exist yet, will be created)"
            if os.path.normpath(d) == reference:
                note = "   ← the instance the user works in (reference only)"
            print(f"    · {d}" + note)
        if blocked and not args.include_reference_instance:
            print("  ⛔ a deploy would refuse this list; pass --include-reference-instance to include it")
        return 0

    if blocked and not args.include_reference_instance:
        for d in blocked:
            print(f"  ⛔ {d}\n     is the instance the user works in —— reference only.")
        print("  ⛔ refusing to deploy. Deploy to the test instance (PLUGIN_DIRS=<its plugin dir>), or pass")
        print("     --include-reference-instance if you really mean to install into their workspace.")
        return 2

    ok = True
    for dst in dsts:
        os.makedirs(dst, exist_ok=True)

        n = 0
        for root, dirs, files in os.walk(DIST):
            dirs[:] = [d for d in dirs if d not in SKIP_DIR_ENTRIES]
            rel = os.path.relpath(root, DIST)
            target = dst if rel == "." else os.path.join(dst, rel)
            os.makedirs(target, exist_ok=True)
            for f in files:
                shutil.copy2(os.path.join(root, f), os.path.join(target, f))
                n += 1
        print(f"  ✓ deployed {n} files → {dst}")

        # Check: the deployed index.js must be byte-for-byte identical to the build output,
        # otherwise something went wrong during the copy (a half-written case was hit once)
        a = os.path.join(DIST, "index.js")
        b = os.path.join(dst, "index.js")
        if os.path.exists(a) and os.path.exists(b):
            import hashlib
            ha = hashlib.md5(open(a, "rb").read()).hexdigest()
            hb = hashlib.md5(open(b, "rb").read()).hexdigest()
            print(f"  {'✅' if ha == hb else '❌'} index.js checksum {ha[:12]}")
            if ha != hb:
                ok = False
    if not ok:
        return 1

    if args.reload:
        res, err = api("/api/plugins/reloadPlugin", {"name": cfg.plugin_name})
        if err:
            print(f"  ⚠ Reload failed (you can reload manually inside SiYuan): {err}")
        else:
            print(f"  ✓ Reloaded plugin {cfg.plugin_name}")

    return 0


if __name__ == "__main__":
    with script_log.track("deploy"):
        sys.exit(main())
