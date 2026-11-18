import { createSignal } from "solid-js";
import { activeBuffer, currentEditor } from "./buffers";
import { setUi, ui, type Overlay } from "./ui";
import { gitRoot } from "./workspace";

// Focusable regions register themselves so commands can move focus.
const regions: Record<string, HTMLElement | undefined> = {};

export function registerRegion(name: "tree" | "editorPane" | "history" | "changes" | "review" | "repos", el: HTMLElement): void {
  regions[name] = el;
}

export interface ListHandle {
  next(): void;
  prev(): void;
  toDiff(): void;
}

export interface DiffHandle {
  nextFile(): void;
  prevFile(): void;
  toggleFile(): void;
  back(): void;
  scroll(rows: number): void;
  page(dir: 1 | -1): void;
  focus(): void;
  /** File under the cursor (the first one when none is current). */
  currentPath(): string | null;
}

export interface CompareHandle {
  nextChange(): void;
  prevChange(): void;
  scroll(lines: number): void;
  page(dir: 1 | -1): void;
}
let compareHandle: CompareHandle | null = null;
export const setCompareHandle = (h: CompareHandle | null) => (compareHandle = h);
export const getCompareHandle = () => compareHandle;

export const listHandles: Partial<Record<"history" | "changes" | "review", ListHandle>> = {};

/** Repository column of the bottom panel (folder workspace). */
export interface RepoColumnHandle {
  move(delta: number): void;
  page(dir: 1 | -1): void;
  activate(): void;
  openHere(): void;
}
let repoHandle: RepoColumnHandle | null = null;
export const setRepoHandle = (h: RepoColumnHandle | null) => (repoHandle = h);
export const getRepoHandle = () => repoHandle;

/** Focuses the repository column; false when it is not shown. */
export function focusRepos(): boolean {
  const el = regions.repos;
  if (!el?.isConnected || el.offsetParent === null) return false;
  el.focus();
  return true;
}
export const diffHandles: Partial<Record<"history" | "changes" | "review", DiffHandle>> = {};
let activeDiff: DiffHandle | null = null;
export const setActiveDiff = (d: DiffHandle | null) => (activeDiff = d);
export const getActiveDiff = () => activeDiff;

export interface PickerHandle {
  move(delta: number): void;
  page(dir: 1 | -1): void;
  accept(): void;
  /** Item of the selected row. */
  current(): unknown;
  /** Index of the selected row. */
  index(): number;
  /** Items of the rows shown, in order. */
  rows(): unknown[];
}
let pickerHandle: PickerHandle | null = null;
export const setPickerHandle = (h: PickerHandle | null) => (pickerHandle = h);
export const getPickerHandle = () => pickerHandle;

export interface FolderHandle {
  enter(): void;
  up(): void;
  openHere(): void;
}
let folderHandle: FolderHandle | null = null;
export const setFolderHandle = (h: FolderHandle | null) => (folderHandle = h);
export const getFolderHandle = () => folderHandle;

export interface SettingsHandle {
  move(delta: 1 | -1): void;
  activate(): void;
  scrollNotes(dir: 1 | -1): void;
}
let settingsHandle: SettingsHandle | null = null;
export const setSettingsHandle = (h: SettingsHandle | null) => (settingsHandle = h);
export const getSettingsHandle = () => settingsHandle;

export interface HelpHandle {
  scroll(px: number): void;
  page(dir: 1 | -1): void;
}
let helpHandle: HelpHandle | null = null;
export const setHelpHandle = (h: HelpHandle | null) => (helpHandle = h);
export const getHelpHandle = () => helpHandle;

export const [pickerQuery, setPickerQuery] = createSignal("");

let returnFocus: Element | null = null;

export function openOverlay(o: Exclude<Overlay, null>): void {
  if (!ui.overlay) returnFocus = document.activeElement;
  setPickerQuery("");
  setUi("pending", []);
  setUi("overlay", o);
}

export function closeOverlay(): void {
  setUi("overlay", null);
  const el = returnFocus;
  returnFocus = null;
  if (el instanceof HTMLElement && el.isConnected && el !== document.body && !("noReturn" in el.dataset)) el.focus();
  else focusEditor();
}

/**
 * Solid renders synchronously, so a region shown by the line before is
 * usually already in the DOM: focus it now, so that keys typed right after the
 * command land in it. Fall back to the next frame otherwise.
 */
function focusRegion(name: string): void {
  const el = regions[name];
  if (el?.isConnected && el.offsetParent !== null) el.focus();
  else requestAnimationFrame(() => regions[name]?.focus());
}

export function focusTree(): void {
  if (!ui.sidebarVisible) setUi("sidebarVisible", true);
  focusRegion("tree");
}

export function focusEditor(): void {
  const b = activeBuffer();
  const ed = currentEditor();
  if (b?.status === "text" && ed) ed.focus();
  else regions.editorPane?.focus();
}

/**
 * In a folder workspace with no repository chosen yet, the history and
 * changes lists are empty: the only useful place is the repository column.
 */
function focusReposWhenNoneActive(): boolean {
  return !gitRoot() && focusRepos();
}

export function focusBottom(tab = ui.bottomTab): void {
  setUi("bottomVisible", true);
  setUi("bottomTab", tab);
  if (!focusReposWhenNoneActive()) focusRegion(tab);
}

/** C-x o: sidebar -> editor -> bottom panel -> sidebar, skipping hidden ones. */
export function focusNext(): void {
  const order: ("tree" | "editor" | "bottom")[] = [];
  if (ui.sidebarVisible) order.push("tree");
  order.push("editor");
  if (ui.bottomVisible) order.push("bottom");
  const cur = ui.focusCtx === "tree" ? "tree" : ui.focusCtx === "editor" ? "editor" : ["history", "changes", "review", "diff", "repos"].includes(ui.focusCtx) ? "bottom" : null;
  const i = cur ? order.indexOf(cur) : -1;
  const next = order[(i + 1) % order.length];
  if (next === "tree") regions.tree?.focus();
  else if (next === "editor") focusEditor();
  else if (!focusReposWhenNoneActive()) regions[ui.bottomTab]?.focus();
}
