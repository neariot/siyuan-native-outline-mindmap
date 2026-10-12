#!/usr/bin/env python3
"""Methods on the store that nothing calls —— dead code that makes a broken feature look implemented.

★ Why this exists. `SiYuanStore.saveNodes` writes whole documents as kramdown, and kramdown is the one path
that can carry a heading level (`nodeToLine` emits `# text`). The live path, `saveNodesIncremental`, writes
DOM and cannot. So a reader that refuses list lines, a live writer that cannot carry a level, and a **dead**
writer that can, added up to a documented feature —— "H1 / H2 / H3" in the toolbar and `# ` + space in the
shortcut docs —— that silently does nothing. Nothing failed; the dead method simply made the feature look
supported.

★ What it does. For each public/`async` method on a store class in `src/siyuan/`, count call sites elsewhere
in `src/` and `e2e/` (`.name(` and `this.name(`), and report the ones with none.

★ What it is not. Not a general dead-code detector, and it does not fail the build. Some of these are
legitimate —— a method kept for a caller outside this repository, or one only a test names. The point is that
the list is **printed**, so "is this still used?" is answered by looking instead of by grep-and-hope. A
method that nothing calls and that documents a capability is the case worth reading first.

Exit status is 0 unless `--strict` is given, which fails when an uncalled method's doc comment claims a
capability (mentions "create", "rebuild", "only" or names a block type) —— that is the shape that misled here.
"""
from __future__ import annotations

import argparse
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
SCAN_DIRS = [SRC, ROOT / "e2e"]

# `async saveNodes(docId: string, ...)` or `saveNodes(...)` on its own line, inside a class body (2 spaces).
# ★ The name must not be a TypeScript keyword. Without this, `if (` and `for (` inside a method body match a
#   bare name at two-space indent, so `if` and `for` are collected as "methods". They are never *reported*
#   (they have call sites everywhere), but they were the two most expensive entries in the scan: `if` appears
#   in every file, so it paid the full regex over the largest sources on every run. Found by measuring which
#   (name, file) pairs cost >10ms rather than by reading the pattern.
_TS_KEYWORDS = {
    "if", "for", "while", "switch", "catch", "return", "function", "class", "const", "let", "var",
    "do", "else", "try", "throw", "new", "typeof", "delete", "void", "in", "of", "case", "default",
    "break", "continue", "yield", "await", "super", "this", "import", "export", "interface", "type",
}
METHOD_RE = re.compile(r"^  (?:public |private |protected )?(?:async )?([a-zA-Z_][A-Za-z0-9_]*)\s*\(", re.M)
# ★ A capability claim in the doc comment above a method.
#
#   The first version of this matched the bare words `create` / `only` / `rebuild`, which fired on
#   **other method names mentioned in prose** (`saveNodesIncremental`, `listDocsAfterCreate`) and on
#   incidental English ("fetch only the node tree"). It flagged six methods and every one of them was
#   noise, so the gate could not be turned green and proved nothing.
#
#   What actually misled here is narrower and worth naming: a comment that says the method is for
#   **whole-document** work, or that calls itself the **only** way to do something. Both describe a
#   capability the rest of the code then fails to have. So the words are anchored to that sense.
CLAIM_RE = re.compile(
    r"(full[- ]rebuild|wholesale replacement|whole[- ]document|"
    r"the only (?:way|call|path|method)|create/full)",
    re.I,
)


def store_classes() -> list[tuple[pathlib.Path, int, str]]:
    """(file, line, class name) for every `class X` / `export class X` in src/siyuan."""
    out = []
    for p in sorted((SRC / "siyuan").rglob("*.ts")):
        if p.name.endswith(".test.ts"):
            continue
        for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
            m = re.match(r"^(?:export )?class ([A-Za-z_][A-Za-z0-9_]*)", line)
            if m:
                out.append((p, i, m.group(1)))
    return out


def method_ranges(path: pathlib.Path) -> list[tuple[str, int]]:
    """(method name, line) for every method declaration at class-body indentation."""
    text = path.read_text(encoding="utf-8")
    return [(m.group(1), text[: m.start()].count("\n") + 1)
            for m in METHOD_RE.finditer(text)
            if m.group(1) not in _TS_KEYWORDS]


_SCANNED: list[str] | None = None


def scanned_sources() -> list[str]:
    """Every scanned file's text, read **once**.

    ★ It used to re-glob and re-read the whole tree for every method —— 66 methods over two directories,
    which measured ~31s and made this the slowest gate in `scripts/check.py` by a wide margin (the next
    slowest was ~5s). Reading each file once and keeping the text brings it down to well under a second,
    which matters because this runs on every `npm run check`: a gate slow enough to resent is a gate people
    start skipping.
    """
    global _SCANNED
    if _SCANNED is None:
        texts: list[str] = []
        for d in SCAN_DIRS:
            if not d.is_dir():
                continue
            for p in list(d.rglob("*.ts")) + list(d.rglob("*.tsx")):
                texts.append(p.read_text(encoding="utf-8", errors="replace"))
        _SCANNED = texts
    return _SCANNED


def call_site_count(name: str, defining: pathlib.Path) -> int:  # noqa: ARG001 (see docstring)
    """How many places call `.name(` or `this.name(` —— **including inside the declaring file**.

    ★ The declaring file must be scanned too. Skipping it was a measured false positive: `moveNodes` is
    private and called only from `syncStructure`, in the same file, so it was reported as dead. A method's
    own definition does not match this pattern (there is no receiver), so scanning the whole file is safe.
    """
    # ★ Optional chaining must be allowed between the receiver and the dot. Missing it was a measured false
    #   positive: `mount.ts` calls `store?.setHeadingTitle(docId, name)`, and `store?` does not match
    #   `[A-Za-z_$][\w$]*`, so the call was invisible and the method was reported dead. This codebase uses
    #   optional chaining heavily (`store?.`, `nodesRef?.`), so the gap hid real callers, not hypothetical
    #   ones —— and a checker that hides a caller is how a live method gets deleted as dead code.
    pattern = re.compile(r"\bthis\s*\??\s*\.\s*" + re.escape(name) + r"\s*\(|" +
                         r"[A-Za-z_$][\w$]*\s*\??\s*\.\s*" + re.escape(name) + r"\s*\(")
    # ★ A plain substring guard first, and it is what makes this gate fast.
    #
    #   Measured: the regex costs ~50ms on a 200 KB file (`Outliner.tsx`), and this runs it against every
    #   scanned file for every method —— 66 x 2 directories, 7,260 `findall` calls, **29.3s**, which made
    #   this the slowest gate in `scripts/check.py` by six times over the next one. Profiling put 29.3 of
    #   29.4 seconds inside `re.Pattern.findall`, so the cost was the regex, not the I/O (the first guess
    #   here was "it re-reads the tree per method" —— wrong, and only the profile showed it).
    #
    #   `name in text` is a plain substring search: ~1.5ms for twenty files against 55.7ms for a single
    #   `findall`. A method name absent from a file cannot have a call site in it, so the guard is exact,
    #   not an approximation —— and most methods are absent from most files.
    total = 0
    for text in scanned_sources():
        if name not in text:
            continue
        total += len(pattern.findall(text))
    return total


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--strict", action="store_true",
                    help="fail when an uncalled method's comment claims a capability")
    args = ap.parse_args()

    classes = store_classes()
    if not classes:
        print("check-dead-methods: no store classes found —— the scan is broken, not the code", file=sys.stderr)
        return 2

    uncalled: list[tuple[pathlib.Path, int, str]] = []
    checked = 0
    seen_files: set[pathlib.Path] = set()
    for path, _line, _cls in classes:
        if path in seen_files:
            continue          # one pass per file: a file may declare several classes
        seen_files.add(path)
        text = path.read_text(encoding="utf-8")
        for name, ln in method_ranges(path):
            if name in {"constructor"} or name.startswith("_"):
                continue
            checked += 1
            if call_site_count(name, path) == 0:
                # Keep a short comment to decide whether it claims a capability.
                tail = "\n".join(text.splitlines()[max(0, ln - 12):ln])
                claim = bool(CLAIM_RE.search(tail))
                uncalled.append((path, ln, f"{name}{'  ← comment claims a capability' if claim else ''}"))

    print(f"check-dead-methods: {checked} method(s) over {len(classes)} store class(es); "
          f"{len(uncalled)} with no call site")
    for path, ln, label in uncalled:
        print(f"  · {path.relative_to(ROOT)}:{ln}  {label}")
    if uncalled:
        print("\n  Not every one is a defect —— a method may be public API for a caller outside this repo.")
        print("  Read the ones whose comment claims a capability first: that is the shape that made a")
        print("  documented feature look implemented while nothing could ever reach it.")

    if args.strict and any("claims a capability" in u[2] for u in uncalled):
        print("\ncheck-dead-methods: FAILED —— an uncalled method claims a capability", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
    try:
        from script_log import track
    except ImportError:
        sys.exit(main())
    with track("check-dead-methods"):
        sys.exit(main())
