// Pure navigation logic of the keyboard folder browser (C-x d).

import type { FolderEntry, FolderListing } from "../api/types";
import { fuzzyMatchPath, rank } from "./fuzzy";

export type FolderRow = { kind: "self"; path: string } | { kind: "dir"; entry: FolderEntry };

export interface FolderResult {
  item: FolderRow;
  positions: number[];
}

export type FolderAction = { type: "open"; path: string } | { type: "enter"; path: string; highlight?: string } | null;

/** Absolute folder above `p` ("C:/a/b" -> "C:/a", "C:/a" -> "C:/", "C:/" -> "" = roots, "/" -> ""). */
export function parentPath(p: string): string {
  const s = p.replace(/\\/g, "/");
  if (!s || /^[A-Za-z]:\/*$/.test(s) || /^\/+$/.test(s)) return "";
  const t = s.replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  if (i < 0) return "";
  if (i === 0) return "/";
  const head = t.slice(0, i);
  return /^[A-Za-z]:$/.test(head) ? head + "/" : head;
}

/** "./" first, then the sub-folders that match the filter (same matcher as the other pickers). */
export function folderRows(listing: FolderListing, query: string): FolderResult[] {
  const self: FolderResult = { item: { kind: "self", path: listing.path }, positions: [] };
  const dirs = rank(query, listing.dirs, (d) => d.name, fuzzyMatchPath).map(
    (r): FolderResult => ({ item: { kind: "dir", entry: r.item }, positions: r.match.positions }),
  );
  // the roots listing cannot be opened as a workspace: no "./" there
  return listing.path ? [self, ...dirs] : dirs;
}

/** Row selected after a listing arrives or the filter changes. */
export function defaultFolderIndex(rows: FolderResult[], highlight?: string | null): number {
  if (highlight) {
    const h = highlight.toLowerCase();
    const i = rows.findIndex((r) => r.item.kind === "dir" && r.item.entry.path.toLowerCase() === h);
    if (i >= 0) return i;
  }
  // the first sub-folder, so RET descends; "./" when there is none (or the filter matches nothing)
  const firstDir = rows.findIndex((r) => r.item.kind === "dir");
  return firstDir >= 0 ? firstDir : 0;
}

/**
 * RET ("accept"): "./" and repositories open as workspace, plain folders are entered.
 * TAB / right ("enter"): always enters. C-RET ("open"): always opens.
 */
export function folderAction(row: FolderRow | undefined, how: "accept" | "enter" | "open"): FolderAction {
  if (!row) return null;
  if (row.kind === "self") return how === "enter" || !row.path ? null : { type: "open", path: row.path };
  const e = row.entry;
  if (how === "enter") return { type: "enter", path: e.path };
  if (how === "open" || e.isRepo) return { type: "open", path: e.path };
  return { type: "enter", path: e.path };
}

/** Going up: where to go and which entry to highlight there. null at the roots listing. */
export function upAction(listing: FolderListing): FolderAction {
  if (listing.parent === null) return null;
  return { type: "enter", path: listing.parent, highlight: listing.path };
}
