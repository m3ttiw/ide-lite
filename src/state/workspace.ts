import { createMemo, createRoot, createSignal } from "solid-js";
import { api, type RepoInfo, type StatusEntry } from "../api";
import { relativeTo, statusToWorkspace } from "../lib/gitroot";
import { ancestors } from "../lib/path";
import { errorText, flash } from "./ui";

/** Workspace root: file tree, editor paths, quick open fallback. */
export const [root, setRoot] = createSignal("");
/** Info of the workspace folder itself (isRepo false for a plain folder). */
export const [wsInfo, setWsInfo] = createSignal<RepoInfo | null>(null);
/** Repository chosen inside a folder workspace (null in a repository workspace or when none is chosen). */
export const [activeRepo, setActiveRepo] = createSignal<string | null>(null);
/** Info of the git root: the workspace's in a repository workspace, the active repository's otherwise. */
export const [repo, setRepo] = createSignal<RepoInfo | null>(null);
/** Git status of the git root, paths relative to the git root. */
export const [status, setStatus] = createSignal<StatusEntry[]>([]);

/** The workspace folder is not a repository: git features follow the active repository. */
export const isFolderWs = () => !!root() && wsInfo() !== null && !wsInfo()!.isRepo;

/** Root of every git feature ("" when none: a folder workspace with no active repository). */
export function gitRoot(): string {
  if (!isFolderWs()) return root();
  return activeRepo() ?? "";
}

/** Generation counter: bumped when the workspace root changes, to drop stale responses. */
let gen = 0;
export const generation = () => gen;
/** Git generation: bumped with the workspace and whenever the git root changes. */
let gitGen = 0;
export const gitGeneration = () => gitGen;
export const nextGitGeneration = () => ++gitGen;
export const nextGeneration = () => {
  gitGen++;
  return ++gen;
};

/** Letter shown next to a path: the unstaged change wins over the staged one. */
export function statusLetter(s: StatusEntry): string {
  return s.worktree ?? s.index ?? "";
}

const derived = createRoot(() => {
  /** Workspace-relative path of the git root ("" when equal, null when outside the workspace or none). */
  const prefix = createMemo((): string | null => {
    const g = gitRoot();
    if (!g) return null;
    return relativeTo(root(), g);
  });
  const byPath = createMemo(() => statusToWorkspace(status(), prefix(), statusLetter));
  const dirtyDirs = createMemo(() => {
    const set = new Set<string>();
    for (const p of byPath().keys()) for (const a of ancestors(p)) set.add(a);
    return set;
  });
  return { prefix, byPath, dirtyDirs };
});

export const repoPrefix = derived.prefix;
/** Status letters keyed by workspace-relative path (tree badges). */
export const statusByPath = derived.byPath;
export const dirtyDirs = derived.dirtyDirs;

export async function refreshStatus(): Promise<void> {
  const g = gitGen;
  const r = gitRoot();
  if (!r) return;
  try {
    const s = await api.gitStatus(r);
    if (g === gitGen) setStatus(s);
  } catch (e) {
    if (g === gitGen) flash(`Stato git non disponibile: ${errorText(e)}`, true);
  }
}

export async function refreshRepo(): Promise<void> {
  const g = gitGen;
  const r = gitRoot();
  if (!r) return;
  try {
    const info = await api.repoInfo(r);
    if (g !== gitGen) return;
    setRepo(info);
    if (r === root()) setWsInfo(info);
  } catch {
    /* keep the last known info */
  }
}

export function projectName(): string {
  const r = root();
  return r.slice(r.lastIndexOf("/") + 1) || r;
}
