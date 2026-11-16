import { describe, expect, it } from "vitest";
import { openStartup } from "./startup";

/** `open` that fails for the folders in `missing` and records every attempt. */
function opener(missing: string[] = []) {
  const tried: string[] = [];
  const open = async (folder: string) => {
    tried.push(folder);
    if (missing.includes(folder)) throw new Error(`not a directory: ${folder}`);
  };
  return { tried, open };
}

const fallback = async () => "C:/Users/me";

describe("openStartup", () => {
  it("opens the folder given on the command line, ignoring the recents", async () => {
    const o = opener();
    expect(await openStartup({ launch: "C:/asked", recents: ["C:/last"], fallback }, o.open)).toBe("C:/asked");
    expect(o.tried).toEqual(["C:/asked"]);
  });

  it("reopens the last folder used when started without one", async () => {
    const o = opener();
    expect(await openStartup({ launch: null, recents: ["C:/last", "C:/older"], fallback }, o.open)).toBe("C:/last");
    expect(o.tried).toEqual(["C:/last"]);
  });

  it("skips recent folders that no longer open", async () => {
    const o = opener(["C:/last", "C:/older"]);
    expect(await openStartup({ launch: null, recents: ["C:/last", "C:/older", "C:/oldest"], fallback }, o.open)).toBe("C:/oldest");
    expect(o.tried).toEqual(["C:/last", "C:/older", "C:/oldest"]);
  });

  it("falls back to the home folder on a first run or when every recent is gone", async () => {
    const first = opener();
    expect(await openStartup({ launch: null, recents: [], fallback }, first.open)).toBe("C:/Users/me");
    expect(first.tried).toEqual(["C:/Users/me"]);

    const gone = opener(["C:/last"]);
    expect(await openStartup({ launch: null, recents: ["C:/last"], fallback }, gone.open)).toBe("C:/Users/me");
    expect(gone.tried).toEqual(["C:/last", "C:/Users/me"]);
  });

  it("does not hide a failure of the requested folder or of the fallback", async () => {
    await expect(openStartup({ launch: "C:/asked", recents: ["C:/last"], fallback }, opener(["C:/asked"]).open)).rejects.toThrow("C:/asked");
    await expect(openStartup({ launch: null, recents: [], fallback }, opener(["C:/Users/me"]).open)).rejects.toThrow("C:/Users/me");
  });
});
