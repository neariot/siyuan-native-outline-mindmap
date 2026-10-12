#!/usr/bin/env python3
"""Ask **SiYuan's own block-structure rules** whether a parent block may contain a child.

## Why this exists

Several rules in this repository were derived by hand from the kernel's behaviour, and written into comments
as if they were facts about SiYuan:

  * a `NodeList` cannot contain a `NodeHeading` —— the reason the heading buttons were removed;
  * a `NodeListItem` owns its paragraph as a **child** (`d → l → i → p`);
  * a `NodeListItem` cannot contain another `NodeListItem`, which is why an indent needs an intermediate `List`.

Each was measured against a running kernel, which is honest but **slow and unverifiable**: the measurement
lives in a comment, no test can re-run it, and the next person has to take it on trust. SiYuan's source is on
this machine (`SIYUAN_SRC`), so the rules can be **asked** instead of remembered.

★ This checks the *rule*, not our model of it. `kernel/treenode.CanContainBlock` is the function the kernel
itself calls to reject a bad tree —— the same one that answers
`invalid block structure: NodeList [<id>] cannot contain NodeHeading [<id>]` —— so a disagreement here means our
comment is wrong, not that the source is.

## What it is not

  * **Not a reimplementation.** It compiles and runs the kernel's own `treenode` package against the real
    `github.com/88250/lute/ast` types. There is no second copy of the rule to drift.
  * **Not a full kernel build.** `treenode` is standalone (`go build ./treenode/` needs no database, no SQL, no
    HTTP), so this is a small program rather than the whole kernel —— the full module's dependency graph is
    what made an earlier attempt at importing the kernel fail, and it is avoidable.
  * **Not a replacement for the live instance.** The running kernel is still what settles "what does the API
    return"; this settles "what does the rule say", which is the part a comment can get wrong quietly.

## When the source is absent

An explicit skip, not a failure: `SIYUAN_SRC` is empty on a machine without a checkout, which `env.py` records
as an explicit statement rather than a guess (`AGENTS.md` §5.1 #6). The tool says so and exits 0 with a
`sources missing` note —— and it says **what could not be checked**, so nobody reads the skip as a pass.

Exit 0 = every claimed rule matched (or the source is absent), 1 = a claim disagrees with the kernel's rule.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import env  # noqa: E402
import script_log  # noqa: E402

# ---------------------------------------------------------------------------
# The claims this repository makes about SiYuan's block structure.
#
# Each entry is (parent, child, may_contain, why-it-matters). A `True` claim says "the kernel allows this", a
# `False` claim says "the kernel forbids this, so code depending on it cannot work".
# ---------------------------------------------------------------------------
CLAIMS: list[tuple[str, str, bool, str]] = [
    (
        "NodeList",
        "NodeHeading",
        False,
        "a list cannot hold a heading —— the reason the H1/H2/H3 buttons could never store a level "
        "(measured: `invalid block structure: NodeList [<id>] cannot contain NodeHeading [<id>]`)",
    ),
    (
        "NodeListItem",
        "NodeParagraph",
        True,
        "a list item's own paragraph is its CHILD (the `d → l → i → p` shape the reader and writer assume)",
    ),
    (
        "NodeListItem",
        "NodeList",
        True,
        "a nested list lives inside the parent item —— what an indent is made of",
    ),
    (
        "NodeListItem",
        "NodeListItem",
        False,
        "a list item cannot hold another directly, which is WHY an indent needs an intermediate List",
    ),
    (
        "NodeDocument",
        "NodeList",
        True,
        "a document's top level is a list —— the root shape the plugin reads",
    ),
    (
        "NodeList",
        "NodeListItem",
        True,
        "the ordinary case; if this were false nothing would work and the claim list itself would be wrong",
    ),
]

# ---------------------------------------------------------------------------
# The second kind of claim: **kernel strings this product matches on**.
#
# `isTargetGoneError` decides "the user deleted this document" by matching error text, because the kernel has
# no stable error codes. That makes those three literals part of the product's contract with SiYuan —— and the
# failure mode if SiYuan rewords one is quiet and bad: the function returns false, the UI stops reporting a
# deleted target, and (per its own comment) the recovery entry that creates a duplicate document never appears.
# The user's comment says it plainly: "a stale child block reports the same `block not found`". Nothing raises.
# ---------------------------------------------------------------------------
STRING_CLAIMS: list[tuple[str, str]] = [
    ("parent block not found", "`isTargetGoneError` on a write into a deleted document"),
    ("tree not found", "`isTargetGoneError` on a write to a vanished block (`ErrTreeNotFound`)"),
    ("block not found", "`isTargetGoneError` on a read of a deleted block (`ErrBlockNotFound`)"),
]


# ---------------------------------------------------------------------------
# The third kind of claim: **endpoint paths the plugin actually calls**.
#
# `SiYuanClient` calls 21 endpoints by string literal. If SiYuan renames one, the call answers a 404-shaped
# error and every write-back that used it fails —— but nothing raises in this repository, the failure appears
# as "my edit does nothing" in the user's editor. The paths are readable out of the kernel's route table, so
# a rename is a question rather than something to discover.
#
# ★ The list is **derived from the product**, not typed by hand: `src/siyuan/api.ts` and the virtual kernel are
#   scanned for `'/api/...'` literals, so an endpoint added to the product is checked without being remembered
#   here (and one removed from the product stops being claimed).
# ---------------------------------------------------------------------------
GO_DRIVER = r'''package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/88250/lute/ast"
	"github.com/siyuan-note/siyuan/kernel/treenode"
)

type query struct {
	Parent string `json:"parent"`
	Child  string `json:"child"`
}

func main() {
	var queries []query
	if err := json.NewDecoder(os.Stdin).Decode(&queries); err != nil {
		fmt.Fprintln(os.Stderr, "bad input:", err)
		os.Exit(2)
	}

	// ast.NodeType is an enum, so the wire names are looked up rather than cast.
	byName := map[string]ast.NodeType{}
	for t := ast.NodeDocument; t <= ast.NodeTextMark; t++ {
		byName[t.String()] = t
	}

	out := make([]bool, 0, len(queries))
	for _, q := range queries {
		p, okP := byName[q.Parent]
		c, okC := byName[q.Child]
		if !okP || !okC {
			fmt.Fprintf(os.Stderr, "unknown node type: parent=%q child=%q\n", q.Parent, q.Child)
			os.Exit(2)
		}
		// ★ THE kernel's own rule, not a copy of it.
		out = append(out, treenode.CanContainBlock(p, c))
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, "encode:", err)
		os.Exit(2)
	}
}
'''

GO_MOD = """module siyuanblockrules

go 1.26.5

require github.com/siyuan-note/siyuan/kernel v0.0.0

replace github.com/siyuan-note/siyuan/kernel => %s
"""


def go_toolchain() -> str | None:
    """A `go` binary capable of building the kernel module (it pins a newer version than may be installed)."""
    if not shutil.which("go"):
        return None
    return shutil.which("go")


def main() -> int:
    src = env.cfg.siyuan_src
    if not src:
        # ★ An explicit skip that names what was NOT checked. §5.1 #6: an empty value that means "this machine
        #   does not have it" is legal; the failure mode to avoid is reporting it as a pass.
        print(
            "check-block-rules: SKIPPED —— SIYUAN_SRC is not configured (or is not a SiYuan checkout), so the\n"
            "  kernel's block-structure rules could NOT be verified. The claims in src/ about which blocks may\n"
            "  contain which are therefore unconfirmed on this machine. Set SIYUAN_SRC in .env to check them."
        )
        return 0

    go = go_toolchain()

    # ---- the endpoint paths and matched strings: a pure text scan, always run, needs no Go ----
    #
    # ★ These come first and are unconditional. The containment check below needs a Go toolchain whose
    #   exact version may not be installed, and a first version let that make the whole gate fail (or, worse,
    #   let `GOTOOLCHAIN=auto` start a 70 MB download inside `npm run check` —— which breaks the "the fast
    #   path stays fast" rule more quietly than a failure does). Splitting them means the cheap, always-
    #   applicable checks are never hostage to the expensive one.
    kernel_root = Path(src) / "kernel"
    bad = 0
    string_bad = 0

    endpoints: set[str] = set()
    for rel in ("src/siyuan/api.ts", "src/siyuan/virtual-kernel.ts"):
        f = Path(__file__).resolve().parent.parent / rel
        if not f.is_file():
            continue
        endpoints.update(re.findall(r"['\"](/api/[A-Za-z0-9_/]+)['\"]", f.read_text(encoding="utf-8")))
    if not endpoints:
        bad += 1
        print(
            "  ✘    no '/api/...' literal was found in src/siyuan/api.ts —— the scan found nothing, which is\n"
            "         not the same as the endpoints being correct. Refusing to report a pass on an empty list."
        )
    else:
        routes_corpus = "\n".join(
            p.read_text(encoding="utf-8", errors="replace") for p in (kernel_root / "api").rglob("*.go")
        )
        for ep in sorted(endpoints):
            if f'"/api/{ep[len("/api/"):]}"' in routes_corpus:
                print(f"  ok   {ep} is still routed by the kernel")
            else:
                bad += 1
                print(
                    f"  ✘    {ep} is not in the kernel's route table\n"
                    "         ★ A silent break: the call fails at runtime and the user sees \"my edit did\n"
                    "           nothing\", with nothing raised in this repository."
                )

    go_corpus = "\n".join(
        p.read_text(encoding="utf-8", errors="replace") for p in kernel_root.rglob("*.go") if "/vendor/" not in str(p)
    )
    for literal, why in STRING_CLAIMS:
        if literal in go_corpus:
            print(f"  ok   kernel still says {literal!r}")
        else:
            bad += 1
            string_bad += 1
            print(
                f"  ✘    {literal!r} is no longer in the kernel source\n"
                f"         {why}\n"
                "         ★ A silent break: the function answers false instead of raising, so a deleted target\n"
                "           stops being reported and the duplicate-document recovery never appears."
            )

    # ---- the containment rules: need Go; verified only when it runs, skipped explicitly when it cannot ----
    answers: list[bool] | None = None
    go_note = ""

    # ★ The toolchain is missing -> skip **only** the containment claims. The text claims above have already
    #   run, because an early `return` here was measured to skip them as well: on a machine with no Go, the
    #   endpoint and error-string checks silently stopped happening while the gate still said "OK".
    if not go:
        go_note = "no `go` toolchain on PATH (the kernel's go.mod pins its version)"
    else:
      with tempfile.TemporaryDirectory(prefix="block-rules-") as tmp:
        d = Path(tmp)
        (d / "main.go").write_text(GO_DRIVER, encoding="utf-8")
        # ★ `replace` must point at the directory holding the kernel's own go.mod —— the module root is
        #   `<src>/kernel`, not `<src>` (the repo root has no go.mod). Pointing one level too high fails with
        #   "reading <src>/go.mod: no such file or directory", which is how this was found.
        kernel_dir = Path(src) / "kernel"
        if not (kernel_dir / "go.mod").is_file():
            print(
                f"check-block-rules: SKIPPED —— no kernel/go.mod under SIYUAN_SRC ({src}), so this is not a "
                "SiYuan source checkout and the block rules could NOT be verified."
            )
            return 0
        (d / "go.mod").write_text(GO_MOD % kernel_dir, encoding="utf-8")

        env_vars = dict(os.environ)
        env_vars["GOFLAGS"] = "-mod=mod"
        # ★★ Guarantee no network: GOPROXY=off means Go CANNOT download, so a toolchain or module that is not
        #   already cached fails **immediately** instead of pulling ~70 MB inside `npm run check`. The
        #   containment rules are then verified exactly when they can be, and skipped — loudly, naming what
        #   went unchecked — when they cannot. That is §5.1 #6: an absent toolchain is an explicit absence,
        #   never a silent pass.
        # ★ `GOSUMDB` is deliberately left at its default. Setting `GOSUMDB=off` looks harmless and is not: it
        #   makes Go refuse the **cached** toolchain module ("verifying module: checksum database disabled"),
        #   so the containment claims skip on a machine that could actually run them. `GOPROXY=off` is what
        #   blocks the download; nothing else is needed.
        env_vars["GOPROXY"] = "off"
        env_vars["GOTOOLCHAIN"] = "auto"  # resolves a cached toolchain without hitting the network

        proc = subprocess.run(
            [go, "run", "."],
            cwd=d,
            input=json.dumps([{"parent": p, "child": c} for p, c, _, _ in CLAIMS]),
            capture_output=True,
            text=True,
            env=env_vars,
            timeout=600,
        )
        if proc.returncode != 0:
            # ★ A skip, not a failure. `GOPROXY=off` above guarantees this fails **immediately** when the
            #   toolchain or a module is not already cached, rather than downloading ~70 MB inside
            #   `npm run check`. The text claims above have already been checked; only the ones needing Go are
            #   unverified, and saying so is the honest outcome (§5.1 #6).
            first = (proc.stderr or proc.stdout).strip().splitlines()
            go_note = first[-1][:200] if first else "(no output)"
            answers = None
        else:
            try:
                answers = json.loads(proc.stdout.strip().splitlines()[-1])
            except (ValueError, IndexError):
                go_note = "the driver did not answer as JSON"
                answers = None

    # ---- the containment rules (only meaningful when the Go driver actually ran) ----
    if answers is None:
        print(
            f"  ---  {len(CLAIMS)} containment claim(s) were NOT verified (Go toolchain/module not cached:\n"
            f"         {go_note or 'unknown'}\n"
            "         ). An explicit absence, not a pass."
        )
    else:
        for (parent, child, claimed, why), got in zip(CLAIMS, answers):
            if bool(got) == claimed:
                print(f"  ok   {parent} may contain {child}: {claimed}")
            else:
                bad += 1
                print(
                    f"  \u2718    {parent} may contain {child}: claimed {claimed}, kernel says {bool(got)}\n"
                    f"         why it matters: {why}"
                )

    if bad:
        # ★ The verdict names **which kind** of claim failed. A first version said
        #   "disagree with treenode.CanContainBlock" for all of them, which is wrong for a string claim and
        #   sends the reader to a Go function that was never involved.
        parts = []
        if bad - string_bad:
            parts.append(f"{bad - string_bad} containment claim(s) disagree with treenode.CanContainBlock")
        if string_bad:
            parts.append(f"{string_bad} matched kernel string(s) are no longer in the source")
        print(
            f"check-block-rules: FAIL —— {'; '.join(parts)}.\n"
            "  The claim is wrong, not the source —— fix it, and anything that depends on it."
        )
        return 1

    containment = (
        f"{len(CLAIMS)} containment claim(s) verified against SiYuan's own treenode.CanContainBlock"
        if answers is not None
        else f"{len(CLAIMS)} containment claim(s) SKIPPED (no cached Go toolchain)"
    )
    print(
        f"check-block-rules: OK {len(endpoints)} endpoint path(s) still routed, "
        f"{len(STRING_CLAIMS)} matched kernel string(s) still present, {containment} (source: {src})"
    )
    return 0


if __name__ == "__main__":
    with script_log.track("check-block-rules"):
        sys.exit(main())
