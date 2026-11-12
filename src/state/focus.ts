import { createSignal } from "solid-js";
import { activeBuffer, currentEditor } from "./buffers";
import { setUi, ui, type Overlay } from "./ui";

// Focusable regions register themselves so commands can move focus.
const regions: Record<string, HTMLElement | undefined> = {};

export function registerRegion(name: "tree" | "editorPane" | "history" | "changes", el: HTMLElement): void {
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
}

export const listHandles: Partial<Record<"history" | "changes", ListHandle>> = {};
export const diffHandles: Partial<Record<"history" | "changes", DiffHandle>> = {};
let activeDiff: DiffHandle | null = null;
export const setActiveDiff = (d: DiffHandle | null) => (activeDiff = d);
export const getActiveDiff = () => activeDiff;

export interface PickerHandle {
  move(delta: number): void;
  page(dir: 1 | -1): void;
  accept(): void;
}
let pickerHandle: PickerHandle | null = null;
export const setPickerHandle = (h: PickerHandle | null) => (pickerHandle = h);
export const getPickerHandle = () => pickerHandle;

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

export function focusBottom(tab = ui.bottomTab): void {
  setUi("bottomVisible", true);
  setUi("bottomTab", tab);
  focusRegion(tab);
}

/** C-x o: sidebar -> editor -> bottom panel -> sidebar, skipping hidden ones. */
export function focusNext(): void {
  const order: ("tree" | "editor" | "bottom")[] = [];
  if (ui.sidebarVisible) order.push("tree");
  order.push("editor");
  if (ui.bottomVisible) order.push("bottom");
  const cur = ui.focusCtx === "tree" ? "tree" : ui.focusCtx === "editor" ? "editor" : ["history", "changes", "diff"].includes(ui.focusCtx) ? "bottom" : null;
  const i = cur ? order.indexOf(cur) : -1;
  const next = order[(i + 1) % order.length];
  if (next === "tree") regions.tree?.focus();
  else if (next === "editor") focusEditor();
  else regions[ui.bottomTab]?.focus();
}
