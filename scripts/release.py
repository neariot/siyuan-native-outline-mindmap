#!/usr/bin/env python3
"""Cut a release: check every prerequisite, then tag and publish —— one command, in the right order.

## Why this exists

The 0.1.8 release was performed from prose spread across `AGENTS.md` §4, `docs/TESTING.md` and two
scripts, and reconstructing it meant reading all of them to answer "what exactly is required before a tag?"
That is a remembered procedure (AGENTS.md §8), and a remembered procedure is one that gets skipped —— the
prerequisites here are the kind that fail *silently* when skipped:

* a version bumped in one file but not the other ships a plugin that reports a number different from the one
  it was released as (`scripts/check-versions.py` exists because that happened);
* a tag pushed before the suite passed tags a commit nobody tested;
* a `package.zip` built before the last source change carries the new number and **none of the fix** ——
  `docs/TESTING.md` records exactly that, and says every external label agreed with every other one;
* a release published with material that contains a real notebook's identifier is permanent
  (`python3 scripts/audit-privacy.py --live` is the check no pattern can do).

## What it checks before touching the remote

    1. the tree is clean —— a tag must point at a commit, not at uncommitted work
    2. `package.json` and `src/plugin/plugin.json` agree, and `docs/RELEASE-<version>.md` exists
    3. `npm run check` is green
    4. `package.zip` is **byte-identical** to the build beside it (the `package-fresh` gate)
    5. the packaged `plugin.json` reports the version being released
    6. `audit-privacy.py --live` finds nothing of the user's workspace in the tree
    7. the tag does not already exist locally or on the remote

## What it does NOT do

It does not run the E2E suite, because that takes ~16 minutes and belongs in the background (AGENTS.md §1).
`--suite-log <path>` takes the log of a run you already did and refuses to continue unless it shows a green
suite —— so the evidence is required, but the waiting is yours to arrange. Without the flag it says so and
exits: a release whose suite was never run is not something this script will do quietly.

## Consent

`AGENTS.md` §4 requires the user's explicit consent for a tag, a Release, or a push. So this script does
**nothing** without `--yes`, and prints the full plan first. There is no default that publishes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

sys.path.insert(0, str(ROOT / "scripts"))
import script_log  # noqa: E402


def sh(*args, cwd=ROOT, check=True, env=None):
    """Run a command, returning (code, output). Never raises for a non-zero code when check=False."""
    proc = subprocess.run(
        args, cwd=cwd, capture_output=True, text=True, env=env, check=False
    )
    if check and proc.returncode != 0:
        raise SystemExit(
            "command failed (%d): %s\n%s%s" % (proc.returncode, " ".join(args), proc.stdout, proc.stderr)
        )
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


class Checks:
    """Collects pass/fail so every prerequisite is reported, not just the first failure."""

    def __init__(self):
        self.failures = []

    def require(self, label, ok, detail=""):
        mark = "✓" if ok else "✘"
        print("  %s %s%s" % (mark, label, ("\n      " + detail.strip().replace("\n", "\n      ")) if detail and not ok else ""))
        if not ok:
            self.failures.append(label)
        return ok


def gh_token():
    """The token, from the environment or the credentials file.

    ★ No default and no fallback chain (§5.1 #3): a wrong token fails loudly, while a chain would publish
    under whichever identity happened to resolve.
    """
    token = os.environ.get("GH_TOKEN")
    if token:
        return token
    path = pathlib.Path.home() / ".dsh" / ".credentials.yaml"
    if not path.is_file():
        raise SystemExit(
            "GH_TOKEN is not in the environment and %s does not exist. Export GH_TOKEN, or put it under "
            "`refs.GH_TOKEN` in that file." % path
        )
    try:
        import yaml
    except ImportError:
        raise SystemExit("GH_TOKEN is not in the environment and PyYAML is unavailable to read %s." % path)
    data = yaml.safe_load(path.read_text()) or {}
    token = (data.get("refs") or {}).get("GH_TOKEN")
    if not token:
        raise SystemExit("no `refs.GH_TOKEN` in %s, and no GH_TOKEN in the environment." % path)
    return token


def version():
    pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    return pkg["version"]


def suite_is_green(log_path):
    """Read a suite log and decide whether it is a pass. Returns (ok, why).

    ★ Deliberately strict: it looks for Playwright's own summary line ("N passed") **and** the absence of the
    `✘` failure marker. A truncated log —— the shape a `timeout`-killed run leaves (AGENTS.md §1) —— has
    neither, so it is rejected rather than read as "no failures".
    """
    path = pathlib.Path(log_path)
    if not path.is_file():
        return False, "%s does not exist" % path
    text = path.read_text(encoding="utf-8", errors="replace")
    summary = re.findall(r"^\s*(\d+) passed \(", text, re.M)
    if not summary:
        return False, (
            "%s has no Playwright summary line ('N passed (…)') —— a killed or truncated run keeps only the "
            "✘ markers, so this cannot be read as a pass" % path
        )
    if re.search(r"^\s*✘", text, re.M):
        return False, "%s contains ✘ failure marker(s)" % path
    if "failed" in text.split("passed")[-1][:40]:
        return False, "%s reports failures in its summary" % path
    return True, "%s passed %s case(s)" % (path.name, summary[-1])


def main():
    ap = argparse.ArgumentParser(description="Cut a release (checks first; needs --yes to publish).")
    ap.add_argument("--yes", action="store_true", help="actually tag, push and publish (AGENTS.md section 4 consent)")
    ap.add_argument("--suite-log", help="log of an E2E run to require as green evidence")
    ap.add_argument("--notes", help="release notes file (default docs/RELEASE-<version>.md)")
    ap.add_argument("--skip-push", action="store_true", help="tag and release locally-linked only; do not push main")
    args = ap.parse_args()

    v = version()
    tag = "v" + v
    notes = pathlib.Path(args.notes) if args.notes else ROOT / "docs" / ("RELEASE-%s.md" % v)

    print("release plan —— version %s, tag %s" % (v, tag))
    print("  notes: %s" % notes)
    print()

    checks = Checks()
    print("prerequisites:")

    # 1. a clean tree: a tag must point at a commit
    _, status = sh("git", "status", "--porcelain", check=False)
    checks.require("the working tree is clean", not status.strip(), status)

    # 2. the versioned sources agree and the note exists
    code, out = sh("python3", "scripts/check-versions.py", check=False)
    checks.require("check-versions.py agrees and the note exists", code == 0, out)

    # 3. every fast gate
    code, out = sh("npm", "run", "check", check=False)
    checks.require(
        "npm run check is green",
        code == 0,
        "\n".join(line for line in out.splitlines() if "FAIL" in line or "failed" in line.lower()),
    )

    # 4. the zip matches the build beside it
    pkg_zip = ROOT / "package.zip"
    if checks.require("package.zip exists", pkg_zip.is_file(), "run `npm run package`"):
        hasher = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()  # noqa: E731
        dist = ROOT / "dist-plugin" / "index.js"
        code, out = sh("python3", "scripts/verify-pkg.py", check=False)
        checks.require("package.zip is byte-identical to the build beside it", code == 0, out)
        # 5. the packaged manifest reports the version being released
        code, inner = sh("unzip", "-p", "package.zip", "plugin.json", check=False)
        reported = None
        if code == 0:
            try:
                reported = json.loads(inner)["version"]
            except Exception:  # noqa: BLE001
                reported = None
        checks.require(
            "the packaged plugin.json reports %s" % v,
            reported == v,
            "it reports %r —— the zip was built before the version bump" % reported,
        )

    # 6. privacy, with --live (the check no pattern can do)
    code, out = sh("npm", "run", "privacy", "--", "--live", check=False)
    checks.require(
        "audit-privacy.py --live finds nothing",
        code == 0,
        "\n".join(line for line in out.splitlines() if "finding" in line.lower()),
    )

    # 7. the tag does not exist yet
    code, out = sh("git", "tag", "--list", tag, check=False)
    checks.require("the tag %s does not exist locally" % tag, not out.strip(), out)
    if not args.skip_push:
        code, out = sh("git", "ls-remote", "--tags", "origin", tag, check=False)
        checks.require("the tag %s does not exist on the remote" % tag, code != 0 or not out.strip(), out)

    # 8. the suite evidence, required rather than assumed
    if args.suite_log:
        ok, why = suite_is_green(args.suite_log)
        checks.require("the E2E suite is green (%s)" % args.suite_log, ok, why)
    else:
        checks.require(
            "an E2E suite log was supplied",
            False,
            "pass --suite-log <path>. The suite takes ~16 minutes and belongs in the background; this script "
            "will not release on a suite that was never run, and will not sit and wait for it either.",
        )

    print()
    if checks.failures:
        print("REFUSING to release —— %d prerequisite(s) failed:" % len(checks.failures))
        for f in checks.failures:
            print("  · %s" % f)
        return 1

    print("every prerequisite passed.")
    if not args.yes:
        print()
        print("This is a dry run. Nothing was tagged, pushed or published —— AGENTS.md section 4 requires the")
        print("user's explicit consent. Re-run with --yes to do it:")
        print()
        print("    git push origin HEAD:main")
        print("    git tag -a %s -m '%s'" % (tag, v))
        print("    git push origin %s" % tag)
        print("    gh release create %s package.zip --title '%s' --notes-file %s" % (tag, v, notes))
        return 0

    # ---------------------------------------------------------------- publish (consent given)
    token = gh_token()
    env = dict(os.environ, GH_TOKEN=token)

    if not args.skip_push:
        print("pushing main…")
        sh("git", "push", "origin", "HEAD:main", env=env)

    print("tagging %s…" % tag)
    sh("git", "tag", "-a", tag, "-m", v)
    print("pushing %s…" % tag)
    sh("git", "push", "origin", tag, env=env)

    print("creating the Release…")
    sh("gh", "release", "create", tag, "package.zip", "--title", v, "--notes-file", str(notes), env=env)

    # Verify what was actually published, rather than trusting the command that published it.
    print()
    print("verifying the published artifact…")
    code, out = sh(
        "gh", "release", "view", tag, "--json", "tagName,isDraft,isPrerelease,assets", env=env, check=False
    )
    if code != 0:
        print("  ✘ gh release view failed:\n%s" % out)
        return 1
    info = json.loads(out)
    ok = checks.require("the Release is published (not a draft)", info.get("isDraft") is False)
    assets = {a["name"]: a["size"] for a in info.get("assets") or []}
    local = (ROOT / "package.zip").stat().st_size
    ok &= checks.require(
        "package.zip is attached with the local size",
        assets.get("package.zip") == local,
        "remote %r vs local %d" % (assets.get("package.zip"), local),
    )
    if not ok:
        return 1

    print()
    print("released: https://github.com/neariot/siyuan-native-outline-mindmap/releases/tag/%s" % tag)
    print("The bazaar reads the latest Release, so no pull request is needed.")
    return 0


if __name__ == "__main__":
    with script_log.track("release"):
        sys.exit(main())
