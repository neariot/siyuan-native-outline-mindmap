#!/usr/bin/env python3
"""Kernel block-level operation throughput probe (performance dimension 4.2).

What it measures
------
1. The inherent cost of a single `updateBlock` / `insertBlock` (including a pure HTTP baseline);
2. The difference between N serial and N concurrent calls, used to judge whether the bottleneck is the network or the **kernel's serial transactions**.

Why measure it
----------
One write-back from the plugin fires N independent HTTP requests. If the bottleneck is the network round trip,
concurrency pays off; if the bottleneck is the kernel's serial transactions, concurrency is useless,
and the only direction for optimization is "write fewer times".

Usage
----
    python3 scripts/kernel-mutation-throughput.py
    python3 scripts/kernel-mutation-throughput.py --doc <docId> --n 10

★ Measuring "the inherent cost of a single call" requires the object to be in a **steady state** (repeatedly updating the same batch of already-loaded blocks).
  Rotating through different cold blocks measures 11.4ms; steady state is only 7~9ms —— a 50% difference,
  enough to flip the judgement of "is it worth optimizing".
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, __file__.rsplit('/', 1)[0])
import env  # noqa: E402
import script_log  # noqa: E402

cfg = env.cfg
BASE = cfg.siyuan
TOKEN = cfg.token()


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


def insert(doc_id: str, text: str) -> str | None:
    r = api('/api/block/insertBlock', {
        'dataType': 'markdown', 'data': text, 'parentID': doc_id, 'previousID': '',
    })
    ops = (r.get('data') or [{}])[0].get('doOperations') or []
    return ops[0].get('id') if ops else None


def update(block_id: str, text: str) -> dict:
    return api('/api/block/updateBlock', {
        'dataType': 'markdown', 'data': text, 'id': block_id,
    })


def drop(block_id: str) -> None:
    try:
        api('/api/block/deleteBlock', {'id': block_id})
    except Exception:
        pass


def p50(ts: list[float]) -> float:
    return sorted(ts)[len(ts) // 2]


def measure(doc_id: str, n: int) -> int:
    """Run the measurements.

    ★ Probe blocks must be cleaned up **unconditionally** —— wrap the whole measurement in try/finally.
      Originally drop() ran only at the end of the normal path, so a mid-way `return 1` (too few probes) or a thrown exception
      left the residue sitting in the user's document. Measured: this script once left
      22 temporary probe blocks in a demo document, messing the document up and still needing manual cleanup.
    """
    probe: list[str] = []
    try:
        probe = [x for x in (insert(doc_id, f'throughput_probe_{i}') for i in range(n)) if x]
        if len(probe) < 2:
            print('  ❌ Not enough probe blocks, cannot measure', file=sys.stderr)
            return 1
        return _run(probe, n)
    finally:
        for b in probe:
            drop(b)
        print(f'  (cleaned up {len(probe)} probe blocks)')


def _run(probe: list[str], n: int) -> int:
    print(f'  {len(probe)} probe blocks')

    print('\n  ── Inherent cost of a single call (15 each, steady state)')
    base = []
    for _ in range(15):
        t0 = time.perf_counter()
        sql("SELECT id FROM blocks WHERE id='__none__' LIMIT 1")
        base.append((time.perf_counter() - t0) * 1000)
    baseline = p50(base)
    print(f'     empty SQL query (pure HTTP baseline)   p50 {baseline:6.1f} ms')

    ts = []
    for i in range(15):
        t0 = time.perf_counter()
        update(probe[i % len(probe)], f'warm_{i}')
        ts.append((time.perf_counter() - t0) * 1000)
    single = p50(ts)
    kernel = single - baseline
    print(f'     updateBlock (steady state)          p50 {single:6.1f} ms')
    print(f'     ⇒ network {baseline:.1f} ms + kernel-side transaction {kernel:.1f} ms'
          f' (kernel accounts for {kernel / single * 100:.0f}%)')

    print(f'\n  ── Serial vs concurrent ({n} blocks)')
    serial = []
    # ★ Index modulo the blocks that actually exist: failed inserts are filtered out above, so
    #   `probe` may be shorter than n — indexing it to n-1 raises IndexError mid-measurement
    #   (the warm-up loop below already does `probe[i % len(probe)]` for the same reason).
    for _ in range(3):
        t0 = time.perf_counter()
        for i in range(n):
            update(probe[i % len(probe)], f'serial_{i}')
        serial.append((time.perf_counter() - t0) * 1000)
    s = p50(serial)
    print(f'     serial                   {s:7.1f} ms')

    conc = []
    for _ in range(3):
        t0 = time.perf_counter()
        with ThreadPoolExecutor(8) as ex:
            list(ex.map(lambda i: update(probe[i % len(probe)], f'concurrent_{i}'), range(n)))
        conc.append((time.perf_counter() - t0) * 1000)
    c = p50(conc)
    print(f'     concurrent, 8 threads     {c:7.1f} ms')
    print(f'     → speedup {s / c:.2f}×')
    # Measure the jitter as "each sample relative to its own min", to avoid being affected by the absolute magnitude
    def spread_of(xs: list[float]) -> float:
        lo = min(xs)
        return (max(xs) - lo) / lo if lo else 0.0
    spread = max(spread_of(serial), spread_of(conc))

    print('\n  ── Reading')
    print(f'     serial samples {[round(x) for x in sorted(serial)]}')
    print(f'     concurrent samples {[round(x) for x in sorted(conc)]}')
    ratio = s / c
    if spread > 0.25:
        print(f'     ⚠️ The concurrent/serial ratio **fluctuates by {spread:.0%}**,')
        print('        a single reading is not enough to tell whether concurrency pays off —— this item **draws no conclusion**.')
        print('        What is stable is "the per-call cost" and "N serial ≈ N × one call".')
    elif ratio < 1.2:
        print('     Concurrency gives almost no gain ⇒ the bottleneck tends to be the kernel processing write transactions in order.')
    else:
        print('     Concurrency pays off ⇒ the network round trip is a sizable share.')
    print(f'\n     The stable, usable conclusion: {n} serial ≈ {s:.0f} ms'
          f' (about {s / n:.1f} ms each, linear, no bulk discount)')
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--doc', default='')
    ap.add_argument('--n', type=int, default=10)
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
    return measure(doc, args.n)


if __name__ == '__main__':
    with script_log.track("kernel-mutation-throughput"):
        sys.exit(main())
