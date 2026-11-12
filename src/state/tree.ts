import { createMemo, createRoot, createSignal } from "solid-js";
import { api, type DirEntry } from "../api";
import { dirname } from "../lib/path";
import { errorText, flash } from "./ui";
import { generation, root } from "./workspace";

// Children are kept in plain maps; one version signal drives the views.
const children = new Map<string, DirEntry[]>();
const expanded = new Set<string>();
const loading = new Set<string>();
const [version, setVersion] = createSignal(0);
const bump = () => setVersion((v) => v + 1);

export const [selected, setSelected] = createSignal<string | null>(null);

export interface TreeRow {
  entry: DirEntry;
  depth: number;
}

export const treeRows = createRoot(() =>
  createMemo(() => {
    version();
    const out: TreeRow[] = [];
    const walk = (dir: string, depth: number) => {
      const list = children.get(dir);
      if (!list) return;
      for (const entry of list) {
        out.push({ entry, depth });
        if (entry.kind === "dir" && expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    walk("", 0);
    return out;
  }),
);

export const isExpanded = (path: string) => (version(), expanded.has(path));
export const isLoading = (path: string) => (version(), loading.has(path));
export const treeLoaded = () => (version(), children.has(""));

export async function loadDir(dir: string, quiet = false): Promise<void> {
  const g = generation();
  const r = root();
  if (!r) return;
  loading.add(dir);
  bump();
  try {
    const list = await api.listDir(r, dir);
    if (g !== generation()) return;
    children.set(dir, list);
  } catch (e) {
    if (g === generation()) {
      if (dir !== "") expanded.delete(dir);
      if (!quiet) flash(`Impossibile leggere ${dir || "la cartella"}: ${errorText(e)}`, true);
    }
  } finally {
    if (g === generation()) {
      loading.delete(dir);
      bump();
    }
  }
}

export async function expand(dir: string): Promise<void> {
  if (expanded.has(dir)) return;
  expanded.add(dir);
  bump();
  if (!children.has(dir)) await loadDir(dir);
}

export function collapse(dir: string): void {
  if (!expanded.delete(dir)) return;
  bump();
}

export function toggleDir(dir: string): void {
  if (expanded.has(dir)) collapse(dir);
  else void expand(dir);
}

/** Re-reads the root and every expanded folder that was already loaded. */
export async function refreshTree(): Promise<void> {
  const dirs = ["", ...[...expanded].filter((d) => children.has(d))];
  await Promise.all(dirs.map((d) => loadDir(d, d !== "")));
}

/** Re-reads one folder if it is on screen (after a save). */
export function refreshDirOf(path: string): void {
  const d = dirname(path);
  if (d === "" || expanded.has(d)) void loadDir(d);
}

export function resetTree(): void {
  children.clear();
  expanded.clear();
  loading.clear();
  setSelected(null);
  bump();
}

export function expandedList(): string[] {
  version();
  return [...expanded];
}

/** Restores expanded folders from a session (parents before children). */
export function restoreExpanded(list: string[]): void {
  const sorted = [...list].sort((a, b) => a.split("/").length - b.split("/").length);
  for (const d of sorted) expanded.add(d);
  bump();
  for (const d of sorted) void loadDir(d, true);
}
