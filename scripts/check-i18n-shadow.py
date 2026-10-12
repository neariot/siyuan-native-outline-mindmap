#!/usr/bin/env python3
"""A local binding that shadows the i18n `t`, in a module that translates.

★ Why this exists. `src/siyuan/store.ts` had `const t = Date.now();` inside `listFolders`, in a module that
imports the i18n function as `t` (used in 20-odd places). It was harmless only because that one method
happens to translate nothing —— add a single `t('someKey')` there and the compiler reports "This expression
is not callable / Type 'number' has no call signatures", pointing at the call and not at the shadowing
declaration a few lines up.

★ Why it is a script and not a note. There is no ESLint in this repository, so `no-shadow` cannot be turned
on; the rule would otherwise be enforced by remembering to look, which §8 says is the same as not having it.

★ What it does and does not see. It reads the declarations textually, because shadowing is **legal**
TypeScript and produces no compiler diagnostic —— `tsc` cannot be asked about it. So the report is a
shortlist to read rather than a verdict, and it says so when it prints. The shapes it looks for are the
declarations that can introduce a name: `const`/`let`/`var`, a `function`, and a destructuring binding.

Exit status is 0 when clean, 1 when a shadow is found.
"""
from __future__ import annotations

import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# `tsc` invocation: emit nothing, no lib checks, just parse the project as the build does.
TSC = ROOT / "node_modules" / ".bin" / "tsc"


def modules_importing_t() -> list[pathlib.Path]:
    """Modules that bring the i18n `t` into scope."""
    out = []
    for p in list((ROOT / "src").rglob("*.ts")) + list((ROOT / "src").rglob("*.tsx")):
        if p.name.endswith(".test.ts"):
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        for line in text.splitlines():
            if line.lstrip().startswith(("import", "}")):
                if " t " in f" {line} " or " t," in line or "{ t }" in line or ", t }" in line:
                    if "i18n" in text[: text.find(line) + 4000] and "i18n'" in line:
                        out.append(p)
                        break
    return out


def main() -> int:
    files = modules_importing_t()
    if not files:
        print("check-i18n-shadow: no module imports the i18n `t` —— the scan is broken", file=sys.stderr)
        return 2

    print(f"check-i18n-shadow: {len(files)} module(s) import the i18n `t`")
    print("  NOTE: this reads declarations textually. TypeScript cannot be asked about shadowing because")
    print("        shadowing is legal and produces no diagnostic. A shadow is only a hazard where `t()` is")
    print("  also called in the same scope, so the report below is a shortlist to read, not a verdict.")

    findings: list[str] = []
    for p in files:
        lines = p.read_text(encoding="utf-8").splitlines()
        rel = p.relative_to(ROOT)
        for i, line in enumerate(lines, 1):
            stripped = line.strip()
            if stripped.startswith(("//", "*", "/*")):
                continue
            # A declaration whose name is exactly `t`.
            for prefix in ("const t =", "let t =", "var t =", "function t(", "const { t }", "const [t]"):
                if prefix in stripped:
                    findings.append(f"  · {rel}:{i}  {stripped[:100]}")
                    break

    for f in findings:
        print(f)
    if findings:
        print("\ncheck-i18n-shadow: a local `t` shadows the i18n function in a module that translates.")
        print("  Read each one: it is a defect when the same scope also calls `t('<key>')`, and a landmine")
        print("  otherwise —— the next translated string added there fails to compile with a message that")
        print("  points at the call rather than at this declaration.")
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
    try:
        from script_log import track
    except ImportError:
        sys.exit(main())
    with track("check-i18n-shadow"):
        sys.exit(main())
