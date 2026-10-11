#!/usr/bin/env python3
# >>> path-cases  —— this file *is* the rule and its cases, so the paths below are literal by
# construction. The scanner skips this span and prints how many lines it skipped, so the exemption
# cannot hide a real path elsewhere in the file.
"""A path that belongs to one machine must not be in the repository.

The rule is AGENTS.md section 1 ("Never hardcode machine absolute paths in docs or scripts"). It was
enforced by someone remembering to look, which is why an audit entry could claim that `.env.example`
held a machine-specific path — and the claim could not be checked by anything, in either direction:
the file's values are `/path/to/...` placeholders, and nothing would have said so or the opposite.

What it judges, precisely:

  * **fails** —— a real user-home or install path: `/home/<name>/...`, `/Users/<name>/...`, `/root/...`,
    `/opt/<name>/...`. Those describe one machine and break on any other.
  * **allows** —— the placeholder convention `/path/to/<anything>` and `/home/user/...`-style placeholders
    (`user`, `username`, `you`, `youruser`, `example`), plus paths under `~` or `$VAR`/`${VAR}` —— a
    template has to show the *shape* of a path without naming one machine's.

★ What it cannot see, and says so rather than implying otherwise: a path inside a binary or an image, a
path assembled at runtime (`os.path.join("/home", name)`), a path in a gitignored file (`.env` is exactly
where machine-specific values belong), and a path written with Windows separators. It answers "is a literal
one-machine path in a tracked file", which is the rule as written and not the whole of portability.

    python3 scripts/check-hardcoded-paths.py             # the tree
    python3 scripts/check-hardcoded-paths.py --selftest  # the rules, no I/O
    python3 scripts/check-hardcoded-paths.py --list      # every absolute path found, judged
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from script_log import track  # noqa: E402

# The placeholder names a template may use. `/home/user/...` is a shape, not a person.
PLACEHOLDER_NAMES = {"user", "users", "username", "you", "youruser", "example", "name", "someone"}

# A path with a leading `/` and at least one segment: we only ever judge the ones that look like a home or
# an install location, because `/api/...` and `/stage/build/...` are URLs and kernel routes, not filesystems.
# ★ The boundary after the root word matters: without it, `</option>` reads as `/opt` and every SVG
#   `<option>` element becomes a finding. Measured —— the first version of this check flagged six of them.
CANDIDATE = re.compile(r"(?<![\w./-])/(home|Users|root|opt|usr/local)(?![A-Za-z0-9_-])(?:/([A-Za-z0-9_.-]+))?")
# <<< path-cases


def judge(path: str) -> str | None:
    """Return the reason a literal path is machine-specific, or None when it is acceptable."""
    if "/path/to/" in path:
        return None
    match = CANDIDATE.search(path)
    if not match:
        return None
    root, first = match.group(1), match.group(2)
    if root in ("root", "usr/local"):
        return f"/{root} is one machine's layout"
    if root in ("home", "Users") and first is None:
        return f"vague home path /{root}"
    if first is not None and first.lower() in PLACEHOLDER_NAMES:
        return None
    return f"/{root}/{first} names a real user or install location"


def candidates() -> list[Path]:
    """Tracked files plus untracked ones that are not ignored —— a scratch file is still a leak risk."""
    out = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        cwd=Path(__file__).resolve().parent.parent,
        capture_output=True,
        text=True,
        check=True,
    )
    root = Path(__file__).resolve().parent.parent
    return [root / line for line in out.stdout.splitlines() if line.strip()]


SKIP_OPEN, SKIP_CLOSE = "# >>> path-cases", "# <<< path-cases"


def scan(files: list[Path]) -> tuple[list[tuple[Path, int, str, str]], int]:
    """Findings, and how many lines were skipped as a checker's own literal cases.

    ★ The skip is narrow and counted: the cases a *checker of paths* must contain are paths, so a checker
    that flags itself is useless —— but a silent exemption for a whole file would also hide a real path
    added to it later. The count is printed on every run.
    """
    findings: list[tuple[Path, int, str, str]] = []
    skipped = 0
    for path in files:
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue  # a binary: not text, so not a place a path literal is written (and said so above)
        inside_cases = False
        for number, line in enumerate(text.splitlines(), 1):
            if SKIP_OPEN in line:
                inside_cases = True
                continue
            if SKIP_CLOSE in line:
                inside_cases = False
                continue
            if inside_cases:
                skipped += 1
                continue
            if not CANDIDATE.search(line):
                continue
            for token in re.findall(r"/[^\s\"'`)\]}>,;]+", line):
                reason = judge(token)
                if reason:
                    findings.append((path, number, token, reason))
    return findings, skipped


def selftest() -> int:
    # (line, is a finding?, a word the reason must mention) —— asserting on the *decision* plus a keyword
    # rather than on the whole sentence, so wording can improve without breaking the case.
    # >>> path-cases (the lines below are literal paths **by construction**; the scanner skips them,
    # and prints how many it skipped, so this cannot hide a real path somewhere else in this file)
    cases = [
        ("SIYUAN_WORKSPACE=/path/to/siyuan/workspace", False, ""),
        ("CHROMIUM_PATH=/path/to/chromium", False, ""),
        ("python=/home/user/venv/bin/python", False, ""),
        ("PYTHON=/Users/example/miniforge3/bin/python", False, ""),
        ("dir=/home/ubuntu/siyuan/workspace", True, "home/ubuntu"),
        ("chromium=/usr/bin/chromium", False, ""),  # a system path every machine has
        ("root=/root/.dsh/config.yaml", True, "root"),
        ("brew=/opt/homebrew/bin/node", True, "opt/homebrew"),
        ("url=https://host/api/notebook/lsNotebooks", False, ""),
        ("route=/stage/build/desktop/", False, ""),
        ("docs=/usr/local/share/doc", True, "usr/local"),
        ("home=/home/", True, "/home"),
        ("cache=${HOME}/.cache/x", False, ""),
        ("win=C:\\Users\\someone\\x", False, ""),  # backslashes: not a POSIX home path (said so above)
    ]
    # <<< path-cases
    failed = 0
    print("hardcoded paths: the rules")
    for line, expected_flagged, keyword in cases:
        reason = judge(line)
        flagged = reason is not None
        ok = flagged == expected_flagged and (not flagged or keyword in (reason or ""))
        if not ok:
            failed += 1
        print(f"  {'OK  ' if ok else 'FAIL'} {line!r} -> {reason!r}" + ("" if ok else f" (expected flagged={expected_flagged}, keyword={keyword!r})"))
    print(f"selftest: {'PASS' if failed == 0 else 'FAIL'} ({len(cases)} case(s), {failed} failed)")
    return 1 if failed else 0


def main() -> int:
    args = set(sys.argv[1:])
    if "--selftest" in args:
        return selftest()

    files = candidates()
    findings, skipped = scan(files)
    if "--list" in args:
        for path, number, token, reason in findings:
            print(f"  {path}:{number}  {token}  ({reason})")
    print(f"hardcoded paths: {len(files)} file(s) scanned, {len(findings)} finding(s), "
          f"{skipped} line(s) skipped as a checker's own literal cases")
    print("  ★ It cannot see a path inside a binary, one assembled at runtime, or one in a gitignored file")
    print("    (`.env` is where machine-specific values belong) —— and it does not claim otherwise.")
    if findings:
        for path, number, token, reason in findings:
            print(f"  ❌ {path}:{number}  {token}  —— {reason}")
        print("  → keep machine-specific values in .env; a template shows the shape (/path/to/...), never a machine")
        return 1
    return 0


if __name__ == "__main__":
    with track("check-hardcoded-paths"):
        sys.exit(main())
