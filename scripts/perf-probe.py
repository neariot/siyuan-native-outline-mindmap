#!/usr/bin/env python3
"""Real-device input latency probe (corresponds to section 3.2 of `.logs/perf-test-design.md`).

──────────────────────────────────────────────────────────────────
Why this script exists at all
──────────────────────────────────────────────────────────────────

The first measurement gave "plugin panel 342ms", 6.8× over the criterion, and it nearly became a major defect to go fix in the code.
A re-measurement gave only 10.9ms, more than 20× apart. The difference is **where the sampling window falls**:

    round 1 input     355 ms     ← page cold-start cost
    from round 2      9~12 ms

The first call to `execCommand('insertText')` also triggers the page's first layout, ProtyleMirror
initialization, and the paint settling after the panel mounts. SiYuan's own body editor is 292ms **as well** —— showing
this is a page-level cold cost, not something the plugin carries alone.

So this script **forces warm-up**: sample several rounds, discard the first two rounds, then look at the steady state.
Copying "measure 5 times in a row and take the median" reliably measures the cold-start number, producing an illusion that looks a lot like a bug.

──────────────────────────────────────────────────────────────────
Usage
──────────────────────────────────────────────────────────────────

    python3 scripts/perf-probe.py                     # with the default load document
    python3 scripts/perf-probe.py --doc <docId>       # specify a document
    python3 scripts/perf-probe.py --keep-open         # do not close the tab after measuring

Criterion (perf-test-design.md 3.2): keystroke to repaint < 50ms; > 100ms is a delay the user clearly perceives.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.path.insert(0, 'scripts')

from cdp import Tab, close_stale_tabs  # noqa: E402
from env import cfg  # noqa: E402
import script_log  # noqa: E402

DOCK = '[data-type="siyuan-native-outline-mindmapmindmapDock"]'

# Warm-up rounds. 2 is measured: round 1 includes the page's first layout, round 2 is still high,
# and only from round 3 is the curve completely flat. Any more is just wasted waiting.
WARMUP_ROUNDS = 2
TOTAL_ROUNDS = 7

# Maximum load average (1-minute value) allowed to start measuring.
# See "why you must look at load first" below —— this is not fastidiousness; without it the script only produces fake data.
MAX_LOAD = 2.0


def load_ok(limit: float = MAX_LOAD) -> tuple[bool, float, str]:
    """Confirm the machine is not occupied by something else before measuring latency. Returns (measurable, 1-minute load, explanation)."""
    cores = os.cpu_count() or 1
    try:
        load1 = os.getloadavg()[0]
    except (OSError, AttributeError):  # unreadable inside some containers
        return True, 0.0, 'cannot read load average, skipping the check'
    budget = limit * cores
    if load1 <= budget:
        return True, load1, 'ok'
    return (
        False,
        load1,
        f'load average {load1:.1f} exceeds {cores} cores × {limit:g} = {budget:g}, '
        f'the machine is occupied by something else',
    )


def free_mem_mb() -> int:
    """Available memory (MiB). Tight memory triggers swap, and the latency numbers get inflated into meaninglessness."""
    try:
        info = {}
        with open('/proc/meminfo') as f:
            for line in f:
                k, _, rest = line.partition(':')
                info[k] = int(rest.split()[0])
        return info.get('MemAvailable', 0) // 1024
    except (OSError, ValueError, IndexError):
        return -1


# ──────────────────────────────────────────────────────────────────
# Why you must look at load first
#
# This machine has 4 cores, yet runs 3,600+ processes and 32,000+ threads year round, its load average sits at
# 30~47, and free memory is often down to just over a hundred MiB (kswapd has already burned two hours of CPU thrashing).
#
# Measuring latency on such a machine, the same operation can come out as:
#
#     one input in the plugin panel   342 ms   (6.8× the criterion, it looks like a major defect)
#     same, re-measured a round later     10.9 ms
#     same, re-measured another round later     75 ms
#     first input in the SiYuan body 6893 ms
#
# A 600× spread. All of it is machine load, not code.
# I nearly went and changed the rendering logic based on that 342ms —— which would have broken perfectly good code
# to "fix" a problem that does not exist at all.
#
# So this script would rather refuse to produce a number than hand you noise that gets taken as a conclusion.

INP_BUDGET_MS = 50.0  # criterion from perf-test-design.md 3.2


def probe_js() -> str:
    """The sampling logic that runs inside the page. One eval produces the result, avoiding several round trips broken by a CDP timeout."""
    return """
(() => {
  function probe(sel) {
    const root = document.querySelector(sel);
    if (!root) return { sel, err: 'no-root' };
    const cells = [...root.querySelectorAll('[contenteditable]')];
    if (!cells.length) return { sel, err: 'no-cell' };
    const el = cells[Math.floor(cells.length / 2)];
    el.focus();
    const rounds = [];
    for (let i = 0; i < %(total)d; i++) {
      const t0 = performance.now();
      try { document.execCommand('insertText', false, 'X'); } catch (e) {}
      // force a full-page reflow, measuring the synchronous layout cost (equivalent to a lower bound for "until the next paint")
      void document.body.offsetHeight;
      rounds.push(Math.round((performance.now() - t0) * 10) / 10);
    }
    const warm = rounds.slice(%(warmup)d).sort((a, b) => a - b);
    return {
      sel,
      cells_count: cells.length,
      rounds: rounds,
      median: warm[Math.floor(warm.length / 2)],
      min: warm[0],
      max: warm[warm.length - 1],
    };
  }
  return JSON.stringify([
    probe('.protyle-wysiwyg'),
    probe('.om-mm-host'),
  ]);
})()
""" % {'total': TOTAL_ROUNDS, 'warmup': WARMUP_ROUNDS}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--doc', default='', help='target document ID')
    ap.add_argument('--keep-open', action='store_true')
    ap.add_argument('--force', action='store_true',
                    help='measure anyway when the machine is very busy (refused by default)')
    args = ap.parse_args()

    doc_id = args.doc
    if not doc_id:
        print('  specify a document with --doc <docId> (load document: see src/perf/loadgen.ts)')
        return 2

    # Look at the machine state first, then decide whether to open a browser
    ok, load1, why = load_ok()
    mem = free_mem_mb()
    cores = os.cpu_count() or 1
    print()
    print('  ── machine state')
    print('     %d cores    load average %.1f    available memory %s' % (
        cores, load1, ('%d MiB' % mem) if mem >= 0 else 'unknown'))
    if not ok and not args.force:
        print()
        print('  ❌ refusing to measure: %s' % why)
        print("     latency measured in this state is machine load, not this plugin's performance.")
        print('     Wait until the machine is idle, or add --force to measure anyway (discount the result yourself).')
        return 3
    if not ok:
        print('     ⚠️  %s —— continuing because of --force, the result is not trustworthy' % why)

    close_stale_tabs()
    # ★ The URL comes from env.py like every other caller — no hand assembly, no --port override
    #   pointing the probe at another instance (AGENTS 5.1: one legitimate source for addresses).
    t = Tab(
        cfg.build_url('desktop', doc_id),
        w=1400, h=900,
        ready="!!document.querySelector('.protyle-wysiwyg')",
        wait=120,
    )
    time.sleep(8)
    t.ev(
        "(()=>{const d=document.querySelector('%s');"
        "const c=(d&&d.className)||'';"
        "if(d && !c.includes('active')) d.click();})()" % DOCK
    )

    for _ in range(120):
        try:
            if int(t.ev("document.querySelectorAll('.om-mm-host .node-row').length")) > 0:
                break
        except Exception:
            pass
        time.sleep(0.5)
    # The paint settling after the panel mounts also counts as warm-up
    time.sleep(4)

    raw = json.loads(t.ev(probe_js()))
    print()
    print('  ── input latency probe (%d rounds, first %d are warm-up)' % (TOTAL_ROUNDS, WARMUP_ROUNDS))
    print()
    for row in raw:
        if 'err' in row:
            print('  %-22s %s' % (row['sel'], row['err']))
            continue
        verdict = '✅' if row['median'] < INP_BUDGET_MS else '❌ over criterion'
        print('  %-22s cells %-5d steady median %6.1f ms  [%s]' % (
            row['sel'], row['cells_count'], row['median'], verdict))
        print('  %-22s rounds %s' % ('', row['rounds']))
    print()
    print('  criterion: keystroke to repaint < %.0f ms (perf-test-design.md 3.2)' % INP_BUDGET_MS)

    if not args.keep_open:
        t.close()
    return 0


if __name__ == '__main__':
    with script_log.track("perf-probe"):
        raise SystemExit(main())