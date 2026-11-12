import { describe, expect, it } from "vitest";
import { LaneBuilder, computeLanes, edgesBetween, type GraphCommit } from "./lanes";

const c = (hash: string, ...parents: string[]): GraphCommit => ({ hash, parents });

function edgesOf(commits: GraphCommit[]) {
  const rows = computeLanes(commits);
  return rows.map((r, i) => edgesBetween(r, commits[i + 1] ? { hash: commits[i + 1].hash, row: rows[i + 1] } : undefined));
}

describe("lanes", () => {
  it("linear history stays in column 0", () => {
    const commits = [c("d", "c"), c("c", "b"), c("b", "a"), c("a")];
    const rows = computeLanes(commits);
    expect(rows.map((r) => r.col)).toEqual([0, 0, 0, 0]);
    expect(rows.map((r) => r.width)).toEqual([1, 1, 1, 1]);
    expect(new Set(rows.map((r) => r.color)).size).toBe(1);
    const e = edgesOf(commits);
    expect(e[0]).toEqual([{ from: 0, to: 0, color: 0 }]);
    expect(e[3]).toEqual([]); // root commit: nothing below
  });

  it("two branch tips with a common parent converge", () => {
    // f (feature tip) and m (main tip) both have parent b.
    const commits = [c("f", "b"), c("m", "b"), c("b", "a"), c("a")];
    const rows = computeLanes(commits);
    expect(rows.map((r) => r.col)).toEqual([0, 1, 0, 0]);
    expect(rows[1].color).not.toBe(rows[0].color);
    const e = edgesOf(commits);
    // between m and b: lane 0 (from f) and lane 1 (from m) both reach b at column 0
    expect(e[1]).toEqual([
      { from: 0, to: 0, color: rows[0].color },
      { from: 1, to: 0, color: rows[1].color },
    ]);
    expect(rows[2].out).toEqual(["a"]);
  });

  it("merge commit opens a lane for the second parent", () => {
    // M merges x (feature) into main; feature started at a.
    const commits = [c("M", "m1", "x"), c("x", "a"), c("m1", "a"), c("a")];
    const rows = computeLanes(commits);
    expect(rows[0].col).toBe(0);
    expect(rows[0].parentCols).toEqual([0, 1]);
    expect(rows[1].col).toBe(1); // x sits in the lane opened by the merge
    expect(rows[2].col).toBe(0);
    expect(rows[3].col).toBe(0);
    const e = edgesOf(commits);
    expect(e[0]).toEqual([
      { from: 0, to: 0, color: rows[0].color },
      { from: 0, to: 1, color: rows[1].color },
    ]);
    // after m1 both lanes wait for a, which sits at column 0
    expect(e[2].map((x) => [x.from, x.to])).toEqual([[0, 0], [1, 0]]);
  });

  it("octopus merge opens one lane per extra parent", () => {
    const commits = [c("O", "p1", "p2", "p3"), c("p3", "r"), c("p2", "r"), c("p1", "r"), c("r")];
    const rows = computeLanes(commits);
    expect(rows[0].parentCols).toEqual([0, 1, 2]);
    expect(rows[0].width).toBe(3);
    expect(rows.slice(1, 4).map((r) => r.col)).toEqual([2, 1, 0]);
    expect(rows[4].col).toBe(0);
    const colors = new Set(rows[0].outColors);
    expect(colors.size).toBe(3);
    // lanes free up again once r is reached
    expect(rows[3].out).toEqual(["r", "r", "r"]);
    expect(rows[4].out).toEqual([]);
  });

  it("free lanes are reused", () => {
    const commits = [c("t1", "a"), c("a", "r"), c("t2", "r"), c("r")];
    const rows = computeLanes(commits);
    expect(rows[2].col).toBe(1);
  });

  it("paging keeps the same result as one batch", () => {
    // generate a branchy history
    const commits: GraphCommit[] = [];
    let n = 0;
    const id = () => `h${n++}`;
    // build oldest-first, then reverse
    const old: GraphCommit[] = [];
    let main = id();
    old.push(c(main));
    const tips: string[] = [];
    for (let i = 0; i < 120; i++) {
      if (i % 7 === 0) tips.push(main);
      if (i % 5 === 0 && tips.length) {
        const t = tips.shift()!;
        const h = id();
        old.push(c(h, t));
        tips.push(h);
      }
      if (i % 11 === 0 && tips.length > 1) {
        const h = id();
        old.push(c(h, main, tips.pop()!));
        main = h;
      } else {
        const h = id();
        old.push(c(h, main));
        main = h;
      }
    }
    commits.push(...old.reverse());
    const whole = computeLanes(commits);
    for (const page of [1, 7, 50, 64]) {
      const b = new LaneBuilder();
      for (let i = 0; i < commits.length; i += page) b.add(commits.slice(i, i + page));
      expect(b.rows).toEqual(whole);
    }
  });

  it("edges continue straight while the next row is not loaded", () => {
    const rows = computeLanes([c("x", "y")]);
    expect(edgesBetween(rows[0])).toEqual([{ from: 0, to: 0, color: 0 }]);
  });
});
