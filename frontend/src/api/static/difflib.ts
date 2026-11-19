// A faithful port of the parts of Python's difflib the geocoder uses (SequenceMatcher.ratio and
// get_close_matches, with isjunk=None), so the static build matches addresses exactly like the server.
// Autojunk only applies to sequences of 200+ items; street keys are far shorter, so it is omitted.

type Block = [number, number, number];

export class SequenceMatcher {
  private a = '';
  private b = '';
  private b2j = new Map<string, number[]>();
  private blocks: Block[] | null = null;

  setSeqs(a: string, b: string): this {
    this.setSeq1(a);
    this.setSeq2(b);
    return this;
  }

  setSeq1(a: string): void {
    this.a = a;
    this.blocks = null;
  }

  setSeq2(b: string): void {
    this.b = b;
    this.blocks = null;
    this.b2j = new Map();
    [...b].forEach((ch, j) => {
      const list = this.b2j.get(ch);
      if (list) list.push(j); else this.b2j.set(ch, [j]);
    });
  }

  private findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Block {
    const { a, b } = this;
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of this.b2j.get(a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2len = newj2len;
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) { besti--; bestj--; bestsize++; }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  }

  private matchingBlocks(): Block[] {
    if (this.blocks) return this.blocks;
    const la = this.a.length, lb = this.b.length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const found: Block[] = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const [i, j, k] = this.findLongestMatch(alo, ahi, blo, bhi);
      if (k) {
        found.push([i, j, k]);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    found.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    // collapse adjacent blocks
    const out: Block[] = [];
    let [i1, j1, k1] = [0, 0, 0];
    for (const [i2, j2, k2] of found) {
      if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
      else { if (k1) out.push([i1, j1, k1]); [i1, j1, k1] = [i2, j2, k2]; }
    }
    if (k1) out.push([i1, j1, k1]);
    out.push([la, lb, 0]);
    return (this.blocks = out);
  }

  ratio(): number {
    const matches = this.matchingBlocks().reduce((s, [, , k]) => s + k, 0);
    const len = this.a.length + this.b.length;
    return len ? (2 * matches) / len : 1;
  }

  quickRatio(): number {
    const avail = new Map<string, number>();
    for (const ch of this.b) avail.set(ch, (avail.get(ch) ?? 0) + 1);
    let matches = 0;
    for (const ch of this.a) {
      const n = avail.get(ch) ?? 0;
      avail.set(ch, n - 1);
      if (n > 0) matches++;
    }
    const len = this.a.length + this.b.length;
    return len ? (2 * matches) / len : 1;
  }

  realQuickRatio(): number {
    const la = this.a.length, lb = this.b.length;
    return la + lb ? (2 * Math.min(la, lb)) / (la + lb) : 1;
  }
}

/** difflib.get_close_matches: best `n` candidates scoring at least `cutoff`, highest first. */
export function getCloseMatches(word: string, possibilities: string[], n = 3, cutoff = 0.6): string[] {
  const s = new SequenceMatcher();
  s.setSeq2(word);
  const result: [number, string][] = [];
  for (const x of possibilities) {
    s.setSeq1(x);
    if (s.realQuickRatio() >= cutoff && s.quickRatio() >= cutoff) {
      const r = s.ratio();
      if (r >= cutoff) result.push([r, x]);
    }
  }
  // heapq.nlargest on (score, x) tuples: ties go to the larger string
  result.sort((p, q) => q[0] - p[0] || (q[1] > p[1] ? 1 : q[1] < p[1] ? -1 : 0));
  return result.slice(0, n).map(([, x]) => x);
}
