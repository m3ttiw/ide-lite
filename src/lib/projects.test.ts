import { describe, expect, it } from "vitest";
import type { RepoEntry } from "../api/types";
import { defaultProjectIndex, projectRows, pushRecent } from "./projects";

const C = "C:/p";
const repos: RepoEntry[] = [
  { path: `${C}/api`, relPath: "api", branch: "develop", linked: false },
  { path: `${C}/clienti/rossi`, relPath: "clienti/rossi", branch: "main", linked: false },
  { path: `${C}/web`, relPath: "web", branch: "main", linked: false },
];

const kinds = (rows: ReturnType<typeof projectRows>) => rows.map((r) => (r.item.kind === "head" ? `#${r.item.label}` : r.item.kind === "action" ? "action" : r.item.label));

describe("pushRecent", () => {
  it("moves an existing entry to the front without duplicates", () => {
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(pushRecent(["C:/A"], "c:/a")).toEqual(["c:/a"]);
  });
  it("keeps at most max entries", () => {
    expect(pushRecent(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
  });
});

describe("projectRows", () => {
  it("lists repositories, then recents without duplicates, then the browse action", () => {
    const rows = projectRows({ container: C, repos, recents: [`${C}/web`, "D:/altro"] }, "");
    expect(kinds(rows)).toEqual([`#Repository in ${C}`, "api", "clienti/rossi", "web", "#Recenti", "D:/altro", "action"]);
  });
  it("omits the first section without a container and empty sections when filtering", () => {
    expect(kinds(projectRows({ container: null, repos, recents: ["D:/altro"] }, ""))).toEqual(["#Recenti", "D:/altro", "action"]);
    expect(kinds(projectRows({ container: C, repos, recents: ["D:/altro"] }, "ross"))).toEqual([`#Repository in ${C}`, "clienti/rossi", "action"]);
  });
  it("selects the first project that is not the current one", () => {
    const rows = projectRows({ container: C, repos, recents: [] }, "");
    expect(defaultProjectIndex(rows, "", `${C}/api`)).toBe(2);
    expect(defaultProjectIndex(rows, "api", `${C}/api`)).toBe(1);
    expect(defaultProjectIndex(projectRows({ container: null, repos: null, recents: [] }, ""), "", "")).toBe(0);
  });
});
