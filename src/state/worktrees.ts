import { createSignal } from "solid-js";
import { api, type Worktree, type WorktreeStatus } from "../api";
import { errorText, flash } from "./ui";
import { generation, root } from "./workspace";

export const [worktrees, setWorktrees] = createSignal<Worktree[] | null>(null);
const [loadingList, setLoadingList] = createSignal(false);
export { loadingList };

type St = WorktreeStatus | "loading" | "error";
const statuses = new Map<string, St>();
const [version, setVersion] = createSignal(0);
const bump = () => setVersion((v) => v + 1);

export const mainWorktree = () => worktrees()?.find((w) => w.isMain) ?? null;
/** Branch (or hash) of the main worktree: the base for ahead/behind numbers. */
export const baseRef = () => {
  const m = mainWorktree();
  return m ? (m.branch ?? m.head) : null;
};
export const currentWorktree = () => worktrees()?.find((w) => w.path === root()) ?? null;

let inflight: Promise<void> | null = null;

export function loadWorktrees(): Promise<void> {
  if (inflight) return inflight;
  const g = generation();
  const r = root();
  setLoadingList(true);
  inflight = api
    .listWorktrees(r)
    .then((list) => {
      if (g === generation()) setWorktrees(list);
    })
    .catch((e) => {
      if (g === generation()) {
        setWorktrees([]);
        flash(`Worktree non disponibili: ${errorText(e)}`, true);
      }
    })
    .finally(() => {
      inflight = null;
      setLoadingList(false);
    });
  return inflight;
}

/** Numbers known to be out of date: kept on screen until the new ones arrive. */
const stale = new Set<string>();
const pending = new Set<string>();

export function wtStatus(path: string): St | undefined {
  version();
  return statuses.get(path);
}

/** True when a row showing this worktree should ask for its numbers. */
export function needsWtStatus(path: string): boolean {
  version();
  return !pending.has(path) && (!statuses.has(path) || stale.has(path));
}

/** Asks for one worktree's numbers; called for rows on screen only. */
export function ensureWtStatus(path: string): void {
  if (pending.has(path) || (statuses.has(path) && !stale.has(path))) return;
  const base = baseRef();
  const g = generation();
  pending.add(path);
  stale.delete(path);
  if (!statuses.has(path)) statuses.set(path, "loading");
  bump();
  api
    .worktreeStatus(path, base)
    .then((s) => g === generation() && statuses.set(path, s))
    .catch(() => g === generation() && statuses.set(path, "error"))
    .finally(() => {
      pending.delete(path);
      bump();
    });
}

/** After a window focus or a refresh: numbers are re-asked lazily, without flicker. */
export function invalidateWtStatuses(): void {
  for (const p of statuses.keys()) stale.add(p);
  bump();
}

export function clearWtStatuses(): void {
  statuses.clear();
  stale.clear();
  pending.clear();
  bump();
}

export function resetWorktrees(): void {
  setWorktrees(null);
  clearWtStatuses();
}

export function describeStatus(w: Worktree, s: St | undefined, isCurrent: boolean): string {
  const parts: string[] = [];
  if (w.isMain) parts.push("principale");
  if (s === "loading" || s === undefined) parts.push("…");
  else if (s === "error") parts.push("stato non disponibile");
  else {
    if (!w.isMain) {
      if (s.ahead) parts.push(`↑${s.ahead}`);
      if (s.behind) parts.push(`↓${s.behind}`);
      if (!s.ahead && !s.behind) parts.push("allineato");
    }
    if (s.dirty) parts.push(`${s.dirty} mod.`);
  }
  if (w.locked) parts.push("bloccato");
  if (w.prunable) parts.push("rimovibile");
  if (isCurrent) parts.push("attuale");
  return parts.join(" · ");
}
