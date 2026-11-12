import { batch, createEffect, createRoot, on } from "solid-js";
import { api } from "../api";
import { normPath } from "../lib/path";
import { bufs, dirtyBuffers, prefetchEditor, resetBuffers, restoreBuffers } from "./buffers";
import { resetChanges, resetLog } from "./git";
import { expandedList, loadDir, resetTree, restoreExpanded } from "./tree";
import { errorText, flash, setUi, ui, type BottomTab } from "./ui";
import { activeRepo, generation, nextGeneration, refreshRepo, refreshStatus, root, setActiveRepo, setRepo, setRoot, setStatus, setWsInfo } from "./workspace";
import { activateRepo, invalidateRepoDirty } from "./activeRepo";
import { afterOpen } from "./projects";
import { startAutoUpdates } from "./updates";
import { loadWorktrees, resetWorktrees } from "./worktrees";

interface Session {
  buffers: string[];
  active: string | null;
  expanded: string[];
  sidebarVisible: boolean;
  sidebarWidth: number;
  bottomVisible: boolean;
  bottomHeight: number;
  bottomTab: BottomTab;
  /** Folder workspace: the active repository. */
  activeRepo?: string | null;
}

const key = (r: string) => `ide-lite:session:${r}`;

function readSession(r: string): Partial<Session> {
  try {
    return JSON.parse(localStorage.getItem(key(r)) ?? "{}");
  } catch {
    return {};
  }
}

let restoring = false;

export function saveSession(): void {
  const r = root();
  if (!r || restoring) return;
  const s: Session = {
    buffers: bufs.list.map((b) => b.path),
    active: bufs.active,
    expanded: expandedList(),
    sidebarVisible: ui.sidebarVisible,
    sidebarWidth: ui.sidebarWidth,
    bottomVisible: ui.bottomVisible,
    bottomHeight: ui.bottomHeight,
    bottomTab: ui.bottomTab,
    activeRepo: activeRepo(),
  };
  try {
    localStorage.setItem(key(r), JSON.stringify(s));
  } catch {
    /* storage full or unavailable */
  }
}

// Save (debounced) whenever something that belongs to the session changes.
createRoot(() => {
  let t: number | undefined;
  createEffect(
    on(
      () => [bufs.list.map((b) => b.path).join("\n"), bufs.active, expandedList().join("\n"), ui.sidebarVisible, ui.sidebarWidth, ui.bottomVisible, ui.bottomHeight, ui.bottomTab, activeRepo()],
      () => {
        clearTimeout(t);
        t = window.setTimeout(saveSession, 300);
      },
      { defer: true },
    ),
  );
});

window.addEventListener("beforeunload", saveSession);

/** Opens `folder` as the workspace: resolves the worktree root and restores its session. */
export async function openRoot(folder: string): Promise<void> {
  const info = await api.repoInfo(folder);
  const r = normPath(info.root);
  saveSession();
  restoring = true;
  nextGeneration();
  batch(() => {
    resetBuffers();
    resetTree();
    resetLog();
    resetChanges();
    resetWorktrees();
    setStatus([]);
    setActiveRepo(null);
    setWsInfo(info);
    setRepo(info);
    setRoot(r);
  });
  const s = readSession(r);
  batch(() => {
    if (typeof s.sidebarVisible === "boolean") setUi("sidebarVisible", s.sidebarVisible);
    if (typeof s.sidebarWidth === "number") setUi("sidebarWidth", s.sidebarWidth);
    if (typeof s.bottomVisible === "boolean") setUi("bottomVisible", s.bottomVisible);
    if (typeof s.bottomHeight === "number") setUi("bottomHeight", s.bottomHeight);
    if (s.bottomTab === "history" || s.bottomTab === "changes") setUi("bottomTab", s.bottomTab);
  });
  // Folder workspace: the repository that was active last time (its git data loads on its own).
  if (!info.isRepo && typeof s.activeRepo === "string") void activateRepo(s.activeRepo, true);
  // Startup work: the root listing and git status, in parallel.
  await Promise.all([loadDir(""), refreshStatus()]);
  if (Array.isArray(s.expanded) && s.expanded.length) restoreExpanded(s.expanded);
  if (Array.isArray(s.buffers) && s.buffers.length) restoreBuffers(s.buffers, s.active ?? null);
  restoring = false;
  saveSession();
  const g = generation();
  void afterOpen(r, info, () => g === generation());
}

/** Everything that is not needed for the first paint. */
export function afterFirstPaint(): void {
  const idle = (fn: () => void) => ("requestIdleCallback" in window ? window.requestIdleCallback(() => fn(), { timeout: 1500 }) : setTimeout(fn, 200));
  idle(() => {
    prefetchEditor();
    if (root()) void loadWorktrees();
  });
  // only a timer: the first update call happens 15 s after startup
  startAutoUpdates();
}

export async function switchRoot(folder: string, force = false): Promise<boolean> {
  const dirty = dirtyBuffers();
  if (dirty.length && !force) {
    flash(`Salva o chiudi i buffer modificati prima di cambiare cartella (${dirty.map((b) => b.name).join(", ")})`, true);
    return false;
  }
  try {
    await openRoot(folder);
    void loadWorktrees();
    flash(`Aperto ${root()}`);
    return true;
  } catch (e) {
    flash(`Impossibile aprire ${folder}: ${errorText(e)}`, true);
    return false;
  }
}

/** Window regained focus: things may have changed on disk. */
let lastFocusRefresh = 0;
export function onWindowFocus(refreshTree: () => Promise<void>, extra: () => void): void {
  const now = Date.now();
  if (!root() || now - lastFocusRefresh < 1500) return;
  lastFocusRefresh = now;
  void refreshStatus();
  void refreshRepo();
  invalidateRepoDirty();
  void refreshTree();
  extra();
}
