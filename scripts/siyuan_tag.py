#!/usr/bin/env python3
"""Materialise a **released** SiYuan tag into a temporary directory, from the local clone's objects.

## Why this exists

Two gates read SiYuan's own source to verify our claims about it:

    scripts/check-block-rules.py     the kernel's `treenode.CanContainBlock`, plus its route table
    scripts/check-kernel-shapes.py   the generated API contract (`app/src/types/api/index.d.ts`)

Both used to read `SIYUAN_SRC` **as a working tree** —— whatever branch happens to be checked out.
Measured on this machine, that checkout is a fork branch (`fix-moveblock-transaction-error`) whose
HEAD is reachable from neither `upstream/master` nor any release tag, and it differs from the
released v3.8.6 by 127 lines in the very contract file one of them reads. So the verdict "aligned
with upstream" was really "aligned with this fork's working copy".

A released tag is the thing users install. This module makes one available without a checkout and
without downloading a release archive:

  · `git cat-file --batch` reads the blobs out of the local object store (no working-tree change);
  · only the paths a gate asks for are written out —— `kernel/treenode/` is 24 files / ~149 KB;
  · the caller gets a temporary directory it owns and deletes.

## Usage

    from siyuan_tag import materialise, tag_for_check

    with materialise(src, tag, ["kernel/go.mod", "kernel/go.sum", "kernel/treenode"]) as root:
        ...  # root/kernel/treenode/... exists, read from that tag

`tag_for_check()` picks the tag: `SIYUAN_TAG` from `.env` when set, otherwise the newest stable
`vX.Y.Z` in the clone. A tag that does not exist is an error, never a fallback to the working tree.

## What it cannot do

It does not verify the tag is official —— that is `check-version-floor.py`'s job (it compares every
tag against the `upstream` remote). This module reads whatever tag it is given.
"""

import atexit
import os
import re
import shutil
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))

STABLE_TAG = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")


def _git(src: Path, *args: str) -> str:
    res = subprocess.run(["git", *args], cwd=src, capture_output=True, text=True, check=False)
    return res.stdout if res.returncode == 0 else ""


def stable_tags(src: Path, min_major: int = 3) -> list[str]:
    def key(t: str) -> tuple[int, int, int]:
        m = STABLE_TAG.match(t)
        return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else (0, 0, 0)

    tags = [t for t in _git(src, "tag", "-l").split("\n") if STABLE_TAG.match(t)]
    tags = [t for t in tags if key(t)[0] >= min_major]
    return sorted(tags, key=key)


def tag_for_check(src: Path, explicit: str = "") -> str | None:
    """`SIYUAN_TAG` when set (and present), else the newest stable tag. `None` when there is none."""
    want = (explicit or os.environ.get("SIYUAN_TAG", "")).strip()
    if want:
        if _git(src, "rev-parse", "--verify", f"{want}^{{}}").strip():
            return want
        return None
    tags = stable_tags(src)
    return tags[-1] if tags else None


def materialise_dir(src: Path, tag: str, specs: list[str]) -> Path:
    """Like `materialise`, but returns a path and removes it when the process exits.

    ★ For a gate whose body must not be re-indented: a `with` block would indent every line below it,
       and that diff would bury the actual change. Cleanup still happens —— `atexit` runs on every
      normal exit, including the early `return`s and `sys.exit` a gate uses.
    """
    root = Path(tempfile.mkdtemp(prefix="siyuan-tag-"))
    atexit.register(shutil.rmtree, root, ignore_errors=True)
    try:
        with materialise(src, tag, specs) as tmp:
            shutil.copytree(tmp, root, dirs_exist_ok=True)
    except Exception:
        shutil.rmtree(root, ignore_errors=True)
        raise
    return root


@contextmanager
def materialise(src: Path, tag: str, specs: list[str]):
    """Yield a temp dir containing `specs` as they exist at `tag`, then remove it.

    ★ `git archive <tag> <specs>` streams exactly those paths out of the object store in one process:
      measured 0.12s for the whole `kernel/` tree (1489 files, 16 MB) and 0.02s for `kernel/treenode`
      alone. Nothing is checked out —— `git archive` does not touch the working tree or the index,
      which matters because `SIYUAN_SRC` is often a tree somebody is working in.
    """
    missing = [s for s in specs if not _git(src, "ls-tree", "-r", "--name-only", tag, "--", s).strip()]
    if len(missing) == len(specs):
        raise RuntimeError(
            f"siyuan_tag: tag {tag} names none of {specs} —— the tag is wrong, or it predates these paths"
        )
    present = [s for s in specs if s not in missing]

    with tempfile.TemporaryDirectory(prefix="siyuan-tag-") as tmp:
        root = Path(tmp)
        proc = subprocess.run(
            ["git", "archive", tag, "--", *present],
            cwd=src, capture_output=True, check=False,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                f"siyuan_tag: `git archive {tag}` failed: {proc.stderr.decode('utf-8', 'replace')[:300]}"
            )
        untar = subprocess.run(
            ["tar", "-x", "-C", str(root)], input=proc.stdout, capture_output=True, check=False,
        )
        if untar.returncode != 0:
            raise RuntimeError(
                f"siyuan_tag: extracting {tag} failed: {untar.stderr.decode('utf-8', 'replace')[:300]}"
            )
        if not any(root.rglob("*")):
            raise RuntimeError(f"siyuan_tag: extracted 0 files at tag {tag}")
        yield root


def _selftest() -> int:
    """Pin the three decisions this helper makes, using the clone the checks actually read.

    Each case is written to be able to go red —— a helper whose failure mode is "silently read the
    working tree instead" is exactly the defect it exists to prevent, so the last case feeds it a tag
    that cannot exist and requires a failure rather than a fallback.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import env  # noqa: E402

    src = env.cfg.siyuan_src
    if not src or not Path(src).is_dir():
        print("siyuan-tag --selftest: SKIPPED —— SIYUAN_SRC is not configured.")
        return 0
    src = Path(src)
    tag = tag_for_check(src)
    if not tag:
        print(f"siyuan-tag --selftest: SKIPPED —— no stable tag in {src}.")
        return 0

    failures: list[str] = []

    # 1. A tag that does not exist is a failure, never a fallback to the working tree.
    try:
        with materialise(src, "v0.0.0-does-not-exist", ["kernel/go.mod"]):
            failures.append("a non-existent tag yielded a directory instead of raising")
    except RuntimeError:
        pass

    # 2. A path absent at the tag raises rather than yielding an empty tree.
    try:
        with materialise(src, tag, ["no/such/path/anywhere.go"]):
            failures.append("an absent path yielded a directory instead of raising")
    except RuntimeError:
        pass

    # 3. The bytes come from the *tag*, not from the working tree. Comparing against the tree alone
    #    would pass on a machine whose checkout happens to sit at that tag, so the decisive case is
    #    two different tags of one file: if the helper silently read the working tree, both would come
    #    back byte-identical. `kernel/go.mod` is used because it is small and changes between releases.
    spec = "kernel/go.mod"
    pairs: list[tuple[str, str]] = []
    tags = stable_tags(src)
    blobs = {t: _git(src, "rev-parse", f"{t}:{spec}").strip() for t in tags}
    distinct = [t for t in tags if blobs[t]]
    for i in range(len(distinct) - 1, 0, -1):
        if blobs[distinct[i]] != blobs[distinct[i - 1]]:
            pairs.append((distinct[i - 1], distinct[i]))
            break
    if not pairs:
        failures.append(f"no two stable tags differ in {spec} —— the tag-vs-tag case cannot be built")
    else:
        a, b = pairs[0]
        with materialise(src, a, [spec]) as root_a:
            bytes_a = (root_a / spec).read_bytes()
        with materialise(src, b, [spec]) as root_b:
            bytes_b = (root_b / spec).read_bytes()
        if bytes_a != subprocess.run(["git", "show", f"{a}:{spec}"], cwd=src,
                                     capture_output=True, check=False).stdout:
            failures.append(f"{spec} from {a} does not match `git show {a}:{spec}`")
        if bytes_b != subprocess.run(["git", "show", f"{b}:{spec}"], cwd=src,
                                     capture_output=True, check=False).stdout:
            failures.append(f"{spec} from {b} does not match `git show {b}:{spec}`")
        if bytes_a == bytes_b:
            failures.append(
                f"{spec} is identical at {a} and {b} (blobs differ) —— the helper is not reading the tag"
            )

    if failures:
        print("siyuan-tag --selftest: FAIL")
        for f in failures:
            print(f"  ✘ {f}")
        return 1
    print(f"siyuan-tag --selftest: all cases pass (read {tag} from {src})")
    return 0


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", help="the clone (defaults to SIYUAN_SRC)")
    ap.add_argument("--tag", default="", help="tag to materialise (defaults to SIYUAN_TAG or newest stable)")
    ap.add_argument("--paths", nargs="*", default=["kernel/treenode", "kernel/go.mod", "kernel/go.sum"],
                    help="paths or directory prefixes to extract")
    ap.add_argument("--keep", action="store_true", help="print the directory and do not delete it")
    ap.add_argument("--selftest", action="store_true", help="pin this helper's own decisions")
    args = ap.parse_args()

    if args.selftest:
        return _selftest()

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import env  # noqa: E402

    src = Path(args.src or env.cfg.siyuan_src or "")
    if not src or not src.is_dir():
        print("siyuan-tag: SKIPPED —— SIYUAN_SRC is not set (or not a directory).")
        return 0

    tag = tag_for_check(src, args.tag)
    if not tag:
        print(f"siyuan-tag: no stable tag in {src} and SIYUAN_TAG is unset —— nothing to materialise.")
        return 1

    if args.keep:
        root = Path(tempfile.mkdtemp(prefix="siyuan-tag-"))
        with materialise(src, tag, args.paths) as tmp:
            subprocess.run(["cp", "-a", f"{tmp}/.", str(root)], check=True)
        files = sum(1 for _ in root.rglob("*") if _.is_file())
        print(f"siyuan-tag: {tag} → {root}  ({files} file(s), kept)")
        return 0

    with materialise(src, tag, args.paths) as root:
        files = sum(1 for _ in root.rglob("*") if _.is_file())
        size = sum(f.stat().st_size for f in root.rglob("*") if f.is_file())
        print(f"siyuan-tag: {tag} materialised —— {files} file(s), {size / 1024:.0f} KB (temporary)")
    return 0


if __name__ == "__main__":
    import script_log  # noqa: E402
    with script_log.track("siyuan-tag"):
        sys.exit(main())
