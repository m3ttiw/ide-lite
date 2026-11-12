// Lane assignment for the commit graph. Commits arrive newest first, children
// before parents, possibly in several pages: the builder keeps its lane state
// between `add` calls so paging does not change the result.

export interface GraphCommit {
  hash: string;
  parents: string[];
}

export interface LaneRow {
  /** Column of the node. */
  col: number;
  /** Colour index of the node. */
  color: number;
  /** Columns (in `out`) that this node feeds: first parent first. */
  parentCols: number[];
  /** Hash expected by each lane below this row (null = free). */
  out: (string | null)[];
  /** Colour index of each lane below this row. */
  outColors: number[];
  /** Columns used by this row (above or below the node). */
  width: number;
}

export interface Edge {
  /** Column at this row's node height. */
  from: number;
  /** Column at the next row's node height. */
  to: number;
  color: number;
}

export class LaneBuilder {
  readonly rows: LaneRow[] = [];
  private lanes: (string | null)[] = [];
  private colors: number[] = [];
  private nextColor = 0;
  maxWidth = 0;

  constructor(private readonly palette = 8) {}

  add(commits: GraphCommit[]): void {
    for (const c of commits) this.rows.push(this.step(c));
  }

  private alloc(): number {
    let i = this.lanes.indexOf(null);
    if (i < 0) {
      i = this.lanes.length;
      this.lanes.push(null);
      this.colors.push(0);
    }
    return i;
  }

  private step(c: GraphCommit): LaneRow {
    const widthIn = this.lanes.length;
    let col = this.lanes.indexOf(c.hash);
    if (col < 0) {
      col = this.alloc();
      this.colors[col] = this.nextColor++ % this.palette;
    }
    const color = this.colors[col];
    // Other lanes waiting for this commit converge on the node and end here.
    for (let i = 0; i < this.lanes.length; i++) if (i !== col && this.lanes[i] === c.hash) this.lanes[i] = null;

    const parentCols: number[] = [];
    if (c.parents.length === 0) {
      this.lanes[col] = null;
    } else {
      this.lanes[col] = c.parents[0];
      parentCols.push(col);
      for (const p of c.parents.slice(1)) {
        let j = this.lanes.indexOf(p);
        if (j < 0) {
          j = this.alloc();
          this.lanes[j] = p;
          this.colors[j] = this.nextColor++ % this.palette;
        }
        parentCols.push(j);
      }
    }
    const width = Math.max(widthIn, this.lanes.length, col + 1);
    while (this.lanes.length > 0 && this.lanes[this.lanes.length - 1] === null) {
      this.lanes.pop();
      this.colors.pop();
    }
    if (width > this.maxWidth) this.maxWidth = width;
    return { col, color, parentCols, out: this.lanes.slice(), outColors: this.colors.slice(), width };
  }
}

export function computeLanes(commits: GraphCommit[]): LaneRow[] {
  const b = new LaneBuilder();
  b.add(commits);
  return b.rows;
}

/**
 * Lines from row `a` (node height) to the next row (node height). When the
 * next row is not loaded yet the lanes simply continue straight down.
 */
export function edgesBetween(a: LaneRow, next?: { hash: string; row: LaneRow }): Edge[] {
  const edges: Edge[] = [];
  a.out.forEach((h, i) => {
    if (h === null) return;
    const from = a.parentCols.includes(i) ? a.col : i;
    const to = next && h === next.hash ? next.row.col : i;
    edges.push({ from, to, color: a.outColors[i] });
  });
  return edges;
}
