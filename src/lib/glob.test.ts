import { describe, expect, it } from "vitest";
import { rank } from "./fuzzy";
import { globMatchPath, hasWildcards, matchPathQuery } from "./glob";

const matches = (q: string, p: string) => globMatchPath(q, p) !== null;
const top = (q: string, paths: string[]) => rank(q, paths, (p) => p, matchPathQuery).map((r) => r.item);

describe("glob", () => {
  it("tells patterns from fuzzy queries", () => {
    expect(hasWildcards("communications*.ts")).toBe(true);
    expect(hasWildcards("log?.rs")).toBe(true);
    expect(hasWildcards("src/main")).toBe(false);
  });

  it("matches the whole file name: starts with, ends with", () => {
    const q = "communications*.ts";
    expect(matches(q, "src/api/communications.ts")).toBe(true);
    expect(matches(q, "src/api/communications.service.ts")).toBe(true);
    expect(matches(q, "communicationsHub.ts")).toBe(true);
    expect(matches(q, "src/api/communications.tsx")).toBe(false);
    expect(matches(q, "src/my-communications.ts")).toBe(false);
    // the folder name does not count
    expect(matches(q, "src/communications/index.ts")).toBe(false);
  });

  it("is case-insensitive and reports the literal characters", () => {
    const m = globMatchPath("Communications*.TS", "src/CommunicationsHub.ts")!;
    expect(m).not.toBeNull();
    const name = "src/".length;
    // "communications" and ".ts"; "Hub" is the wildcard
    expect(m.positions).toEqual([...Array.from({ length: 14 }, (_, i) => name + i), 21, 22, 23]);
  });

  it("? is exactly one character", () => {
    expect(matches("log?.rs", "src/log1.rs")).toBe(true);
    expect(matches("log?.rs", "src/log.rs")).toBe(false);
    expect(matches("log?.rs", "src/log12.rs")).toBe(false);
  });

  it("matches every file with an extension", () => {
    expect(matches("*.rs", "src/git/log.rs")).toBe(true);
    expect(matches("*.rs", "src/rs/x.ts")).toBe(false);
    expect(matches("*", "README.md")).toBe(true);
  });

  it("with a folder, matches the end of the path from a folder boundary", () => {
    expect(matches("git/*.rs", "src/git/log.rs")).toBe(true);
    expect(matches("git/*.rs", "git/log.rs")).toBe(true);
    // * stays inside one folder
    expect(matches("git/*.rs", "src/git/sub/log.rs")).toBe(false);
    // not halfway through a folder name
    expect(matches("git/*.rs", "src/legit/log.rs")).toBe(false);
    expect(matches("s*/git/*.rs", "src/git/log.rs")).toBe(true);
  });

  it("a leading / anchors to the root", () => {
    expect(matches("/src/*.ts", "src/main.ts")).toBe(true);
    expect(matches("/src/*.ts", "lib/src/main.ts")).toBe(false);
    expect(matches("src/*.ts", "lib/src/main.ts")).toBe(true);
  });

  it("** crosses folders, and **/ also matches none", () => {
    expect(matches("src/**/*.ts", "src/a.ts")).toBe(true);
    expect(matches("src/**/*.ts", "src/x/y/a.ts")).toBe(true);
    expect(matches("src/**/*.ts", "src/x/y/a.rs")).toBe(false);
    expect(matches("src/**.rs", "src/a/b.rs")).toBe(true);
  });

  it("accepts Windows separators", () => {
    expect(matches("git\\*.rs", "src/git/log.rs")).toBe(true);
  });

  it("does not blow up on many wildcards", () => {
    const long = "a".repeat(200) + ".ts";
    const t = Date.now();
    expect(matches("*a*a*a*a*a*a*a*b", long)).toBe(false);
    expect(Date.now() - t).toBeLessThan(500);
  });

  it("ranks the names closest to the pattern first", () => {
    const paths = [
      "src/api/communications.service.ts",
      "src/old/communications.ts",
      "lib/communications.helpers.spec.ts",
      "src/communications.tsx",
      "src/api/communications.ts",
    ];
    expect(top("communications*.ts", paths)).toEqual([
      "src/api/communications.ts",
      "src/old/communications.ts",
      "src/api/communications.service.ts",
      "lib/communications.helpers.spec.ts",
    ]);
  });

  it("without wildcards it is still the fuzzy search", () => {
    expect(matchPathQuery("cmts", "src/communications.ts")).not.toBeNull();
    expect(matchPathQuery("cm*ts", "src/communications.ts")).toBeNull();
  });
});
