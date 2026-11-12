import { describe, expect, it } from "vitest";
import { fuzzyMatchPath, fuzzyMatchText, rank } from "./fuzzy";

const paths = [
  "src/blog_old/xyz.ts",
  "lib/catalog.rs",
  "src/git/log.rs",
  "src/ui/git.tsx",
  "src/git/diff.rs",
  "docs/legacy/longer/ok/git/x.md",
  "README.md",
  "src/main.rs",
  "src/memory/rs.ts",
];

const top = (q: string) => rank(q, paths, (p) => p).map((r) => r.item);

describe("fuzzy", () => {
  it("requires a subsequence", () => {
    expect(fuzzyMatchPath("xyz", "src/main.rs")).toBeNull();
    expect(fuzzyMatchPath("smr", "src/main.rs")).not.toBeNull();
  });

  it("is case-insensitive and reports positions", () => {
    const m = fuzzyMatchPath("RM", "README.md")!;
    expect(m).not.toBeNull();
    expect(m.positions).toEqual([0, 4]);
  });

  it("ranks a file-name prefix first", () => {
    expect(top("log")[0]).toBe("src/git/log.rs");
  });

  it("prefers matches in the file name over matches in directories", () => {
    const r = top("git");
    expect(r[0]).toBe("src/ui/git.tsx");
    expect(r.indexOf("src/ui/git.tsx")).toBeLessThan(r.indexOf("src/git/log.rs"));
  });

  it("matches across directories when the file name alone does not", () => {
    const r = top("gitdiff");
    expect(r[0]).toBe("src/git/diff.rs");
  });

  it("rewards word starts", () => {
    const r = top("mrs");
    expect(r[0]).toBe("src/main.rs");
  });

  it("supports a slash in the query", () => {
    expect(top("ui/g")[0]).toBe("src/ui/git.tsx");
  });

  it("empty query keeps the original order", () => {
    expect(top("")).toEqual(paths);
  });

  it("matches command titles", () => {
    const titles = ["Apri file", "Apri cartella", "Cronologia git", "Chiudi buffer"];
    const r = rank("cart", titles, (t) => t, fuzzyMatchText).map((x) => x.item);
    expect(r[0]).toBe("Apri cartella");
    expect(rank("cb", titles, (t) => t, fuzzyMatchText)[0].item).toBe("Chiudi buffer");
  });
});
