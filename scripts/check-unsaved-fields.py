#!/usr/bin/env python3
"""Two checks over the node model: a field nothing names is dead, and a field nothing restores is visible.

The defect this exists for: `dueDate` had a control, a renderer and a `touch()` call, so it looked like a
working feature —— but no module on the read side ever produced the field again. A due date could not
survive reopening the document, and nothing in the repository could have told you that: no test covered
it and no doc mentioned it. `summaryData` and `linkLines` went the same way, and the cloze mask wrote a
private attribute SiYuan then ignored.

It reports two things, because they are not the same:

  * **dead declaration (fails)** —— a field no module in `src/` names at all. Nobody can set it and nobody
    can restore it, so it is not a feature with a storage problem, it is a leftover: `finish` described a
    passthrough the code never performed, and four `mindmap*` fields were vestigial beside the
    `localStorage` the mind map actually uses. Delete the declaration.
  * **in-session (printed, not failed)** —— a field the runtime names but no reader restores. This is
    legitimate for **view state**: `collapsed` is the fold state, it is named by `model/tree.ts` and the
    outline, and folding is deliberately not saved —— it is a way of looking at a document, not something
    the document says. It is the signature of a defect for **authored content**, which is how `dueDate`
    behaved. The check cannot tell those apart, so it does not pretend to: it prints every field in this
    category by name on every run, and a human decides.

★ What it cannot see: a field reached through a computed key or a dynamic property name, a field persisted
by a module outside `src/`, and whether a source the reader consults is itself rebuilt. It answers "does
the reader name this field", which is necessary, not sufficient —— `npm run test:e2e` covers the rest.

    python3 scripts/check-unsaved-fields.py             # the model
    python3 scripts/check-unsaved-fields.py --list      # classify every field
    python3 scripts/check-unsaved-fields.py --selftest  # the rules, no I/O
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from script_log import track  # noqa: E402

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
MODEL = REPO_ROOT / "src" / "model" / "types.ts"
IDENTIFIERS = HERE / "model-identifiers.mjs"
SRC = REPO_ROOT / "src"

# Modules that read the document back, i.e. that can restore a field after a reload.
READERS = ("src/core/map.ts", "src/siyuan/store.ts", "src/siyuan/dom-tree.ts")


def _src_files() -> list[str]:
    out = []
    for pattern in ("**/*.ts", "**/*.tsx"):
        out += [str(p.relative_to(REPO_ROOT)) for p in sorted(SRC.glob(pattern))]
    return [p for p in out if not p.endswith(".test.ts") and not p.endswith(".test.tsx")]


def _parse(files: list[str]) -> dict:
    out = subprocess.run(["node", str(IDENTIFIERS), str(MODEL)] + [str(REPO_ROOT / f) for f in files],
                         capture_output=True, text=True, check=False)
    if out.returncode != 0:
        raise SystemExit("model-identifiers.mjs failed:\n" + out.stderr.strip())
    return json.loads(out.stdout)


def classify(fields: dict, named: dict, readers: set[str]) -> dict[str, str]:
    """Pure, so `--selftest` exercises the same rules the real run does."""
    verdicts = {}
    for field in fields:
        name = field.split(".", 1)[1]
        if name not in named:
            verdicts[field] = "dead"
        elif name in readers:
            verdicts[field] = "document"
        else:
            verdicts[field] = "in-session"
    return verdicts


def selftest() -> int:
    # The field name in each case is the identifier the rules are given, so a case cannot pass by testing
    # a name no rule ever sees.
    cases = [
        ("OutlineNode.a", "a reader restores it", {"a"}, {"a"}, "document"),
        ("OutlineNode.b", "the runtime names it, no reader does", {"b"}, set(), "in-session"),
        ("OutlineNode.c", "nothing in src/ names it", set(), set(), "dead"),
    ]
    failed = 0
    for field, what, named, readers, expected in cases:
        got = classify({field: "number"}, named, readers)[field]
        ok = got == expected
        failed += 0 if ok else 1
        print(f"  {'✅' if ok else '❌'} {what}: {got}" + ("" if ok else f" (expected {expected})"))
    print(f"selftest: {'PASS' if failed == 0 else 'FAIL'} ({len(cases)} case(s), {failed} failed)")
    return 1 if failed else 0


def main() -> int:
    args = set(sys.argv[1:])
    if "--selftest" in args:
        return selftest()

    files = _src_files()
    parsed = _parse(files)
    per_file = {Path(k).as_posix(): set(v) for k, v in parsed["persistence"].items()}
    model_only = Path(MODEL).as_posix()
    # ★ A field's own declaration must not count as a use of it. Leaving the model file in this union made
    #   every declared field "named", which put the `dead` branch out of reach and made the check pass no
    #   matter what was added —— the red proof caught it (`scripts/redproof.py`).
    named: set[str] = set()
    for key, value in per_file.items():
        if key != model_only:
            named |= value
    readers: set[str] = set()
    for key, value in per_file.items():
        if key == model_only:
            continue
        if any(key.endswith(f) for f in READERS):
            readers |= value

    verdicts = classify(parsed["fields"], named, readers)
    # ★ Only the node model decides the exit code. `DocMeta` describes a document as the kernel reports it,
    #   and a field there can arrive through a spread (`{...doc}`) without being named anywhere, which no
    #   static rule can see —— so those are listed and never fail the build.
    node = {f: v for f, v in verdicts.items() if f.startswith("OutlineNode.")}
    meta_dead = sorted(f for f, v in verdicts.items() if v == "dead" and f.startswith("DocMeta."))
    dead = sorted(f for f, v in node.items() if v == "dead")
    in_session = sorted(f for f, v in node.items() if v == "in-session")

    counts: dict[str, int] = {}
    for v in verdicts.values():
        counts[v] = counts.get(v, 0) + 1
    print("unsaved fields: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))
    print(f"unsaved fields: {len(verdicts)} field(s), {len(files)} source file(s) scanned, "
          f"{len(readers)} reader identifier(s)")
    if "--list" in args:
        for field in sorted(verdicts):
            print(f"  {verdicts[field]:10} {field}")
    if in_session:
        print(f"unsaved fields: {len(in_session)} node field(s) the runtime names but no reader restores. "
              "Fine for view state, the summary/due-date defect for authored content:")
        for field in in_session:
            print(f"  · {field}")
    if meta_dead:
        print(f"unsaved fields: {len(meta_dead)} DocMeta field(s) nothing names —— structural (the kernel "
              "reports them) or dead (ours):")
        for field in meta_dead:
            print(f"  · {field}")
    if dead:
        print(f"unsaved fields: {len(dead)} node field(s) no module names at all —— a declaration nothing "
              "can set or restore:")
        for field in dead:
            print(f"  - {field}")
        print("unsaved fields: delete the declaration (docs/MAPPING.md 3.3, docs/ARCHITECTURE.md 8)")
        return 1
    print("unsaved fields: every node field is either restored by a reader or named by the runtime")
    return 0


if __name__ == "__main__":
    with track("check-unsaved-fields"):
        sys.exit(main())
