import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import type { Mode } from "../core/keymaps";

export type PickerKind = "file" | "buffer" | "command" | "worktree";
export type Overlay = null | { kind: "picker"; picker: PickerKind } | { kind: "help" };
export type BottomTab = "history" | "changes";

const GLOBAL_KEY = "ide-lite:prefs";

function loadPrefs(): { mode: Mode; hintsVisible: boolean } {
  try {
    const p = JSON.parse(localStorage.getItem(GLOBAL_KEY) ?? "{}");
    return { mode: p.mode === "standard" ? "standard" : "emacs", hintsVisible: p.hintsVisible !== false };
  } catch {
    return { mode: "emacs", hintsVisible: true };
  }
}

const prefs = loadPrefs();

export const [ui, setUi] = createStore({
  mode: prefs.mode as Mode,
  hintsVisible: prefs.hintsVisible,
  sidebarVisible: true,
  sidebarWidth: 260,
  bottomVisible: true,
  bottomHeight: 320,
  bottomTab: "history" as BottomTab,
  overlay: null as Overlay,
  /** Keys typed so far of an incomplete sequence (e.g. ["C-x"]). */
  pending: [] as string[],
  /** Focus context of the element that has focus (tree, editor, history…). */
  focusCtx: "global",
  cursor: { line: 1, col: 1 },
});

export function savePrefs(): void {
  try {
    localStorage.setItem(GLOBAL_KEY, JSON.stringify({ mode: ui.mode, hintsVisible: ui.hintsVisible }));
  } catch {
    /* storage unavailable */
  }
}

// Echo-area message shown in the hint bar for a few seconds.
const [message, setMessage] = createSignal<{ text: string; error: boolean } | null>(null);
export { message };
let msgTimer: number | undefined;

export function flash(text: string, error = false): void {
  setMessage({ text, error });
  clearTimeout(msgTimer);
  msgTimer = window.setTimeout(() => setMessage(null), error ? 6000 : 3500);
}

export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}
