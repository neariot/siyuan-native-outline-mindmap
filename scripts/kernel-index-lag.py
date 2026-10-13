#!/usr/bin/env python3
"""Kernel index lag probe (performance dimension 4.3).

What it measures
------
After SiYuan's `insertBlock` returns, the block is **not immediately** queryable in `/api/query/sql` ——
the kernel has a periodic batch flush. This script measures that lag and uses it to check
whether the polling budgets on the plugin side are sufficient.

Why measure it
----------
There are several `for (...) { sql(); await sleep(...) }` polls on the plugin write-back path.
If a budget is smaller than the kernel's worst-case flush interval, the poll gives up before the block lands,
showing up as "the edit did nothing" with no error.

Usage
----
    python3 scripts/kernel-index-lag.py                  # uses .tmp/demo-docid.txt
    python3 scripts/kernel-index-lag.py --doc <docId>
    python3 scripts/kernel-index-lag.py --samples 16

The readings are **count-type + instant-type**, more robust than pure timing, but running it on an idle machine is still recommended.
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import threading
import time
import urllib.request

sys.path.insert(0, __file__.rsplit('/', 1)[0])
import env  # noqa: E402
import script_log  # noqa: E402

cfg = env.cfg
BASE = cfg.siyuan
TOKEN = cfg.token()

# Plugin-side polling budgets (rounds × interval ms), aligned with store.ts's
# POLL_ROUNDS / POLL_INTERVAL_MS.
# ★ Keep this in sync when changing the implementation, otherwise this script's verdict is skewed.
#   The regression test src/siyuan/poll-budget.test.ts checks that the two sides agree.
POLL_BUDGETS = [
    ('store.ts waits for listId to appear', 20 * 200),
    ('store.ts waits for parent_id to change', 20 * 200),
    ('store.ts waits for a child listItem to appear', 25 * 200),
    ('store.ts waits for the block type to land', 20 * 200),
]


def api(path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        f'{BASE}{path}',
        data=json.dumps(payload).encode(),
        headers={'Authorization': f'Token {TOKEN}', 'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def sql(stmt: str) -> list:
    return api('/api/query/sql', {'stmt': stmt}).get('data', [])


def insert_probe(doc_id: str, tag: str) -> str | None:
    """Insert one probe paragraph and return the block ID.

    ★ The ID is in `data[0].doOperations[0].id`, **not** `data[0].id`
      (the latter is undefined and makes people believe the insert failed).
    """
    r = api('/api/block/insertBlock', {
        'dataType': 'markdown', 'data': tag, 'parentID': doc_id, 'previousID': '',
    })
    ops = (r.get('data') or [{}])[0].get('doOperations') or []
    return ops[0].get('id') if ops else None


def drop(block_id: str) -> None:
    try:
        api('/api/block/deleteBlock', {'id': block_id})
    except Exception:
        pass


def measure(doc_id: str, samples: int, interval: float) -> int:
    """Insert while sampling, measuring each block's "returned → queryable" lag, plus the flush instants."""
    ids: list[str] = []
    seen: dict[str, float] = {}
    stop = threading.Event()

    def watcher() -> None:
        # ★ Sampling **must be concurrent**: sequential "insert everything, then poll" collects not a single one,
        #   because the inserts themselves are slow and by the time polling starts everything has long been flushed (measured, hit this).
        while not stop.is_set():
            for nid in [x for x in ids if x not in seen]:
                try:
                    if sql(f"SELECT id FROM blocks WHERE id='{nid}' LIMIT 1"):
                        seen[nid] = time.perf_counter()
                except Exception:
                    pass
            time.sleep(0.015)

    th = threading.Thread(target=watcher, daemon=True)
    th.start()

    t_base = time.perf_counter()
    for i in range(samples):
        nid = insert_probe(doc_id, f'index_lag_probe_{i}')
        if nid:
            ids.append(nid)
        time.sleep(interval)
    time.sleep(4.0)
    stop.set()
    th.join(timeout=1.0)

    # ★ Cleanup belongs in `finally`: the two early returns below and any raised exception used to
    #   leave every `index_lag_probe_i` paragraph inside the target document (an audit finding). A
    #   probe that outlives the run is not just untidy —— it becomes content in a document nobody
    #   asked to change.
    try:
        if not ids:
            print('  ❌ Not a single block got inserted, cannot measure', file=sys.stderr)
            return 1

        marks = sorted((seen[i] - t_base) * 1000 for i in ids if i in seen)
        print(f'\n  ── Collected the visible instant of {len(marks)}/{len(ids)} blocks')
        if not marks:
            print('  ❌ None became visible within the sampling window', file=sys.stderr)
            return 1

        # Merge flushes of the same batch (a gap < 40ms counts as the same flush)
        flush: list[float] = []
        for m in marks:
            if not flush or m - flush[-1] > 40:
                flush.append(m)
        gaps = [round(flush[i + 1] - flush[i]) for i in range(len(flush) - 1)]

        print(f'     flush instants: {[round(f) for f in flush]}')
        if gaps:
            print(f'     flush intervals: {gaps}')
            print(f'     median {statistics.median(gaps):.0f} ms'
                  f'   min {min(gaps)}   max {max(gaps)}')

        # ★ "How long you may have to wait at worst" = the maximum of the **single flush intervals**,
        #   not "the total span from the first flush to the last".
        #   The total span grows linearly with the sampling duration, and using it as the criterion makes every run come out "too tight"
        #   (measured, hit this: one run produced a fake worst value of 8998ms and flagged even a 4800ms budget red).
        worst = max(gaps) if gaps else max(marks)
        if not gaps:
            print('     (only one flush observed, using the maximum visible lag as the cost)')

        print(f'\n  ── Polling budget check (worst flush interval measured at {worst:.0f} ms)')
        bad = []
        for name, budget in POLL_BUDGETS:
            ok = budget > worst
            print(f'     {name:<32} {budget:>5} ms   {"✅ sufficient" if ok else "⚠️ too tight"}')
            if not ok:
                bad.append((name, budget))

        if bad:
            print(f'\n  ⚠️ {len(bad)} polling budgets < the worst flush interval; '
                  'they give up early in the corresponding phase')
            return 1
        print('\n  ✅ All polling budgets are sufficient')
        return 0
    finally:
        for nid in ids:
            drop(nid)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--doc', default='', help='target document ID (by default reads .tmp/demo-docid.txt)')
    ap.add_argument('--samples', type=int, default=16)
    ap.add_argument('--interval', type=float, default=0.7,
                    help='insert interval in seconds (must span several flush cycles)')
    args = ap.parse_args()

    doc = args.doc
    if not doc:
        try:
            with open('.tmp/demo-docid.txt', encoding='utf-8') as f:
                doc = f.read().strip()
        except FileNotFoundError:
            print('❌ No --doc given and .tmp/demo-docid.txt does not exist', file=sys.stderr)
            return 2
    print(f'  document: {doc}')
    return measure(doc, args.samples, args.interval)


if __name__ == '__main__':
    with script_log.track("kernel-index-lag"):
        sys.exit(main())
