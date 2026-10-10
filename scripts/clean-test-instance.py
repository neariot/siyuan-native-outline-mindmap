#!/usr/bin/env python3
"""Delete the documents left behind by test runs in the **isolated** test instance.

## Why this exists

Every E2E case and every probe creates real documents and deletes them afterwards, but a case that
fails, is interrupted, or is written before its cleanup exists leaves its document behind. After a day
of experiments the isolated instance held **126** leftovers (`rp1-1791549676673`,
`test-sql-lag-…`, `f6-…`, `E2E-结构节点测试`), which makes the instance a bad place to measure anything:
"the index is slow" and "this query returns nothing" both get harder to interpret when 126 stale
documents are in the same notebook, and the next run's cleanup becomes manual again.

## Safety

This script refuses to touch the instance the user works in. It compares the target against
`cfg.siyuan_test` and stops if they are the same address, because deleting documents in the wrong
instance is not recoverable. The default is a **dry run**: nothing is deleted until `--delete` is
passed.

## Usage

    python3 scripts/clean-test-instance.py                 # list what would be deleted
    python3 scripts/clean-test-instance.py --delete        # delete those documents
    python3 scripts/clean-test-instance.py --keep E2E      # keep documents whose title contains E2E
    python3 scripts/clean-test-instance.py --notebook <id> # restrict to one notebook

Deletion goes through `/api/filetree/removeDocByID` (the older `removeDoc` panics the kernel).

## Exit code

0 when the listing (or the deletion) succeeded; 1 when the target could not be reached or the target
looks like the user's own instance.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import script_log  # noqa: E402
from env import cfg  # noqa: E402

#: Documents are found by a read-only SQL query, always with an explicit LIMIT (AGENTS.md section 1).
DOC_QUERY = (
    "SELECT id, content, created, box FROM blocks WHERE type = 'd' "
    "ORDER BY created DESC LIMIT %d"
)


def kernel(base, token, path, payload):
    request = urllib.request.Request(
        base + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Token " + token},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--delete", action="store_true", help="actually delete (default is a dry run)")
    parser.add_argument("--keep", action="append", default=[], metavar="TEXT",
                        help="keep documents whose title contains TEXT (repeatable)")
    parser.add_argument("--notebook", help="only consider documents in this notebook id")
    parser.add_argument("--limit", type=int, default=500, help="how many documents to consider (default 500)")
    args = parser.parse_args()

    base, token = cfg.siyuan_test, cfg.test_token()
    if base.rstrip("/") == cfg.siyuan.rstrip("/"):
        print(f"refusing to run: the test instance and the user's instance are the same address ({base})",
              file=sys.stderr)
        return 1

    print(f"target: {base} (isolated test instance)")

    # Identity is enforced by two things, both measured rather than assumed:
    #   * the address guard above, and
    #   * the token, which belongs to this instance alone (it is read from that instance's conf.json).
    #     A port forward onto another kernel therefore answers 401 on the first call and this script
    #     refuses to continue -- the failure is loud, not a silent deletion somewhere else.
    # `/api/system/getConf` was tried as a workspace check and cannot do it: SiYuan reports
    # `conf.system.workspaceDir` as an empty string.
    try:
        rows = kernel(base, token, "/api/query/sql", {"stmt": DOC_QUERY % args.limit}).get("data") or []
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print(f"the isolated instance did not answer ({exc}) —— start it first, this never falls back "
              "to another instance", file=sys.stderr)
        return 1

    if len(rows) == args.limit:
        print(
            f"⚠ the query returned exactly --limit ({args.limit}) documents, so this listing may be "
            "truncated; raise --limit to see the rest",
            file=sys.stderr,
        )

    if args.notebook:
        rows = [row for row in rows if row["box"] == args.notebook]
    kept = [row for row in rows if any(word in (row["content"] or "") for word in args.keep)]
    victims = [row for row in rows if row not in kept]

    print(f"documents found: {len(rows)}   keeping: {len(kept)}   candidates: {len(victims)}")
    for row in victims[:20]:
        print(f"  {row['created'][:14]}  {row['id'][:14]}  {row['content'][:50]!r}")
    if len(victims) > 20:
        print(f"  … and {len(victims) - 20} more")

    if not args.delete:
        print("\ndry run: nothing was deleted. Add --delete to remove these documents.")
        return 0

    removed, failed = 0, []
    for row in victims:
        try:
            answer = kernel(base, token, "/api/filetree/removeDocByID", {"id": row["id"]})
        except (urllib.error.URLError, OSError, ValueError) as exc:
            failed.append(f"{row['id']}: {exc}")
            continue
        # ★ Read the body. A kernel call can refuse and still answer 200, so counting the call as a
        #   deletion reports "deleted N/N" for documents that are still there (pitfall ledger 6.19).
        if answer.get("code") not in (0, None):
            failed.append(f"{row['id']}: kernel said code={answer.get('code')} {answer.get('msg', '')}".strip())
        else:
            removed += 1

    print(f"\ndeleted {removed}/{len(victims)}")
    for problem in failed:
        print(f"  failed: {problem}")
    return 1 if failed else 0


if __name__ == "__main__":
    with script_log.track("clean-test-instance"):
        sys.exit(main())
