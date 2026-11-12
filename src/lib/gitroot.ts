// Pure logic of the multi-repository mode: a folder workspace whose git
// features follow an "active repository" chosen inside it.

import type { RepoEntry, StatusEntry } from "../api/types";

const norm = (p: string) => {
  const s = p.replace(/\\/g, "/");
  if (/^[A-Za-z]:\/*$/.test(s)) return s.slice(0, 2) + "/";
  return s.replace(/\/+$/, "");
};
const key = (p: string) => norm(p).toLowerCase();

export const samePath = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && key(a) === key(b);

/** `path` relative to `base` ("" when equal), or null when it is not inside it. Case-insensitive. */
export function relativeTo(base: string, path: string): string | null {
  const b = norm(base);
  const p = norm(path);
  if (key(b) === key(p)) return "";
  const prefix = b.endsWith("/") ? b : b + "/";
  if (!p.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  return p.slice(prefix.length);
}

/** Repository-relative path -> workspace-relative path. null when the repository is outside the workspace. */
export function toWorkspacePath(prefix: string | null, repoPath: string): string | null {
  if (prefix === null) return null;
  return prefix ? `${prefix}/${repoPath}` : repoPath;
}

/** Workspace-relative path -> repository-relative path, or null when the file is not in the repository. */
export function toRepoPath(prefix: string | null, wsPath: string): string | null {
  if (prefix === null) return null;
  if (!prefix) return wsPath;
  return wsPath.startsWith(prefix + "/") ? wsPath.slice(prefix.length + 1) : null;
}

/** Git status keyed by workspace-relative path (for the file tree badges). */
export function statusToWorkspace(status: readonly StatusEntry[], prefix: string | null, letter: (s: StatusEntry) => string): Map<string, string> {
  const m = new Map<string, string>();
  if (prefix === null) return m;
  for (const s of status) m.set(toWorkspacePath(prefix, s.path)!, letter(s));
  return m;
}

export interface WorkspaceKind {
  root: string;
  /** The workspace folder is itself a repository (worktree). */
  isRepo: boolean;
}

export type Feature = "tree" | "editor" | "quickOpen" | "history" | "changes" | "worktrees" | "statusBar" | "badges";

/**
 * The root a feature works on. File tree and editor: always the workspace.
 * Git features: the workspace when it is a repository, else the active
 * repository (null: none chosen yet). Quick open: the active repository's
 * files when there is one, else the workspace walk.
 */
export function rootFor(feature: Feature, ws: WorkspaceKind, active: string | null): string | null {
  if (feature === "tree" || feature === "editor") return ws.root;
  if (ws.isRepo) return ws.root;
  if (feature === "quickOpen") return active ?? ws.root;
  return active;
}

export interface RepoRow {
  path: string;
  relPath: string;
  branch: string | null;
  linked: boolean;
  active: boolean;
}

/**
 * Rows of the repository column: the repositories found, the active one
 * marked. An active worktree that is not in the list (a linked worktree
 * elsewhere) is added on top so that it stays visible.
 */
export function repoRows(root: string, repos: readonly RepoEntry[], active: string | null): RepoRow[] {
  const rows = repos.map((r): RepoRow => ({ path: r.path, relPath: r.relPath, branch: r.branch, linked: r.linked, active: samePath(r.path, active) }));
  if (active && !rows.some((r) => r.active)) {
    rows.unshift({ path: norm(active), relPath: relativeTo(root, active) ?? norm(active), branch: null, linked: true, active: true });
  }
  return rows;
}

/** Name of a worktree relative to the folder that holds the main one ("ide-lite.feat-x"). */
export function worktreeLabelPath(path: string, mainPath: string | null): string {
  if (!mainPath) return path;
  const m = norm(mainPath);
  const i = m.lastIndexOf("/");
  const parent = i <= 0 ? m : m.slice(0, i);
  return relativeTo(parent, path) || path;
}
