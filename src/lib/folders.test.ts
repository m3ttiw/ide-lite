import { describe, expect, it } from "vitest";
import type { FolderListing } from "../api/types";
import { defaultFolderIndex, folderAction, folderRows, parentPath, upAction } from "./folders";

const listing: FolderListing = {
  path: "C:/Users/dev/progetti",
  parent: "C:/Users/dev",
  dirs: [
    { name: "api-server", path: "C:/Users/dev/progetti/api-server", isRepo: true, branch: "develop" },
    { name: "app-web", path: "C:/Users/dev/progetti/app-web", isRepo: true, branch: "main" },
    { name: "appunti", path: "C:/Users/dev/progetti/appunti", isRepo: false, branch: null },
    { name: "clienti", path: "C:/Users/dev/progetti/clienti", isRepo: false, branch: null },
  ],
};

describe("parentPath", () => {
  it("walks up to the drive root, then to the roots listing", () => {
    expect(parentPath("C:/Users/dev")).toBe("C:/Users");
    expect(parentPath("C:/Users")).toBe("C:/");
    expect(parentPath("C:/")).toBe("");
    expect(parentPath("C:\\Users\\dev\\")).toBe("C:/Users");
  });
  it("handles unix paths", () => {
    expect(parentPath("/home/me")).toBe("/home");
    expect(parentPath("/home")).toBe("/");
    expect(parentPath("/")).toBe("");
  });
});

describe("folderRows", () => {
  it("puts ./ first and keeps every folder without a filter", () => {
    const rows = folderRows(listing, "");
    expect(rows[0].item).toEqual({ kind: "self", path: listing.path });
    expect(rows.length).toBe(5);
  });
  it("filters the entries but keeps ./", () => {
    const rows = folderRows(listing, "cli");
    expect(rows.map((r) => (r.item.kind === "dir" ? r.item.entry.name : "./"))).toEqual(["./", "clienti"]);
  });
  it("has no ./ in the roots listing", () => {
    const roots: FolderListing = { path: "", parent: null, dirs: [{ name: "C:", path: "C:/", isRepo: false, branch: null }] };
    expect(folderRows(roots, "").map((r) => r.item.kind)).toEqual(["dir"]);
  });
});

describe("selection and actions", () => {
  it("highlights the folder we came from, else the first sub-folder", () => {
    const rows = folderRows(listing, "");
    expect(defaultFolderIndex(rows, "C:/Users/dev/progetti/appunti")).toBe(3);
    expect(defaultFolderIndex(rows, null)).toBe(1);
    expect(defaultFolderIndex(folderRows(listing, "zzz"), null)).toBe(0);
  });
  it("RET opens ./ and repositories, enters plain folders", () => {
    const rows = folderRows(listing, "");
    expect(folderAction(rows[0].item, "accept")).toEqual({ type: "open", path: listing.path });
    expect(folderAction(rows[1].item, "accept")).toEqual({ type: "open", path: "C:/Users/dev/progetti/api-server" });
    expect(folderAction(rows[3].item, "accept")).toEqual({ type: "enter", path: "C:/Users/dev/progetti/appunti" });
  });
  it("TAB always enters, C-RET always opens", () => {
    const rows = folderRows(listing, "");
    expect(folderAction(rows[1].item, "enter")).toEqual({ type: "enter", path: "C:/Users/dev/progetti/api-server" });
    expect(folderAction(rows[0].item, "enter")).toBeNull();
    expect(folderAction(rows[3].item, "open")).toEqual({ type: "open", path: "C:/Users/dev/progetti/appunti" });
  });
  it("goes up highlighting the current folder, and stops at the roots listing", () => {
    expect(upAction(listing)).toEqual({ type: "enter", path: "C:/Users/dev", highlight: "C:/Users/dev/progetti" });
    expect(upAction({ path: "C:/", parent: "", dirs: [] })).toEqual({ type: "enter", path: "", highlight: "C:/" });
    expect(upAction({ path: "", parent: null, dirs: [] })).toBeNull();
  });
});
