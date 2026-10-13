#!/usr/bin/env python3
"""Build output → deploy into the running SiYuan, and reload the plugin on the way if you like.

## Why it is needed

After changing code you have to verify it, which means manually `cp dist-plugin/*  <workspace>/data/plugins/<plugin-name>/`
and then going back into SiYuan to click reload —— a long path is hard to remember, and a script with hardcoded paths is useless on another machine.

    npm run deploy            # build + deploy into **both** instances (--test-only for just the
                              #   working one; use it whenever the build is deliberately broken)

★ There is no `--reload`. SiYuan serves no route for reloading a plugin: `/api/plugins/reloadPlugin`, which
this script used to post to, answers **404** (measured), and the failure was printed as a warning with exit
0, so a deploy that reloaded nothing reported success. Reload from SiYuan's plugin panel, or restart the
kernel --- both pick the new build up, and neither can be done from here.

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


def list_deploy_targets(test_only: bool) -> list:
    """Every directory a deploy would install into, as this script's own `--list` reports it.

    ★ A subprocess on purpose. The answer has to be the one the command line gives —— `--test-only`
      included -- rather than a second implementation of the target rule, because a second copy of that
      rule is exactly what drifted: `--target` only **adds** a target and `PLUGIN_DIRS` is never read,
      so a helper that believed it had narrowed the deploy by setting that variable narrowed nothing,
      and the instance the user works in was written anyway.

    ★ The flag is passed through, and it changes the answer: `--list` on its own still reports the
      instance the user works in, so asking without `--test-only` compares two targets against one
      and fails while the narrowing in fact works.
    """
    cmd = [sys.executable, os.path.abspath(__file__), "--list"]
    if test_only:
        cmd.append("--test-only")
    done = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    output = (done.stdout or "") + (done.stderr or "")
    targets = []
    for line in output.splitlines():
        line = line.strip()
        if line.startswith("\u00b7"):
            # "\u00b7 <path>", optionally followed by an annotation. Only an absolute path is a target:
            # --list also prints a note line beginning the same way, and reading that as a directory
            # makes a guard report a target that is not one.
            path = line[1:].split("\u2190")[0].strip()
            if path.startswith("/"):
                targets.append(path)
    return targets


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-build", action="store_true",
                    help="skip the build, only deploy the existing output")
    ap.add_argument("--target", action="append", default=[], metavar="DIR",
                    help="add one extra deploy target (repeatable). Regular targets come from PLUGIN_DIRS in .env.")
    ap.add_argument("--test-only", action="store_true",
                    help="skip the instance the user works in. ★ Use this for a red proof: a deliberately "
                         "broken build must not reach the editor they use (AGENTS.md section 7)")
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

    # ★ Both instances are deployment targets **by default**: the build under test and the one the user
    #   works in, so the editor they use is never left running old code while the tests run against new
    #   code. `--test-only` is the exception, and it exists for one reason —— a red proof deliberately
    #   breaks the plugin, and that build must not reach the editor they use (AGENTS.md section 7).
    reference = os.path.normpath(cfg.plugin_dir)
    if args.test_only:
        dsts = [d for d in dsts if d != reference]
        print("  · --test-only: the instance you work in is left alone (a red proof must not reach it)")
    elif reference not in dsts:
        dsts.append(reference)

    if args.list:
        print(f"  Deploy targets ({len(dsts)}, PLUGIN_DIRS from .env plus the instance you work in):")
        for d in dsts:
            note = "   ← the instance you work in" if d == reference else ""
            if not os.path.isdir(d):
                note += "   (does not exist yet, will be created)"
            print(f"    · {d}" + note)
        return 0

    if reference in dsts:
        print("  ★ this build also goes to the instance you work in (--test-only to skip it)")

    # ★ State the target list and count BEFORE copying: the AGENTS section 7 check is "confirm the
    #   printed deploy: N target(s) list before the check runs" — per-target lines after the fact
    #   do not satisfy a check that must pass before anything is written.
    print(f"  Deploy targets ({len(dsts)}):")
    for d in dsts:
        note = "   ← the instance you work in" if d == reference else ""
        print(f"    · {d}" + note)

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

    return 0


if __name__ == "__main__":
    with script_log.track("deploy"):
        sys.exit(main())
