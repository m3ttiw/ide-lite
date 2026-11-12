import { createEffect, createRoot, on } from "solid-js";
import { Dispatcher, eventToKey } from "../lib/keys";
import { flash, setUi, ui } from "../state/ui";
import { runCommand } from "./commands";
import { KEYMAPS } from "./keymaps";

const dispatcher = new Dispatcher(KEYMAPS[ui.mode]);

createRoot(() =>
  createEffect(
    on(
      () => ui.mode,
      (m) => {
        dispatcher.setBindings(KEYMAPS[m]);
        setUi("pending", []);
      },
      { defer: true },
    ),
  ),
);

/** Contexts used to resolve keys, most specific first. */
export function activeContexts(): string[] {
  const o = ui.overlay;
  if (o?.kind === "picker") return [`picker:${o.picker}`, "picker", "global"];
  if (o?.kind === "help") return ["help", "global"];
  if (o?.kind === "settings") return ["settings", "global"];
  return [ui.focusCtx, "global"];
}

// Browser accelerators that would reload, print, open dialogs or move focus
// out of the app. Blocked when nothing in the app handled them.
const BLOCKED = new Set([
  "C-r", "C-S-r", "<f5>", "C-<f5>", "C-p", "C-S-p", "C-f", "C-g", "C-S-g", "C-j", "C-u", "C-s", "C-o", "C-h", "C-d", "C-e",
  "C-k", "C-l", "C-n", "C-b", "<f3>", "S-<f3>", "<f7>", "<f1>", "C-S-o", "C-S-b", "C-S-i", "C-S-j", "C-S-c",
]);

function onKeyCapture(e: KeyboardEvent): void {
  if (e.isComposing) return;
  const key = eventToKey(e);
  if (!key) return;
  const r = dispatcher.feed(key, activeContexts());
  if (r.kind === "pass") return;
  if (r.kind === "command" && r.binding.context === "editor") {
    setUi("pending", []);
    return; // CodeMirror owns editing keys
  }
  e.preventDefault();
  e.stopPropagation();
  switch (r.kind) {
    case "prefix":
      setUi("pending", r.pending);
      break;
    case "cancel":
      setUi("pending", []);
      flash("Annullato");
      break;
    case "undefined":
      setUi("pending", []);
      flash(`${r.seq.join(" ")} non è assegnato`);
      break;
    case "command":
      setUi("pending", []);
      runCommand(r.command);
      break;
  }
}

function onKeyBubble(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  const key = eventToKey(e);
  if (key && BLOCKED.has(key)) e.preventDefault();
}

function contextOf(el: Element | null): string {
  const host = el?.closest<HTMLElement>("[data-ctx]");
  return host?.dataset.ctx ?? "global";
}

export function installKeyboard(): void {
  window.addEventListener("keydown", onKeyCapture, true);
  window.addEventListener("keydown", onKeyBubble, false);
  document.addEventListener("focusin", (e) => setUi("focusCtx", contextOf(e.target as Element)));
  document.addEventListener("focusout", () => {
    setTimeout(() => {
      if (document.activeElement === document.body) setUi("focusCtx", "global");
    }, 0);
  });
  // Dropping a file on the window would navigate away from the app.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
}
