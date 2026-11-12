import { createMemo, createRoot, createSignal } from "solid-js";
import { api, type RepoInfo, type StatusEntry } from "../api";
import { ancestors } from "../lib/path";
import { errorText, flash } from "./ui";

export const [root, setRoot] = createSignal("");
export const [repo, setRepo] = createSignal<RepoInfo | null>(null);
export const [status, setStatus] = createSignal<StatusEntry[]>([]);

/** Generation counter: bumped when the workspace root changes, to drop stale responses. */
let gen = 0;
export const generation = () => gen;
export const nextGeneration = () => ++gen;

/** Letter shown next to a path: the unstaged change wins over the staged one. */
export function statusLetter(s: StatusEntry): string {
  return s.worktree ?? s.index ?? "";
}

const derived = createRoot(() => {
  const byPath = createMemo(() => {
    const m = new Map<string, string>();
    for (const s of status()) m.set(s.path, statusLetter(s));
    return m;
  });
  const dirtyDirs = createMemo(() => {
    const set = new Set<string>();
    for (const s of status()) for (const a of ancestors(s.path)) set.add(a);
    return set;
  });
  return { byPath, dirtyDirs };
});

export const statusByPath = derived.byPath;
export const dirtyDirs = derived.dirtyDirs;

export async function refreshStatus(): Promise<void> {
  const g = gen;
  const r = root();
  if (!r) return;
  try {
    const s = await api.gitStatus(r);
    if (g === gen) setStatus(s);
  } catch (e) {
    flash(`Stato git non disponibile: ${errorText(e)}`, true);
  }
}

export async function refreshRepo(): Promise<void> {
  const g = gen;
  const r = root();
  if (!r) return;
  try {
    const info = await api.repoInfo(r);
    if (g === gen) setRepo(info);
  } catch {
    /* keep the last known info */
  }
}

export function projectName(): string {
  const r = root();
  return r.slice(r.lastIndexOf("/") + 1) || r;
}
