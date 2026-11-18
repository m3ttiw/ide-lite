// Multi-repository mode: in a folder workspace, git features follow the
// repository (or worktree) the user activated inside it.

import { batch, createSignal } from "solid-js";
import { api, type RepoEntry } from "../api";
import { samePath } from "../lib/gitroot";
import { normPath } from "../lib/path";
import { resetChanges, resetLog } from "./git";
import { resetPr } from "./pr";
import { resetReview } from "./review";
import { repoScan } from "./projects";
import { errorText, flash } from "./ui";
import { activeRepo, generation, gitGeneration, isFolderWs, nextGitGeneration, refreshStatus, root, setActiveRepo, setRepo, setStatus, wsInfo } from "./workspace";
import { loadWorktrees, resetWorktrees } from "./worktrees";

/** Repositories found in the current folder workspace (null while looking, or not a folder workspace). */
export function folderRepos(): RepoEntry[] | null {
  if (!isFolderWs()) return null;
  const s = repoScan();
  return s && samePath(s.container, root()) ? s.list : null;
}

/** The repository column is shown: a folder workspace with repositories in it. */
export const showRepoColumn = () => !!folderRepos()?.length || (isFolderWs() && !!activeRepo());

/**
 * Makes `path` the git root of the folder workspace (null: none). The previous
 * repository's in-flight results are dropped by the git generation.
 */
export async function activateRepo(path: string | null, quiet = false): Promise<boolean> {
  if (!isFolderWs()) return false;
  const p = path ? normPath(path) : null;
  if (p && samePath(p, activeRepo())) return true;
  const g = nextGitGeneration();
  batch(() => {
    setActiveRepo(p);
    resetLog();
    resetChanges();
    resetReview();
    resetPr();
    resetWorktrees();
    setStatus([]);
    setRepo(wsInfo());
  });
  if (!p) return true;
  try {
    const info = await api.repoInfo(p);
    if (g !== gitGeneration()) return false;
    if (!info.isRepo) {
      batch(() => setActiveRepo(null));
      if (!quiet) flash(`${p} non è un repository git`, true);
      return false;
    }
    batch(() => {
      // a path inside a repository resolves to its worktree root
      if (!samePath(info.root, p)) setActiveRepo(normPath(info.root));
      setRepo(info);
    });
    void refreshStatus();
    void loadWorktrees();
    return true;
  } catch (e) {
    if (g !== gitGeneration()) return false;
    setActiveRepo(null);
    if (!quiet) flash(`Impossibile aprire il repository ${p}: ${errorText(e)}`, true);
    return false;
  }
}

// ------------------------------------------------------------- dirty counts of the repository column

type Dirty = number | "loading" | "error";
const dirty = new Map<string, Dirty>();
const pending = new Set<string>();
const stale = new Set<string>();
const [dirtyVersion, setDirtyVersion] = createSignal(0);
const bump = () => setDirtyVersion((v) => v + 1);
let dirtyGen = -1;

function syncGen(): void {
  if (dirtyGen === generation()) return;
  dirtyGen = generation();
  dirty.clear();
  pending.clear();
  stale.clear();
}

export function repoDirty(path: string): Dirty | undefined {
  dirtyVersion();
  syncGen();
  return dirty.get(path);
}

/** Asks one repository's change count; called for rows on screen only. */
export function ensureRepoDirty(path: string): void {
  syncGen();
  if (pending.has(path) || (dirty.has(path) && !stale.has(path))) return;
  const g = generation();
  pending.add(path);
  stale.delete(path);
  if (!dirty.has(path)) dirty.set(path, "loading");
  bump();
  api
    .worktreeStatus(path, null)
    .then((s) => g === generation() && dirty.set(path, s.dirty))
    .catch(() => g === generation() && dirty.set(path, "error"))
    .finally(() => {
      if (g === generation()) pending.delete(path);
      bump();
    });
}

/** Window focus / refresh: counts are asked again for the rows on screen. */
export function invalidateRepoDirty(): void {
  for (const p of dirty.keys()) stale.add(p);
  bump();
}

/** Opens a worktree: the active git root in a folder workspace, the workspace otherwise. */
export async function openWorktree(path: string, switchRoot: (p: string) => Promise<boolean>): Promise<boolean> {
  if (isFolderWs()) {
    const ok = await activateRepo(path);
    if (ok) flash(`Repository attivo: ${activeRepo()}`);
    return ok;
  }
  return switchRoot(path);
}
