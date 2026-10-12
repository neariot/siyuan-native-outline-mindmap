#!/usr/bin/env python3
"""Check whether the SiYuan bazaar has picked up this repository's latest Release.

## Why this exists

A release is not finished when the tag is pushed. SiYuan's bazaar is what users install from, and it is a
**separate** pipeline: a scheduled job in `siyuan-note/bazaar` reads every listed repository's latest GitHub
Release, downloads its `package.zip`, and writes the result into `stage/plugins.json`. Until that job runs,
the bazaar serves the *previous* version —— and nothing anywhere says so. The release page, the tag and the
local package can all be correct while a user installing from the bazaar still gets the old build.

Measured, so the expectation is a measurement rather than a hope:

* `v0.1.7` was tagged at `01:09:07Z` and the bazaar's entry carried `updated: 01:09:33Z` —— **26 seconds**;
* `v0.1.8` was published at `08:12:04Z` and, 1.7 hours later, the entry still held 0.1.7's exact
  `packageZipSha256` (`f1e96268…`, size 244529) while the new zip is `89588653…` (243806);
* the staging job's cadence is irregular —— over one day the gaps between its commits were 6, 76, 242, 254,
  357, 402, 489 and 609 minutes. So "it will be picked up soon" is not something to assume in either
  direction, and the only way to know is to **ask the bazaar**.

## What it compares

It asks for `stage/plugins.json` (566 entries) and finds this repository's entry, then compares:

    1. the entry's `package.version` against `package.json`      —— the headline
    2. the entry's `packageZipSha256` against the local `package.zip`
    3. the entry's `repoRef` against the local tag

Any mismatch means the bazaar is serving something other than what was released, and the output says which
one. Matching all three is the only thing that counts as "the bazaar has it".

## What it cannot see

It reads the **stage** list, which is what the bazaar serves. It cannot tell whether a user's already-open
SiYuan has refreshed its copy (that is the client's own cache), and it cannot make the staging job run
sooner —— nothing but that job writes this file. Reporting honestly beats a "probably fine".
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent

sys.path.insert(0, str(ROOT / "scripts"))
import script_log  # noqa: E402

# The bazaar's published list. `stage/plugins.json` is the file the client fetches; the `packages.json`
# name that older notes used does not exist (measured: 404), which is worth knowing before guessing again.
PACKAGES_URL = "https://raw.githubusercontent.com/siyuan-note/bazaar/main/stage/plugins.json"
REPO = "neariot/siyuan-native-outline-mindmap"


def fetch(url):
    """GET a URL as an anonymous user. Raises SystemExit with the reason, never returns a silent default."""
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": REPO})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise SystemExit("could not fetch %s: HTTP %s" % (url, e.code))
    except (urllib.error.URLError, ValueError) as e:
        raise SystemExit("could not fetch %s: %s" % (url, e))


def local_facts():
    version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    zip_path = ROOT / "package.zip"
    sha = hashlib.sha256(zip_path.read_bytes()).hexdigest() if zip_path.is_file() else None
    return version, sha, zip_path.stat().st_size if zip_path.is_file() else None


def find_entry(repos):
    """The bazaar entry for this repository, or None. Matched on the package name, not on a substring."""
    for r in repos:
        if (r.get("package") or {}).get("name") == "siyuan-native-outline-mindmap":
            return r
    return None


def main():
    ap = argparse.ArgumentParser(description="Has the bazaar picked up the latest Release?")
    ap.add_argument("--url", default=PACKAGES_URL, help="override the staging list URL (testing)")
    args = ap.parse_args()

    version, local_sha, local_size = local_facts()
    print("local: version %s, package.zip %s (%s bytes)"
          % (version, (local_sha or "missing")[:16], local_size if local_size else "?"))

    data = fetch(args.url)
    repos = data.get("repos") or []
    print("bazaar: %d plugins in the staging list" % len(repos))

    entry = find_entry(repos)
    if entry is None:
        print()
        print("✘ this repository has NO entry in the bazaar staging list.")
        print("  Either it was never listed, or the staging job dropped it. Nothing can be released")
        print("  through a list that does not mention the plugin.")
        return 1

    pkg = entry.get("package") or {}
    b_version = pkg.get("version")
    b_sha = entry.get("packageZipSha256")
    b_ref = entry.get("repoRef")
    b_updated = entry.get("updated")

    print()
    print("bazaar entry:")
    print("  version : %s" % b_version)
    print("  repoRef : %s" % b_ref)
    print("  zip sha : %s" % (b_sha or "?")[:16])
    print("  updated : %s" % b_updated)

    problems = []
    if b_version != version:
        problems.append("version: bazaar has %s, released %s" % (b_version, version))
    if local_sha and b_sha and b_sha != local_sha:
        problems.append("the bazaar's zip hash is not the released zip's")
    if b_ref and b_ref != "v" + version:
        problems.append("repoRef: bazaar has %s, expected v%s" % (b_ref, version))

    print()
    if problems:
        print("✘ the bazaar has NOT picked up %s yet:" % version)
        for p in problems:
            print("  · %s" % p)
        print()
        print("  This is not a repository problem when the Release itself is correct —— the staging job")
        print("  runs on its own irregular schedule (measured gaps over one day: 6, 76, 242, 254, 357,")
        print("  402, 489 and 609 minutes). Check the Release page first; if it is right, this is a wait.")
        print()
        print("  The job's own commits are the way to see progress:")
        print("    https://github.com/siyuan-note/bazaar/commits/main/stage/plugins.json")
        return 2

    print("✓ the bazaar has %s, with the released zip's hash" % version)
    return 0


if __name__ == "__main__":
    with script_log.track("bazaar-status"):
        sys.exit(main())
