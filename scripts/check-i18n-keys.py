#!/usr/bin/env python3
"""Every `t('<key>')` in the source must exist in both i18n catalogues, and every entry must be used.

Removing the fallback argument made the catalogues the only home for UI text, which moves the failure
mode: a key that does not exist used to degrade to the Chinese text copied into the call site, and now
it renders as the key itself (`lblEmptyNode`) in front of the user. This gate is what keeps that from
happening —— it is the reason the fallbacks could be deleted.

Three things are checked, because each one is a way the UI goes wrong:

  * a key used in code but absent from `zh_CN.json` / `en_US.json`  -> the key id is displayed
  * a key present in one catalogue but not the other               -> that language shows the key id
  * an entry whose name appears nowhere in the source              -> dead text that drifts

An entry reached through a computed key (`t(table[s].nameKey)`) is **not** dead: the name is still a
literal in the source, so "unused" means "the name appears nowhere", not "never the first argument of
`t`". Those calls are listed, because this gate cannot verify them.

Usage:
  python3 scripts/check-i18n-keys.py            # check, exit 1 on any problem
  python3 scripts/check-i18n-keys.py --list     # also print every key with its file count
"""
from __future__ import annotations

import argparse
import io
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import script_log  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
CATALOGUES = {
    "zh_CN": REPO_ROOT / "src" / "plugin" / "i18n" / "zh_CN.json",
    "en_US": REPO_ROOT / "src" / "plugin" / "i18n" / "en_US.json",
}
# `t('key')` / `t("key")` -- a literal first argument only. A computed key cannot be checked, so it is
# reported instead of being silently skipped.
CALL = re.compile(r"""\bt\(\s*(['"])([A-Za-z0-9_]+)\1""")
CJK_RUN = re.compile(r"[\u3400-\u9fff\uff00-\uffef]{2,}")
DYNAMIC = re.compile(r"""\bt\(\s*([A-Za-z_$][A-Za-z0-9_$.\[\]]*)\s*[,)]""")


def sources():
    """Every tracked source file that can call `t` (tests included: they render UI too)."""
    tracked = subprocess.run(
        ["git", "ls-files", "src"], cwd=REPO_ROOT, capture_output=True, text=True, check=True
    ).stdout.split()
    return [
        REPO_ROOT / path
        for path in tracked
        if path.endswith((".ts", ".tsx")) and "/i18n/" not in path
    ]


def consumers():
    """Files outside `src/` that rely on a catalogue value being what it is.

    The E2E suite asserts against the **rendered** text (`expect(...).toHaveText('...')`) and the user
    docs quote it, so both are reasons a value must stay: deleting the entry would break the suite, not
    just the product. The stronger design is for a spec to read the catalogue instead of repeating the
    text, and this weaker rule exists so an entry that a test asserts is never called dead.
    """
    tracked = subprocess.run(
        ["git", "ls-files", "e2e", "docs"], cwd=REPO_ROOT, capture_output=True, text=True, check=True
    ).stdout.split()
    return [REPO_ROOT / path for path in tracked if path.endswith((".ts", ".tsx", ".md"))]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--list", action="store_true", help="print every used key and how often")
    args = parser.parse_args()

    catalogues, problems = {}, []
    for name, path in CATALOGUES.items():
        if not path.is_file():
            print(f"missing catalogue: {path}", file=sys.stderr)
            return 1
        catalogues[name] = json.loads(io.open(path, encoding="utf-8").read())

    consumer_text = "".join(io.open(path, encoding="utf-8").read() for path in consumers())

    used: Counter[str] = Counter()
    where: dict[str, str] = {}
    dynamic: list[str] = []
    source_text = ""
    for path in sources():
        relative = path.relative_to(REPO_ROOT).as_posix()
        text = io.open(path, encoding="utf-8").read()
        source_text += text
        for match in CALL.finditer(text):
            key = match.group(2)
            used[key] += 1
            where.setdefault(key, f"{relative}:{text[: match.start()].count(chr(10)) + 1}")
        for match in DYNAMIC.finditer(text):
            argument = match.group(1)
            # `t(key)` with a variable cannot be checked statically -- say so rather than pretending.
            dynamic.append(f"{relative}:{text[: match.start()].count(chr(10)) + 1}: t({argument})")

    # Three ways a key reaches the UI, and all three count as "used":
    #   * `t('<key>')`                      -- counted in `used`
    #   * `'<key>'` anywhere as a literal    -- a shape/theme table, or `addCommand({ langKey: '<key>' })`,
    #                                          which SiYuan resolves through the plugin's own i18n
    #   * `this.i18n.<key>`                  -- property access, as the slash menu and dock do
    # Only a name that appears in none of those forms is dead text.
    def referenced(key: str) -> bool:
        if (
            f"'{key}'" in source_text
            or f'"{key}"' in source_text
            or f".i18n.{key}" in source_text
        ):
            return True
        # `t('<key>')` in a spec, or a spec/doc that asserts (part of) the value. A test matches a short
        # fragment (`顶层` out of a longer sentence), so a run of two or more CJK characters counts.
        # Deliberately loose: the cost of the two mistakes is not symmetric —— a too-loose rule leaves
        # dead text in a catalogue (mild), a too-strict one deletes a key a spec asserts and the UI shows
        # the raw key id (broken). The E2E suite is the authority either way.
        value = catalogues["zh_CN"].get(key, "")
        return any(run in consumer_text for run in CJK_RUN.findall(value))

    for key in sorted(used):
        for name, catalogue in catalogues.items():
            if key not in catalogue:
                problems.append(f"{where[key]}: `{key}` is not in {name}.json")
    for name, catalogue in catalogues.items():
        other = "en_US" if name == "zh_CN" else "zh_CN"
        for key in sorted(catalogue):
            if key not in catalogues[other]:
                problems.append(f"`{key}` is in {name}.json but not in {other}.json")
            if key not in used and not referenced(key):
                problems.append(f"`{key}` is in {name}.json but nothing in src/ names it")

    if args.list:
        for key in sorted(used):
            print(f"{used[key]:4d}  {key}")

    print(
        f"i18n keys: {len(used)} used in {len(sources())} file(s), "
        f"{len(catalogues['zh_CN'])} zh_CN entries, {len(catalogues['en_US'])} en_US entries"
    )
    through_tables = sorted(k for k in catalogues["zh_CN"] if k not in used and referenced(k))
    if through_tables:
        print(
            f"i18n keys: {len(through_tables)} entr(ies) reachable only through a computed key "
            f"(not verified): {', '.join(through_tables[:6])}"
            + (" …" if len(through_tables) > 6 else "")
        )
    if dynamic:
        print(f"i18n keys: {len(dynamic)} call(s) with a computed key are not checked:")
        for item in dynamic[:10]:
            print(f"  - {item}")
    if problems:
        print(f"i18n keys: {len(problems)} problem(s):")
        for item in problems:
            print(f"  - {item}")
        return 1
    print("i18n keys: ok (every used key exists in both catalogues, every entry is used)")
    return 0


if __name__ == "__main__":
    with script_log.track("check-i18n-keys"):
        sys.exit(main())
