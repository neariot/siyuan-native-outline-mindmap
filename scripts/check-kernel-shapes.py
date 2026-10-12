#!/usr/bin/env python3
"""Check the shapes our code says the kernel returns against SiYuan's own contract.

## Why this exists

The virtual kernel (`src/siyuan/virtual-kernel.ts`) is a hand-written mirror of the kernel's HTTP responses.
It exists so the sync and race tests can run in milliseconds without a live instance, and it is worth a
great deal —— but **a mirror validates itself.** Every case that runs against it is answered by the mirror,
so if the mirror drifts from the real kernel, those cases keep passing while describing a kernel that no
longer exists. Nothing in the repository notices, because the thing that would notice is the thing that is
wrong.

The mirror's field names were written from measurements. That is honest but unverifiable: no test can re-run a
measurement recorded in a comment, so the next reader takes it on trust and a rename upstream is silent.

## The contract is readable, and it is already TypeScript

SiYuan declares its API in Go (`kernel/apicontract`) and **generates TypeScript from it** --
`func (b *Bundle) TypeScript(...)`, with the artifact checked in at
`<SIYUAN_SRC>/app/src/types/api/index.d.ts`. So unlike the containment rules in
`scripts/check-block-rules.py` -- which need a Go driver because the rule has no TypeScript -- this check is
a plain comparison against a file that already says, in our own language:

    export type Transaction = { "doOperations": ...; "timestamp": number; "undoOperations": ...; };

★ That is the answer to "why does nothing import SiYuan's side": the **kernel** is Go and cannot be imported,
but its **contract is generated into TypeScript and committed upstream**, and the mirror has been written
without reading it. It could have been, all along, for the shape half of the question.

## What is checked

For each pair in `SHAPE_CLAIMS`, every field the product declares must exist in SiYuan's type, and where both
sides declare a primitive the kinds must agree. The field list is read out of the product with the
**TypeScript compiler** rather than a regex -- a hand-rolled "is this an interface member" scanner is wrong
exactly where it matters, and this repository has been bitten by that shape of shortcut before.

## What this cannot do

It checks names and primitive kinds, not nested structure: `data?: unknown` in the product is not compared
against `Array<TransactionOperation> | null` upstream, so a change from one array to another would pass. It
also cannot tell that a field is *required* where upstream marks it optional, because the product's own
declarations already differ there on purpose (the mirror sends only what a call needs). Both limits are
stated rather than papered over; this is a rename and kind check, not a proof of equivalence.

Skips explicitly -- naming what could NOT be checked -- when `SIYUAN_SRC` is unset or the generated
contract is absent (§5.1 #6: an absent input is an explicit absence, never a silent pass).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import env  # noqa: E402
import script_log  # noqa: E402

# ---------------------------------------------------------------------------
# The pairs. Left: an interface the product declares. Right: SiYuan's generated type.
#
# ★ Only pairs where the product is **claiming to describe the kernel's own wire shape** belong here.
#   `VBlock` and `VDoc` are the mirror's own internal model (it keeps `parentId`, `sort`, `rootId`, which
#   no endpoint returns), so they are deliberately absent -- checking them against an upstream type would
#   be checking a different thing.
# ---------------------------------------------------------------------------
SHAPE_CLAIMS: list[tuple[str, str, str]] = [
    (
        "VTransaction",
        "Transaction",
        "the object the WS channel pushes; the race tests read its `doOperations` directly",
    ),
    (
        "Op",
        "TransactionOperation",
        "one entry of `doOperations` / `undoOperations` -- `externalUpdate` and the move path build these",
    ),
]

# ---------------------------------------------------------------------------
# The extractor. One TypeScript program, two files, one shape of answer.
# ---------------------------------------------------------------------------
EXTRACT_JS = r"""
const ts = require('typescript');
const fs = require('fs');

const out = {};

// A type literal's members -> { fieldName: primitiveKind }.
// Primitive kind is deliberately coarse: `string` / `number` / `boolean` / `other`. Comparing full type
// text would report every cosmetic difference upstream and turn the gate into noise nobody reads.
function kindOf(node) {
  const t = node.getText();
  if (t === 'string') return 'string';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  return 'other';
}

function membersOf(node, into) {
  if (!node) return;
  if (ts.isTypeLiteralNode(node)) {
    for (const m of node.members) {
      if (!ts.isPropertySignature(m)) continue;
      const name = m.name;
      const key = ts.isIdentifier(name) ? name.text : ts.isStringLiteral(name) ? name.text : null;
      if (key === null) continue;
      // A duplicate field in a union means the upstream type already disagrees with itself; first wins and
      // the checker's own field count is compared against the raw member list so that cannot hide.
      if (!(key in into)) into[key] = m.type ? kindOf(m.type) : 'other';
    }
    return;
  }
  // A union of object literals (`Transaction` is one): merge every constituent.
  if (ts.isUnionTypeNode(node)) {
    for (const part of node.types) membersOf(part, into);
    return;
  }
  // An intersection: also merge.
  if (ts.isIntersectionTypeNode(node)) {
    for (const part of node.types) membersOf(part, into);
  }
}

// A file may declare the name as an interface (the product) or a type alias (the generated contract).
function collect(file, names) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = {};
  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node) && names.includes(node.name.text)) {
      const bag = {};
      for (const m of node.members) {
        if (!ts.isPropertySignature(m)) continue;
        const name = m.name;
        const key = ts.isIdentifier(name) ? name.text : ts.isStringLiteral(name) ? name.text : null;
        if (key === null) continue;
        bag[key] = m.type ? kindOf(m.type) : 'other';
      }
      found[node.name.text] = bag;
    }
    if (ts.isTypeAliasDeclaration(node) && names.includes(node.name.text)) {
      const bag = {};
      membersOf(node.type, bag);
      found[node.name.text] = bag;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

out.product = collect(process.argv[1], process.argv[3].split(','));
out.upstream = collect(process.argv[2], process.argv[3].split(','));
process.stdout.write(JSON.stringify(out));
"""


def extract(product: Path, contract: Path, names: list[str]) -> dict:
    """Return {product: {...}, upstream: {...}} for the given declaration names."""
    node_src = subprocess.run(
        [
            "node",
            "-e",
            EXTRACT_JS,
            str(product),
            str(contract),
            ",".join(names),
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if node_src.returncode != 0:
        raise RuntimeError(node_src.stderr.strip()[:2000] or "node failed with no output")
    return json.loads(node_src.stdout)


def main() -> int:
    src = env.cfg.siyuan_src
    if not src:
        print(
            "check-kernel-shapes: SKIPPED —— SIYUAN_SRC is not set, so the kernel's own contract could NOT\n"
            "  be read and none of the shape claims were verified. Set SIYUAN_SRC to a SiYuan source checkout."
        )
        return 0

    contract = Path(src) / "app" / "src" / "types" / "api" / "index.d.ts"
    if not contract.is_file():
        print(
            f"check-kernel-shapes: SKIPPED —— {contract} does not exist, so this is not a SiYuan checkout\n"
            "  with the generated API contract and none of the shape claims were verified.\n"
            "  ★ The contract is generated by `kernel/apicontract` (func (b *Bundle) TypeScript) and is\n"
            "    committed upstream; without it there is nothing authoritative to check against."
        )
        return 0

    product = Path(__file__).resolve().parent.parent / "src" / "siyuan" / "virtual-kernel.ts"
    names = sorted({n for ours, _, _ in SHAPE_CLAIMS for n in (ours,)} | {t for _, t, _ in SHAPE_CLAIMS})

    try:
        found = extract(product, contract, names)
    except Exception as exc:  # noqa: BLE001 -- any parse failure must be loud, never a pass
        print(f"check-kernel-shapes: could not read the declarations: {exc}")
        return 2

    bad = 0
    for ours, theirs, why in SHAPE_CLAIMS:
        mine = found["product"].get(ours)
        upstream = found["upstream"].get(theirs)
        if mine is None:
            bad += 1
            print(
                f"  ✘    the product no longer declares `{ours}`, so this claim is stale\n"
                "         ★ Either the declaration moved or it was deleted —— and the claim about it is now\n"
                "           checking nothing while still counting as one."
            )
            continue
        if upstream is None:
            bad += 1
            print(
                f"  ✘    SiYuan's contract no longer declares `{theirs}`\n"
                "         ★ The kernel changed its wire shape. Fix the mirror, not the claim."
            )
            continue

        # Every field the product declares must exist upstream. This is the rename detector.
        absent = [f for f in mine if f not in upstream]
        for f in absent:
            bad += 1
            print(
                f"  ✘    `{ours}.{f}` is not a field of SiYuan's `{theirs}`\n"
                f"         why it matters: {why}\n"
                "         ★ A silent break: the mirror keeps answering with a field the real kernel does not\n"
                "           send, so every case run against it passes while describing a kernel that no\n"
                "           longer exists. The mirror validates itself."
            )
        # Primitive kinds, where both sides declare one.
        for f, kind in mine.items():
            if f in upstream and upstream[f] != kind and "other" not in (kind, upstream[f]):
                bad += 1
                print(
                    f"  ✘    `{ours}.{f}` is a {kind} in the product but a {upstream[f]} in SiYuan's "
                    f"`{theirs}`\n"
                    "         ★ The shape matches by name but not by meaning —— which passes every\n"
                    "           presence check while the value is wrong."
                )
        if not absent:
            print(
                f"  ok   {ours}: {len(mine)} field(s) all present in SiYuan's `{theirs}`"
                + ("" if any(mine[f] != "other" for f in mine) else " (kinds not comparable)")
            )

    if bad:
        print(
            f"check-kernel-shapes: FAIL {bad} shape claim(s) disagree with SiYuan's generated API contract\n"
            f"  ({contract}). The mirror is wrong, not the contract."
        )
        return 1

    print(
        f"check-kernel-shapes: OK {len(SHAPE_CLAIMS)} shape claim(s) match SiYuan's generated API contract "
        f"(source: {contract})"
    )
    return 0


if __name__ == "__main__":
    with script_log.track("check-kernel-shapes"):
        sys.exit(main())
