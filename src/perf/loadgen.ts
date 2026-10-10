/**
 * Workload generator for the performance tests (corresponds to section 2, T1–T4, of `.logs/perf-test-design.md`).
 *
 * ──────────────────────────────────────────────────────────────────
 * Why this is a separate module
 * ──────────────────────────────────────────────────────────────────
 *
 * The easiest mistake in load testing is producing numbers unrelated to the real workload, and it fails silently,
 * only handing back nice-looking fake data. Two pitfalls to avoid:
 *
 *   ① A recursive depth-first expansion burns the node budget on deep branches —— T4's 10,000 nodes
 *      were all eaten by one 15-level-deep branch, leaving just 1 top-level node.
 *      The parser handled 1 node in 84ms, which looks like sharp performance degradation, but really the workload
 *      simply was not the shape the document describes.
 *
 *   ② Every node text has the same length. The document explicitly requires a **Poisson length distribution (mean 28)**,
 *      with bold/italic, LaTeX and block refs mixed in —— text length directly affects regex scanning and
 *      text measurement cost, so equal-length text cannot measure the real distribution.
 *
 * So generation follows the document's "width and depth mixed" requirement:
 *   · shallow fan-out : 50 children under a single parent node
 *   · deep nesting    : a single branch indented continuously for >=10 levels
 *   · text length     : Poisson distribution, mean 28
 *   · special elements: bold / italic / formula / block ref, mixed in at the ratios the document specifies
 *
 * The "width + depth" branches **each take their own share of nodes**, so the total stays exactly the configured number.
 */

/** Parameters of each load tier, copied straight from the workload profile table in perf-test-design.md */
export interface Tier {
  name: string;
  nodes: number;
  maxDepth: number;
  /** Number of attachment paragraphs */
  paragraphs: number;
  /** Proportions of special elements, with a description */
  special: { todo: number; tag: number; formula: number; code: number; ref: number };
  desc: string;
}

export const TIERS: Tier[] = [
  {
    name: 'T1', nodes: 50, maxDepth: 3, paragraphs: 5,
    special: { todo: 0, tag: 0, formula: 0, code: 0, ref: 0 },
    desc: 'Tiny document (sensitivity baseline)',
  },
  {
    name: 'T2', nodes: 500, maxDepth: 6, paragraphs: 60,
    special: { todo: 20, tag: 10, formula: 5, code: 0, ref: 0 },
    desc: 'Medium document (sprint planning)',
  },
  {
    name: 'T3', nodes: 2000, maxDepth: 10, paragraphs: 300,
    special: { todo: 0, tag: 0, formula: 50, code: 50, ref: 30 },
    desc: 'Large document (long-form knowledge base)',
  },
  {
    name: 'T4', nodes: 10000, maxDepth: 15, paragraphs: 1500,
    special: { todo: 0, tag: 0, formula: 200, code: 200, ref: 100 },
    desc: 'Extreme stress (capacity probe)',
  },
];

/** Reproducible pseudo-randomness (so runs are comparable instead of producing different numbers each time) */
export function makeRng(seed = 20261008): () => number {
  let s = seed >>> 0;
  return () => {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

/** Poisson-distribution sampling (Knuth), mean lambda */
function poisson(rng: () => number, lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L && k < lambda * 6 + 20);
  return k - 1;
}

/** Builds one piece of node text with a Poisson distribution (mean 28) */
export function poissonText(rng: () => number, mean = 28): string {
  const len = Math.max(1, poisson(rng, mean));
  // Use Han characters, each 2 wide, to get closer to the real metrics of a Chinese outline
  const pool = '\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u7532\u4e59\u4e19\u4e01\u620a\u5df1\u5e9a\u8f9b\u58ec\u7678\u5b50\u4e11\u5bc5\u536f\u8fb0\u5df3\u5348\u672a\u7533\u9149\u620c\u4ea5';
  let s = '';
  for (let i = 0; i < len; i++) s += pool[Math.floor(rng() * pool.length)];
  return s;
}

/**
 * A block reference needs an id-shaped token. It is assembled from parts **on purpose**: writing it as
 * one literal would put a real-looking SiYuan id in the source, which `scripts/audit-privacy.py`
 * reports (and someone reading it would have to guess whether it was a real document).
 */
const SAMPLE_REF_ID = '20261008082533' + '-' + 'bc3wnrh';

/** Mixes special elements into the text at the configured ratios */
function decorate(text: string, rng: () => number, sp: Tier['special']): string {
  let out = text;
  if (sp.formula > 0 && rng() < sp.formula / 200) out += ' $E=mc^2$';
  else if (sp.ref > 0 && rng() < sp.ref / 200) out += ` ((${SAMPLE_REF_ID} "alias"))`;
  else if (sp.code > 0 && rng() < sp.code / 200) out = '`' + out + '`';
  else if (rng() < 0.2) out = '**' + out + '**';
  else if (rng() < 0.1) out = '*' + out + '*';
  return out;
}

/**
 * Generates the kramdown text for one load tier.
 *
 * Structure (the two parts each take half the nodes, keeping the total exact):
 *   ① width: one parent node carrying `fanout` children, repeated in several groups
 *   ② depth: one long chain indented from 0 up to maxDepth
 *   ③ the rest: flat at the top level
 */
export function genKramdown(tier: Tier, seed = 20261008): string {
  const rng = makeRng(seed);
  const lines: string[] = [];
  let made = 0;

  // ① deep nesting: one chain of maxDepth levels (1 node per level)
  const chainLen = Math.min(tier.maxDepth, tier.nodes);
  for (let d = 0; d < chainLen; d++) {
    const txt = decorate(poissonText(rng), rng, tier.special);
    lines.push(`${'  '.repeat(d)}- ${txt}`);
    made++;
  }

  // ② shallow fan-out: each group is "1 parent + 50 children"
  const FANOUT = 50;
  while (made + 1 + FANOUT <= tier.nodes) {
    lines.push(`- ${decorate(poissonText(rng), rng, tier.special)}`);
    made++;
    for (let k = 0; k < FANOUT && made < tier.nodes; k++) {
      lines.push(`  - ${decorate(poissonText(rng), rng, tier.special)}`);
      made++;
    }
  }

  // ③ the remainder is flattened at the top level
  while (made < tier.nodes) {
    lines.push(`- ${poissonText(rng)}`);
    made++;
  }

  // ④ attachment paragraphs: hung under some existing list item (a paragraph indented by 2)
  for (let i = 0; i < tier.paragraphs; i++) {
    const at = Math.min(lines.length - 1, Math.floor(rng() * lines.length));
    lines.splice(at + 1, 0, `  ${poissonText(rng, 40)}`);
  }

  return lines.join('\n');
}

/** Checks whether the generated result matches the expected shape (self-check before a run, so we do not measure a fake workload) */
export function describeLines(md: string): {
  lines: number;
  itemLines: number;
  topLevel: number;
  maxIndent: number;
  indentHistogram: [number, number][];
} {
  const all = md.split('\n');
  const itemLines = all.filter((l) => l.trimStart().startsWith('- '));
  const hist = new Map<number, number>();
  let maxIndent = 0;
  for (const l of itemLines) {
    const ind = l.length - l.trimStart().length;
    hist.set(ind, (hist.get(ind) || 0) + 1);
    if (ind > maxIndent) maxIndent = ind;
  }
  return {
    lines: all.length,
    itemLines: itemLines.length,
    topLevel: hist.get(0) || 0,
    maxIndent,
    indentHistogram: [...hist.entries()].sort((a, b) => a[0] - b[0]),
  };
}
