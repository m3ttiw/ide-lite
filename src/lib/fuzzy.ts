// Fuzzy subsequence matching for quick open and the command palette.
// Matches inside the file name rank above matches that need the directories.

export interface FuzzyMatch {
  score: number;
  /** Indices in the target that matched, ascending. */
  positions: number[];
}

function isBoundary(s: string, i: number): boolean {
  if (i === 0) return true;
  const p = s[i - 1];
  if (p === "/" || p === "\\" || p === "_" || p === "-" || p === "." || p === " ") return true;
  const c = s[i];
  return p >= "a" && p <= "z" && c >= "A" && c <= "Z";
}

function scorePositions(t: string, pos: number[], segStart: number): number {
  let score = 0;
  for (let i = 0; i < pos.length; i++) {
    const p = pos[i];
    score += 1;
    if (i > 0) {
      const gap = p - pos[i - 1] - 1;
      if (gap === 0) score += 6;
      else score -= Math.min(gap, 10) * 0.3;
    }
    if (p === segStart) score += 12;
    else if (isBoundary(t, p)) score += 8;
  }
  score -= Math.min(pos[0] - segStart, 20) * 0.2;
  return score;
}

/** Best greedy alignment of `q` in `tl` starting at `from` (tries several starts). */
function align(q: string, t: string, tl: string, from: number): FuzzyMatch | null {
  let best: FuzzyMatch | null = null;
  let tries = 0;
  for (let s = tl.indexOf(q[0], from); s !== -1 && tries < 12; s = tl.indexOf(q[0], s + 1), tries++) {
    const pos = [s];
    let ti = s + 1;
    let ok = true;
    for (let qi = 1; qi < q.length; qi++) {
      const j = tl.indexOf(q[qi], ti);
      if (j < 0) {
        ok = false;
        break;
      }
      pos.push(j);
      ti = j + 1;
    }
    if (!ok) break; // a later start cannot succeed either
    const score = scorePositions(t, pos, from);
    if (!best || score > best.score) best = { score, positions: pos };
  }
  return best;
}

export function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, "");
}

/** Matches a path; null when `query` is not a subsequence of it. */
export function fuzzyMatchPath(query: string, path: string): FuzzyMatch | null {
  const q = normalizeQuery(query);
  if (!q) return { score: 0, positions: [] };
  const tl = path.toLowerCase();
  const bs = path.lastIndexOf("/") + 1;
  if (!q.includes("/")) {
    const m = align(q, path, tl, bs);
    if (m) {
      const base = tl.slice(bs);
      const dot = base.lastIndexOf(".");
      const stem = dot > 0 ? base.slice(0, dot) : base;
      let score = m.score + 100;
      if (base.startsWith(q)) score += 30;
      if (stem === q || base === q) score += 40;
      return { score: score - path.length * 0.05, positions: m.positions };
    }
  }
  const m = align(q, path, tl, 0);
  if (!m) return null;
  return { score: m.score - path.length * 0.05, positions: m.positions };
}

/** Matches free text (command titles): word starts count as boundaries. */
export function fuzzyMatchText(query: string, text: string): FuzzyMatch | null {
  const q = normalizeQuery(query);
  if (!q) return { score: 0, positions: [] };
  const m = align(q, text, text.toLowerCase(), 0);
  if (!m) return null;
  return { score: m.score - text.length * 0.05, positions: m.positions };
}

export interface Ranked<T> {
  item: T;
  match: FuzzyMatch;
}

export function rank<T>(query: string, items: readonly T[], key: (t: T) => string, matcher = fuzzyMatchPath): Ranked<T>[] {
  if (!normalizeQuery(query)) return items.map((item) => ({ item, match: { score: 0, positions: [] } }));
  const out: Ranked<T>[] = [];
  for (const item of items) {
    const match = matcher(query, key(item));
    if (match) out.push({ item, match });
  }
  out.sort((a, b) => b.match.score - a.match.score || key(a.item).length - key(b.item).length || (key(a.item) < key(b.item) ? -1 : 1));
  return out;
}
