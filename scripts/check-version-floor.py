#!/usr/bin/env python3
"""The plugin's minimum SiYuan version, derived from the **official release tags** rather than remembered.

## Why this exists

`src/plugin/plugin.json` declares `minAppVersion`, and `src/siyuan/host-compat.ts` carries version
constants (e.g. the release that introduced `/api/block/updateTaskListItemMarker`). Both are claims
about **upstream SiYuan**, and both were wrong when written from memory:

    TASK_MARKER_API_MIN_VERSION = '3.1.0'   ← actually introduced in v3.6.4

Five minor releases off, and the value decides whether the native call is even attempted, so every
to-do toggle on a 3.1.0–3.6.3 kernel spent a round trip on a 404 first.

## ★ Read the release tags, not a development checkout

`SIYUAN_SRC` may point anywhere: a fork, a branch, a working tree with local patches. The checked-out
commit is therefore **not** a statement about what users run —— on this machine it is a fork branch
commit that is in no release tag at all, and it changes `kernel/api/router.go` and the generated API
contract relative to the released v3.8.6.

So this reads `git show <tag>:...` for every **stable** tag (`vX.Y.Z`, no `-alpha`/`-beta`/`-rc`),
which is a pure object read: no checkout, no build, no network. The tag objects themselves are
verified against the official repository through the `upstream` remote when it is configured, so a
fork's re-tagged commits cannot silently become the baseline.

## Usage

    python3 scripts/check-version-floor.py            # report the measured floor and the constants
    python3 scripts/check-version-floor.py --selftest # fixture cases for the parser

## Exit code

0 when the declared values agree with the measurement, 1 otherwise (naming each disagreement).
Skips (exit 0, saying what could not be checked) when `SIYUAN_SRC` is unset —— an absent checkout is
an explicit "this machine does not have it", not a licence to guess.
"""

import argparse
import io
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import env  # noqa: E402
import script_log  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent

# The routes the plugin actually calls, and where in the kernel each is declared. `router.go` holds
# every `ginServer.Handle("POST", "/api/...", ...)` line; the block routes are there too.
ROUTER = "kernel/api/router.go"

# ★ Only v3+ tags are considered. The clone carries 404 stable tags, but 313 of them predate the
#   file this reads (`git cat-file -e v0.1.0:kernel/api/router.go` → "exists on disk, but not in
#   'v0.1.0'"), and the plugin's own `minAppVersion` starts at 3.x. Scanning them would report 313
#   "tag(s) with no route table" and say nothing about the range a user could actually run.
MIN_MAJOR = 3

# Constants in the product that are claims about upstream, and the route each one is about.
CONSTANT_CLAIMS = [
    ("src/siyuan/host-compat.ts", "TASK_MARKER_API_MIN_VERSION", "/api/block/updateTaskListItemMarker"),
]

# ★ Endpoints that are **guarded**: the product checks the kernel version (or degrades on failure)
#   before relying on them, so they do NOT raise `minAppVersion` —— the plugin still works, one path
#   poorer, on a kernel that lacks them. Each entry names the guard, which this script verifies
#   exists, so "it is guarded" is a checkable claim rather than an assertion.
GUARDED_ENDPOINTS = {
    "/api/block/updateTaskListItemMarker": (
        "src/siyuan/host-compat.ts",
        "supportsTaskMarkerApi",
        "a kernel without it takes the markdown path (and an unknown version attempts the call)",
    ),
}

STABLE_TAG = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
# ★ Also accepts the bare form: `minAppVersion` in plugin.json is written without the `v`
#   ("3.1.14"), while a tag is "v3.1.14". Requiring the prefix silently made every declared value
#   compare as (0,0,0) —— so the gate reported "below the floor" for a value that WAS the floor.
SEMVER = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")


def tag_key(tag: str) -> tuple[int, int, int]:
    m = SEMVER.match(tag)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else (0, 0, 0)


def git(src: Path, *args: str) -> str:
    res = subprocess.run(["git", *args], cwd=src, capture_output=True, text=True, check=False)
    return res.stdout if res.returncode == 0 else ""


def stable_tags(src: Path, min_major: int = MIN_MAJOR) -> list[str]:
    """Stable `vX.Y.Z` tags at or above `min_major`, oldest first."""
    tags = [
        t for t in git(src, "tag", "-l").split("\n")
        if STABLE_TAG.match(t) and tag_key(t)[0] >= min_major
    ]
    return sorted(tags, key=tag_key)


def endpoints_called() -> set[str]:
    """Every `/api/...` literal the client module calls, so a new call is covered automatically."""
    found: set[str] = set()
    for rel in ("src/siyuan/api.ts", "src/siyuan/virtual-kernel.ts"):
        p = REPO_ROOT / rel
        if p.is_file():
            found.update(re.findall(r"['\"](/api/[A-Za-z0-9_/]+)['\"]", p.read_text(encoding="utf-8")))
    return found


def client_methods() -> dict[str, str]:
    """`{client method name: endpoint}` from `src/siyuan/api.ts`."""
    p = REPO_ROOT / "src" / "siyuan" / "api.ts"
    if not p.is_file():
        return {}
    text = p.read_text(encoding="utf-8")
    out: dict[str, str] = {}
    for m in re.finditer(
        r"\n  (?:async )?([a-zA-Z][A-Za-z0-9_]*)\s*\([^)]*\)\s*:\s*Promise<[^>]*>\s*\{\s*\n\s*return this\.post<[^>]*>\(\s*['\"](/api/[A-Za-z0-9_/]+)",
        text,
    ):
        out[m.group(1)] = m.group(2)
    return out


def unreached_methods() -> dict[str, str]:
    """`{endpoint: client method}` for a method **no shipped file outside api.ts calls**.

    ★ This is deliberately a *report*, not a failure. A client method may be public API for a caller
      outside this repository, so "no call site" is not the same as "dead" —— `check-dead-methods.py`
      takes the same posture. It matters here because the floor is derived from endpoints the plugin
      is assumed to reach: an endpoint only a never-called wrapper mentions does not really raise the
      minimum.

    ★★ `api.ts` is excluded from the scanned set, so every `.<name>(` found elsewhere **is** a real
      call site —— including `this.client.<name>(` inside `store.ts`, which is exactly how the store
      reaches the kernel. An earlier version also skipped any line containing `this.client.`, on the
      mistaken idea that such a line was the wrapper's own body: that wrapper lives in `api.ts`, so
      the rule discarded the genuine call sites and reported six live endpoints as unreached.

    ★ The limit, stated rather than hidden: this is a one-level check. It sees that a name is never
      mentioned outside `api.ts`; it cannot follow a chain through a variable, a dynamic key, or a
      callback registry. A name mentioned nowhere else is reported, and a reader decides.
    """
    methods = client_methods()
    shipped = [
        p for p in (REPO_ROOT / "src").rglob("*.ts*")
        if not p.name.endswith(".test.ts") and p.name != "api.ts"
    ]
    corpus = "\n".join(p.read_text(encoding="utf-8") for p in shipped)
    out: dict[str, str] = {}
    for name, ep in methods.items():
        if not re.search(r"\.\s*" + re.escape(name) + r"\s*\(", corpus):
            out[ep] = name
    return out


def read_router_tables(src: Path, tags: list[str]) -> dict[str, str]:
    """`{tag: router.go text}` for every tag —— **one** git process, partial reads only.

    ★ Measured: 404 tags × 21 endpoints via `git show` is 8 000+ subprocess spawns and takes minutes;
      one `git cat-file --batch` over the same 404 objects is 0.024s. Nothing is checked out and no
      release archive is downloaded —— each object is the single file `kernel/api/router.go`, read
      straight out of the repository that is already on disk.
    """
    if not tags:
        return {}
    req = "".join(f"{t}:{ROUTER}\n" for t in tags).encode()
    res = subprocess.run(
        ["git", "cat-file", "--batch"], cwd=src, input=req,
        capture_output=True, check=False,
    )
    if res.returncode != 0:
        return {}

    out: dict[str, str] = {}
    buf = res.stdout
    pos = 0
    for t in tags:
        nl = buf.find(b"\n", pos)
        if nl < 0:
            break
        header = buf[pos:nl].decode("utf-8", "replace").split()
        pos = nl + 1
        if len(header) < 3 or header[1] != "blob":
            # `<obj> missing` —— this tag has no such file (or is not a commit here)
            continue
        size = int(header[2])
        out[t] = buf[pos:pos + size].decode("utf-8", "replace")
        pos += size + 1  # the trailing newline git writes after the payload
    return out


def introduction(tables: dict[str, str], tags: list[str], endpoint: str) -> str | None:
    """The first stable tag whose route table declares `endpoint`."""
    needle = f'"{endpoint}"'
    for t in tags:
        if needle in tables.get(t, ""):
            return t
    return None


def verify_tags_are_official(src: Path, tags: list[str]) -> tuple[bool, str]:
    """★ Check the tags resolve to the official repository, when it is reachable.

    A tag name is not an identity: a fork may create `v3.8.6` pointing at different code, and every
    measurement below would then describe the fork while the report says "SiYuan 3.8.6". Compared
    through the `upstream` remote; an absent remote or no network is reported, not assumed.
    """
    remotes = git(src, "remote")
    if "upstream" not in remotes.split():
        return False, "no `upstream` remote configured, so the tags could not be traced to the official repository"
    ls = subprocess.run(
        ["git", "ls-remote", "--tags", "upstream"],
        cwd=src, capture_output=True, text=True, check=False, timeout=120,
    )
    if ls.returncode != 0 or not ls.stdout.strip():
        return False, "`git ls-remote upstream` returned nothing (offline?), so the tags could not be verified"
    official: dict[str, str] = {}
    for line in ls.stdout.split("\n"):
        parts = line.split()
        if len(parts) == 2 and parts[1].startswith("refs/tags/"):
            official[parts[1][len("refs/tags/"):].replace("^{}", "")] = parts[0]
    mismatched = []
    for t in tags:
        want = official.get(t)
        have = git(src, "rev-parse", f"{t}^{{}}").strip()
        if want and have and want != have:
            mismatched.append(f"{t}: local {have[:12]} != official {want[:12]}")
    if mismatched:
        return False, "these tags differ from the official repository: " + "; ".join(mismatched[:5])
    return True, f"all {len(tags)} stable tag(s) match the official repository"


def declared_constant(rel: str, name: str) -> str | None:
    p = REPO_ROOT / rel
    if not p.is_file():
        return None
    m = re.search(rf"export const {name}\s*=\s*'([^']+)'", p.read_text(encoding="utf-8"))
    return m.group(1) if m else None


def declared_min_app_version() -> str | None:
    p = REPO_ROOT / "src" / "plugin" / "plugin.json"
    if not p.is_file():
        return None
    import json
    try:
        return json.load(io.open(p, encoding="utf-8")).get("minAppVersion")
    except Exception:
        return None


def selftest() -> int:
    failures = 0

    def check(name: str, got, want) -> None:
        nonlocal failures
        ok = got == want
        print(f"  {'✅' if ok else '❌'} {name}" + ('' if ok else f"  got={got!r} want={want!r}"))
        if not ok:
            failures += 1

    check('a stable tag parses', bool(STABLE_TAG.match('v3.8.6')), True)
    check('an alpha tag is not stable', bool(STABLE_TAG.match('v3.8.7-alpha.4')), False)
    check('a beta tag is not stable', bool(STABLE_TAG.match('v3.8.7-beta.4')), False)
    check('tag ordering is numeric, not lexical', sorted(['v3.9.0', 'v3.10.0'], key=tag_key), ['v3.9.0', 'v3.10.0'])
    check('an unparseable tag sorts last', tag_key('v202205311650-dev'), (0, 0, 0))
    check('the constant is read out of the source',
          declared_constant('src/siyuan/host-compat.ts', 'TASK_MARKER_API_MIN_VERSION') is not None, True)

    if failures:
        print(f'check-version-floor --selftest: {failures} case(s) failed')
        return 1
    print('check-version-floor --selftest: all cases pass')
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--selftest', action='store_true', help='check the parser against fixtures, then exit')
    ap.add_argument('--matrix', action='store_true',
                    help='print every called endpoint with the first release that declares it')
    args = ap.parse_args()
    if args.selftest:
        return selftest()

    src = env.cfg.siyuan_src
    if not src or not Path(src).is_dir():
        print("check-version-floor: SKIPPED —— SIYUAN_SRC is not set (or not a directory), so the release\n"
              "  tags could not be read. The declared version constants were NOT verified on this machine.")
        return 0

    src_path = Path(src)
    tags = stable_tags(src_path)
    if not tags:
        print(f"check-version-floor: SKIPPED —— no stable `vX.Y.Z` tag in {src_path}, so there is no\n"
              "  released baseline to measure against. (A clone of only one branch has no tags.)")
        return 0

    print(f"check-version-floor: {len(tags)} stable release tag(s), {tags[0]} … {tags[-1]}")
    verified, why = verify_tags_are_official(src_path, tags)
    print(f"  tags vs official : {'✅ ' if verified else '⚠️  '}{why}")
    if not verified:
        print("  ★ Without that check the numbers below describe whatever this clone happens to be ——")
        print("    a fork's re-tag is not SiYuan's release, and the report would still say 'v3.8.6'.")

    endpoints = endpoints_called()
    if not endpoints:
        print("check-version-floor: FAIL —— no '/api/...' literal found, so nothing could be measured.\n"
              "  Reporting a pass on an empty list is the vacuous pass this repository keeps warning about.")
        return 1

    # One batch read of `kernel/api/router.go` at every release tag —— no checkout, no download.
    tables = read_router_tables(src_path, tags)
    if not tables:
        print("check-version-floor: FAIL —— could not read `kernel/api/router.go` from any tag "
              "(`git cat-file --batch` returned nothing).")
        return 1
    print(f"  router.go read   : {len(tables)}/{len(tags)} tag(s) in one batch read")

    # The floor each called endpoint imposes, and the overall floor.
    floors: dict[str, str] = {}
    never: list[str] = []
    for ep in sorted(endpoints):
        first = introduction(tables, tags, ep)
        if first is None:
            never.append(ep)
        else:
            floors[ep] = first
    if never:
        print("check-version-floor: FAIL —— these called endpoints exist in NO stable release:")
        for ep in never:
            print(f"  ✘ {ep}")
        return 1

    # ★ The matrix: every called endpoint and the first release that declares it. This is the
    #   "tested against all those versions" part —— a release is checked for a route by reading its
    #   own file, so the answer covers all 91 rather than a sample.
    if args.matrix:
        print("\n  endpoint                                    first release   guard")
        print("  " + "-" * 74)
        for ep in sorted(floors, key=lambda e: (tag_key(floors[e]), e)):
            guard = "guarded" if ep in GUARDED_ENDPOINTS else "—"
            print(f"  {ep:43} {floors[ep]:15} {guard}")
        print()

    # ★ Endpoints whose only mention is a wrapper nothing calls do not raise the floor. Reported,
    #   never silently dropped: the reader sees which endpoint was excluded and why, and can disagree.
    never_reached = unreached_methods()
    if never_reached:
        print(f"  not reached      : {len(never_reached)} endpoint(s) mentioned only by an uncalled wrapper")
        for ep, name in sorted(never_reached.items()):
            print(f"      · {ep} (via {name}) —— excluded from the floor, reported for a reader")

    # ★ The floor: an endpoint that **degrades** (the product checks the version or catches the
    #   failure) does not raise the minimum; an **unguarded** one 404s, which the user sees as
    #   "nothing happened". Both are printed, because a floor is only honest when it also names the
    #   endpoint that set it and says whether that endpoint is guarded.
    unguarded = {
        ep: t for ep, t in floors.items()
        if ep not in GUARDED_ENDPOINTS and ep not in never_reached
    }
    floor_tag = max(unguarded.values(), key=tag_key) if unguarded else None
    floor_ep = max(unguarded, key=lambda e: tag_key(unguarded[e])) if unguarded else None
    guarded_newest = max(
        (t for ep, t in floors.items() if ep in GUARDED_ENDPOINTS), key=tag_key, default=None,
    )
    print(f"  newest unguarded  : {floor_tag or '(none)'} (sets minAppVersion"
          + (f", from {floor_ep})" if floor_ep else ")"))
    if guarded_newest:
        print(f"  newest guarded    : {guarded_newest} (degrades, does not raise minAppVersion)")

    problems: list[str] = []

    # 0. Every claimed guard must be **defined** in the code it names.
    #    ★ Not a substring test on the file: renaming only the definition (`export async function
    #      supportsTaskMarkerApiREMOVED`) left the call site mentioning the old name, so a substring
    #      check still said "present" while the guard no longer existed. The check now requires a
    #      declaration, which is the thing that makes the endpoint guarded.
    for ep, (rel, symbol, why) in GUARDED_ENDPOINTS.items():
        p = REPO_ROOT / rel
        text = p.read_text(encoding="utf-8") if p.is_file() else ""
        declared = re.search(
            rf"(?:export\s+)?(?:async\s+)?(?:function|const|let)\s+{re.escape(symbol)}\b", text,
        ) is not None
        print(f"  guard for {ep}: {symbol} {'✅' if declared else '❌'} —— {why}")
        if not declared:
            problems.append(
                f"{ep} is listed as guarded by {symbol} in {rel}, but that symbol is not **declared** "
                f"there —— either the guard was removed (so the endpoint now sets the floor) or this "
                f"list is stale"
            )

    # 1. minAppVersion must be >= the floor the unguarded calls impose.
    declared_min = declared_min_app_version()
    if declared_min is None:
        problems.append("src/plugin/plugin.json has no readable minAppVersion")
    else:
        print(f"  minAppVersion    : {declared_min} (declared)")
        if floor_tag and tag_key(declared_min) < tag_key(floor_tag):
            problems.append(
                f"minAppVersion {declared_min} is BELOW the floor {floor_tag} imposed by the unguarded "
                f"endpoints the plugin calls —— on such a kernel a call 404s, and the user sees the edit "
                f"do nothing"
            )

    # 2. Each constant must equal the measured introduction release (compared with the `v` stripped).
    for rel, name, endpoint in CONSTANT_CLAIMS:
        declared = declared_constant(rel, name)
        measured = floors.get(endpoint)
        measured_bare = measured[1:] if measured and measured.startswith('v') else measured
        if declared is None:
            problems.append(f"{rel}: {name} could not be read")
            continue
        print(f"  {name}: {declared} (declared) vs {measured_bare} (measured for {endpoint})")
        if measured and declared != measured_bare:
            problems.append(f"{name} is '{declared}' but {endpoint} first appears in {measured}")

    if problems:
        print("\n✘ the declared version claims disagree with the released tags:")
        for p in problems:
            print(f"    {p}")
        return 1

    print("\n✅ declared version claims agree with the released tags")
    return 0


if __name__ == '__main__':
    with script_log.track('check-version-floor'):
        sys.exit(main())
