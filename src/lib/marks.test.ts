import { describe, expect, it } from "vitest";
import { NO_MARKS, extendMarks, keepListed, toggleMark, type Marks } from "./marks";

const rows = ["a", "b", "c", "d", "e"];
const all = (_i: number) => true;
const sel = (m: Marks) => [...m.keys].sort();

/** Ctrl+arrow from the cursor, clamped like the picker. */
function ctrl(m: Marks, cur: number, d: number, markable = all): [Marks, number] {
  const to = Math.max(0, Math.min(rows.length - 1, cur + d));
  return [extendMarks(m, rows, markable, cur, to), to];
}

describe("marks", () => {
  it("Ctrl+down selects the row it leaves and the row it reaches", () => {
    let [m, cur] = ctrl(NO_MARKS, 1, 1);
    expect(sel(m)).toEqual(["b", "c"]);
    [m, cur] = ctrl(m, cur, 1);
    expect(sel(m)).toEqual(["b", "c", "d"]);
    expect(cur).toBe(3);
  });

  it("going back over the run shrinks it, past the anchor it grows the other way", () => {
    let [m, cur] = ctrl(NO_MARKS, 2, 1); // c d
    [m, cur] = ctrl(m, cur, -1); // c
    expect(sel(m)).toEqual(["c"]);
    [m, cur] = ctrl(m, cur, -1); // b c
    expect(sel(m)).toEqual(["b", "c"]);
    expect(cur).toBe(1);
  });

  it("at the edge of the list it still selects the current row", () => {
    const [m, cur] = ctrl(NO_MARKS, 4, 1);
    expect(cur).toBe(4);
    expect(sel(m)).toEqual(["e"]);
  });

  it("a plain move starts a new run that keeps the earlier selection", () => {
    let [m] = ctrl(NO_MARKS, 0, 1); // a b, cursor 1
    // plain arrows move the cursor to 3, then Ctrl+down again
    [m] = ctrl(m, 3, 1);
    expect(sel(m)).toEqual(["a", "b", "d", "e"]);
    // shrinking the new run never drops the old selection
    [m] = ctrl(m, 4, -1);
    expect(sel(m)).toEqual(["a", "b", "d"]);
  });

  it("skips rows that cannot be selected", () => {
    const notB = (i: number) => rows[i] !== "b";
    const [m] = ctrl(NO_MARKS, 0, 1, notB);
    expect(sel(m)).toEqual(["a"]);
  });

  it("toggle adds or drops one row and ends the run", () => {
    let [m] = ctrl(NO_MARKS, 0, 1); // a b
    m = toggleMark(m, "b");
    expect(sel(m)).toEqual(["a"]);
    expect(m.run).toBeNull();
    m = toggleMark(m, "e");
    expect(sel(m)).toEqual(["a", "e"]);
  });

  it("drops selected rows that are no longer listed", () => {
    let [m] = ctrl(NO_MARKS, 0, 2); // a b c
    m = keepListed(m, ["a", "c", "x"]);
    expect(sel(m)).toEqual(["a", "c"]);
    expect(keepListed(m, ["a", "c"])).toBe(m);
  });
});
