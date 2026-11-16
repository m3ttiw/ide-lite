import { fuzzyMatchPath, type FuzzyMatch } from "./fuzzy";

/**
 * Wildcard patterns for quick open.
 *
 * `*` is any run of characters inside a folder or file name, `?` one character,
 * `**` anything across folders (followed by `/` it also matches no folder). Matching is
 * case-insensitive and covers the whole name: `communications*.ts` is every file
 * whose name starts with "communications" and ends with ".ts".
 *
 * A pattern without `/` is matched against the file name only. With `/` it is
 * matched against the end of the path, starting at a folder boundary
 * (`api/*.ts` finds `src/api/x.ts`); a leading `/` anchors it to the root.
 */

type Tok = { t: "lit"; c: string } | { t: "one" } | { t: "star" } | { t: "any" } | { t: "dirs" };

interface Pattern {
  toks: Tok[];
  /** Matched against the whole path (the pattern has a `/`) rather than the file name. */
  path: boolean;
  /** Leading `/`: only at the root. */
  rooted: boolean;
}

/** True when `query` is a wildcard pattern rather than a fuzzy query. */
export function hasWildcards(query: string): boolean {
  return /[*?]/.test(query);
}

function parse(query: string): Pattern {
  let p = query.trim().toLowerCase().replace(/\\/g, "/");
  const rooted = p.startsWith("/");
  if (rooted) p = p.replace(/^\/+/, "");
  const toks: Tok[] = [];
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "?") toks.push({ t: "one" });
    else if (c !== "*") toks.push({ t: "lit", c });
    else if (p[i + 1] !== "*") toks.push({ t: "star" });
    else {
      while (p[i + 1] === "*") i++;
      if (p[i + 1] === "/") {
        i++;
        toks.push({ t: "dirs" });
      } else toks.push({ t: "any" });
    }
  }
  return { toks, path: rooted || p.includes("/"), rooted };
}

// The last pattern: rank() matches one query against every file.
let cached: { query: string; pattern: Pattern } | null = null;
function patternOf(query: string): Pattern {
  if (cached?.query !== query) cached = { query, pattern: parse(query) };
  return cached.pattern;
}

// Failed (token, index) pairs, so that several `*` cannot backtrack exponentially.
let dead = new Uint8Array(1024);

/** Positions of the literal characters when `toks` matches `s` from `from` to its end. */
function matchFrom(toks: Tok[], s: string, from: number): number[] | null {
  const n = s.length;
  const w = n + 1;
  const size = (toks.length + 1) * w;
  if (dead.length < size) dead = new Uint8Array(size);
  else dead.fill(0, 0, size);
  const pos: number[] = [];

  const go = (ti: number, si: number): boolean => {
    if (ti === toks.length) return si === n;
    const k = ti * w + si;
    if (dead[k]) return false;
    const ok = step(toks[ti], ti, si);
    if (!ok) dead[k] = 1;
    return ok;
  };

  const step = (tok: Tok, ti: number, si: number): boolean => {    switch (tok.t) {
      case "lit":
        if (s[si] !== tok.c) return false;
        pos.push(si);
        if (go(ti + 1, si + 1)) return true;
        pos.pop();
        return false;
      case "one":
        return si < n && s[si] !== "/" && go(ti + 1, si + 1);
      case "star":
        // shortest first; never past a folder separator
        for (let j = si; ; j++) {
          if (go(ti + 1, j)) return true;
          if (j >= n || s[j] === "/") return false;
        }
      case "any":
        for (let j = si; j <= n; j++) if (go(ti + 1, j)) return true;
        return false;
      case "dirs":
        if (go(ti + 1, si)) return true;
        for (let j = si; j < n; j++) if (s[j] === "/" && go(ti + 1, j + 1)) return true;
        return false;
    }
  };

  return go(0, from) ? pos : null;
}

/** Matches a path against a wildcard pattern; null when it does not match. */
export function globMatchPath(query: string, path: string): FuzzyMatch | null {
  const { toks, path: whole, rooted } = patternOf(query);
  if (!toks.length) return { score: 0, positions: [] };
  const s = path.toLowerCase();
  let from = -1;
  let positions: number[] | null = null;
  if (!whole) {
    from = s.lastIndexOf("/") + 1;
    positions = matchFrom(toks, s, from);
  } else {
    // the folder boundary closest to the end: the least the wildcards have to cover
    for (let i = rooted ? 0 : s.length; i >= 0 && !positions; i--) {
      if (i > 0 && s[i - 1] !== "/") continue;
      from = i;
      positions = matchFrom(toks, s, i);
      if (rooted) break;
    }
  }
  if (!positions) return null;
  // characters covered by wildcards: the fewer, the closer to what was typed
  const wild = s.length - from - positions.length;
  return { score: -wild - path.length * 0.05, positions };
}

/** Quick open: a wildcard pattern when the query has `*` or `?`, a fuzzy query otherwise. */
export function matchPathQuery(query: string, path: string): FuzzyMatch | null {
  return hasWildcards(query) ? globMatchPath(query, path) : fuzzyMatchPath(query, path);
}
