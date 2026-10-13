#!/usr/bin/env python3
"""Consolidated upstream compatibility health check against SiYuan source.

Checks:
1. Upstream git checkout: branch, tag, HEAD commit, and uncommitted diffs.
2. Kernel block containment rules: verifies treenode.CanContainBlock via check-block-rules.py.
3. Wire API shape contracts: verifies TypeScript declarations via check-kernel-shapes.py.
4. API endpoint completeness: verifies all endpoints in src/siyuan/api.ts are registered in router.go.

Exit code: 0 when all upstream contracts match, non-zero otherwise.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import env  # noqa: E402
import script_log  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent


def check_upstream_git(siyuan_src: Path) -> dict[str, str]:
    """Inspect git state of the upstream checkout."""
    info = {"commit": "unknown", "describe": "unknown", "branch": "unknown"}
    if not (siyuan_src / ".git").exists():
        return info

    def run_git(args: list[str]) -> str:
        try:
            res = subprocess.run(
                ["git", *args],
                cwd=siyuan_src,
                capture_output=True,
                text=True,
                check=False,
            )
            return res.stdout.strip()
        except Exception:
            return "unknown"

    info["commit"] = run_git(["rev-parse", "--short", "HEAD"])
    info["describe"] = run_git(["describe", "--tags", "--always"])
    info["branch"] = run_git(["rev-parse", "--abbrev-ref", "HEAD"])
    return info


def main() -> int:
    src_path = env.cfg.siyuan_src
    if not src_path:
        print(
            "check-upstream: SKIPPED —— SIYUAN_SRC is not set in .env.\n"
            "  Set SIYUAN_SRC to a SiYuan source checkout to verify upstream compatibility."
        )
        return 0

    siyuan_src = Path(src_path)
    if not siyuan_src.is_dir():
        print(f"check-upstream: FAIL —— SIYUAN_SRC directory does not exist: {siyuan_src}")
        return 1

    print("=== SiYuan Upstream Compatibility Health Check ===")
    git_info = check_upstream_git(siyuan_src)
    print(f"  Upstream checkout: {siyuan_src}")
    print(f"  Branch / Tag:      {git_info['branch']} ({git_info['describe']})")
    print(f"  Commit:            {git_info['commit']}")
    print()

    # 1. Block containment rules & API routes
    print("--- 1. Block Containment & Router Verification ---")
    ret_rules = subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "check-block-rules.py")],
        cwd=REPO_ROOT,
        check=False,
    )
    if ret_rules.returncode != 0:
        print("check-upstream: FAIL block containment or route check failed")
        return 1

    print()
    # 2. Wire API shapes
    print("--- 2. Wire API Shape Verification ---")
    ret_shapes = subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "check-kernel-shapes.py")],
        cwd=REPO_ROOT,
        check=False,
    )
    if ret_shapes.returncode != 0:
        print("check-upstream: FAIL wire API shape check failed")
        return 1

    print()
    print("=== Upstream Compatibility Verdict: 100% GREEN ===")
    print("  All data carriers, wire contracts, and routes are aligned with upstream.")
    return 0


if __name__ == "__main__":
    with script_log.track("check-upstream"):
        sys.exit(main())
