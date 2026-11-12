// Pure logic of the project picker (C-x p): sections, filtering, recents.

import type { RepoEntry } from "../api/types";
import { fuzzyMatchPath, normalizeQuery, rank } from "./fuzzy";

export type ProjectItem =
  | { kind: "head"; label: string }
  | { kind: "repo"; path: string; label: string; branch: string | null; linked: boolean }
  | { kind: "recent"; path: string; label: string }
  | { kind: "action" };

export interface ProjectResult {
  item: ProjectItem;
  positions: number[];
}

export const MAX_RECENTS = 12;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Most recent first, no duplicates, at most `max` entries. */
export function pushRecent(list: readonly string[], path: string, max = MAX_RECENTS): string[] {
  return [path, ...list.filter((p) => !same(p, path))].slice(0, max);
}

export interface ProjectSources {
  container: string | null;
  repos: RepoEntry[] | null;
  recents: readonly string[];
}

/**
 * "Repository in <container>" (relPath), "Recenti" (without the repositories
 * already listed above), then the "Sfoglia cartelle…" row. The filter applies
 * to the first two sections; a section without matches loses its header.
 */
export function projectRows(src: ProjectSources, query: string): ProjectResult[] {
  const out: ProjectResult[] = [];
  const repos = src.container ? (src.repos ?? []) : [];
  const repoRows = rank(query, repos, (r) => r.relPath, fuzzyMatchPath);
  if (src.container && repoRows.length) {
    out.push({ item: { kind: "head", label: `Repository in ${src.container}` }, positions: [] });
    for (const r of repoRows)
      out.push({ item: { kind: "repo", path: r.item.path, label: r.item.relPath, branch: r.item.branch, linked: r.item.linked }, positions: r.match.positions });
  }
  const listed = repos.map((r) => r.path);
  const recents = src.recents.filter((p) => !listed.some((l) => same(l, p)));
  const recentRows = rank(query, recents, (p) => p, fuzzyMatchPath);
  if (recentRows.length) {
    out.push({ item: { kind: "head", label: "Recenti" }, positions: [] });
    for (const r of recentRows) out.push({ item: { kind: "recent", path: r.item, label: r.item }, positions: r.match.positions });
  }
  out.push({ item: { kind: "action" }, positions: [] });
  return out;
}

export const isSelectableProject = (i: ProjectItem) => i.kind !== "head";

/** First selectable row; with an empty filter, skips the current workspace when something else exists. */
export function defaultProjectIndex(rows: ProjectResult[], query: string, current: string): number {
  const sel = rows.map((r, i) => ({ r, i })).filter(({ r }) => isSelectableProject(r.item));
  if (!sel.length) return 0;
  if (!normalizeQuery(query)) {
    const other = sel.find(({ r }) => (r.item.kind === "repo" || r.item.kind === "recent") && !same(r.item.path, current));
    if (other) return other.i;
  }
  return sel[0].i;
}
