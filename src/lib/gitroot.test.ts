import { describe, expect, it } from "vitest";
import type { RepoEntry, StatusEntry } from "../api/types";
import { relativeTo, repoRows, rootFor, samePath, statusToWorkspace, toRepoPath, toWorkspacePath, worktreeLabelPath } from "./gitroot";

describe("path mapping", () => {
  it("relativeTo handles equality, nesting, case and outside paths", () => {
    expect(relativeTo("C:/p", "C:/p")).toBe("");
    expect(relativeTo("C:/p", "C:/p/clienti/rossi")).toBe("clienti/rossi");
    expect(relativeTo("c:\\P\\", "C:/p/web")).toBe("web");
    expect(relativeTo("C:/p", "C:/pq/web")).toBeNull();
    expect(relativeTo("C:/", "C:/Users")).toBe("Users");
  });
  it("maps between repository and workspace paths", () => {
    expect(toWorkspacePath("clienti/rossi", "src/a.ts")).toBe("clienti/rossi/src/a.ts");
    expect(toWorkspacePath("", "src/a.ts")).toBe("src/a.ts");
    expect(toWorkspacePath(null, "src/a.ts")).toBeNull();
    expect(toRepoPath("clienti/rossi", "clienti/rossi/src/a.ts")).toBe("src/a.ts");
    expect(toRepoPath("clienti/rossi", "clienti/rossi-old/a.ts")).toBeNull();
    expect(toRepoPath("", "a.ts")).toBe("a.ts");
  });
  it("keys status by workspace path", () => {
    const st: StatusEntry[] = [{ path: "src/a.ts", origPath: null, index: null, worktree: "M" }];
    expect([...statusToWorkspace(st, "web", (s) => s.worktree ?? "")]).toEqual([["web/src/a.ts", "M"]]);
    expect(statusToWorkspace(st, null, () => "M").size).toBe(0);
  });
  it("labels worktrees relative to the main worktree's parent", () => {
    expect(worktreeLabelPath("C:/w/ide-lite.fix", "C:/w/ide-lite")).toBe("ide-lite.fix");
    expect(worktreeLabelPath("D:/x/y", "C:/w/ide-lite")).toBe("D:/x/y");
    expect(samePath("C:/A/b", "c:/a/B/")).toBe(true);
  });
});

describe("rootFor", () => {
  const repoWs = { root: "C:/w/ide-lite", isRepo: true };
  const folderWs = { root: "C:/p", isRepo: false };
  it("uses the workspace for everything in a repository workspace", () => {
    for (const f of ["tree", "history", "changes", "worktrees", "quickOpen", "statusBar", "badges"] as const) expect(rootFor(f, repoWs, null)).toBe("C:/w/ide-lite");
  });
  it("uses the active repository for git features in a folder workspace", () => {
    expect(rootFor("tree", folderWs, "C:/p/web")).toBe("C:/p");
    expect(rootFor("editor", folderWs, "C:/p/web")).toBe("C:/p");
    expect(rootFor("history", folderWs, "C:/p/web")).toBe("C:/p/web");
    expect(rootFor("worktrees", folderWs, null)).toBeNull();
    expect(rootFor("quickOpen", folderWs, null)).toBe("C:/p");
    expect(rootFor("quickOpen", folderWs, "C:/p/web")).toBe("C:/p/web");
  });
});

describe("repoRows", () => {
  const repos: RepoEntry[] = [
    { path: "C:/p/api", relPath: "api", branch: "develop", linked: false },
    { path: "C:/p/web", relPath: "web", branch: "main", linked: false },
  ];
  it("marks the active repository", () => {
    expect(repoRows("C:/p", repos, "c:/p/web").map((r) => r.active)).toEqual([false, true]);
    expect(repoRows("C:/p", repos, null).some((r) => r.active)).toBe(false);
  });
  it("keeps an active worktree that is not in the list visible", () => {
    const rows = repoRows("C:/p", repos, "D:/elsewhere/web.fix");
    expect(rows[0]).toMatchObject({ path: "D:/elsewhere/web.fix", relPath: "D:/elsewhere/web.fix", active: true, linked: true });
    expect(rows.length).toBe(3);
  });
});
