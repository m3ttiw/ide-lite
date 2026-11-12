import { createMemo, createRoot } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { api } from "../api";
import type { Editor, EditorHost } from "../editor/cm";
import { LANG_NAMES, langOf, type LangId } from "../lib/lang";
import { basename } from "../lib/path";
import { refreshDirOf } from "./tree";
import { errorText, flash, setUi, ui } from "./ui";
import { toRepoPath } from "../lib/gitroot";
import { generation, refreshStatus, repoPrefix, root } from "./workspace";

export type BufferStatus = "unloaded" | "loading" | "text" | "binary" | "tooLarge" | "error";

export interface Buffer {
  path: string;
  name: string;
  status: BufferStatus;
  dirty: boolean;
  eol: "lf" | "crlf";
  lang: LangId;
  error?: string;
}

export const [bufs, setBufs] = createStore<{ list: Buffer[]; active: string | null }>({ list: [], active: null });

/** Most recently used first. */
let mru: string[] = [];

export const activeBuffer = createRoot(() => createMemo(() => bufs.list.find((b) => b.path === bufs.active) ?? null));

export const activeLanguageName = () => {
  const b = activeBuffer();
  return b ? LANG_NAMES[b.lang] : "";
};

// ------------------------------------------------------------- editor bridge

let hostEl: HTMLElement | null = null;
let editor: Editor | null = null;
let editorLoading: Promise<Editor> | null = null;

const host: EditorHost = {
  mode: () => ui.mode,
  onDirty: (path, dirty) => setBufs("list", (b) => b.path === path, "dirty", dirty),
  onCursor: (line, col) => setUi("cursor", { line, col }),
  flash: (t) => flash(t),
};

export function registerEditorHost(el: HTMLElement): void {
  hostEl = el;
}

/** Downloads the CodeMirror chunk without creating the view. */
export function prefetchEditor(): void {
  void import("../editor/cm");
}

export function ensureEditor(): Promise<Editor> {
  editorLoading ??= import("../editor/cm").then((m) => {
    if (!hostEl) throw new Error("editor host missing");
    editor = new m.Editor(hostEl, host);
    return editor;
  });
  return editorLoading;
}

export const currentEditor = () => editor;

// ------------------------------------------------------------- buffers

function touch(path: string): void {
  mru = [path, ...mru.filter((p) => p !== path)];
}

export function mruPaths(): string[] {
  const open = new Set(bufs.list.map((b) => b.path));
  const order = mru.filter((p) => open.has(p));
  for (const b of bufs.list) if (!order.includes(b.path)) order.push(b.path);
  return order;
}

function update(path: string, patch: Partial<Buffer>): void {
  setBufs("list", (b) => b.path === path, patch);
}

async function load(path: string): Promise<void> {
  const g = generation();
  update(path, { status: "loading", error: undefined });
  try {
    const [content, ed] = await Promise.all([api.readFile(root(), path), ensureEditor()]);
    if (g !== generation() || !bufs.list.some((b) => b.path === path)) return;
    if (content.binary) return update(path, { status: "binary" });
    if (content.tooLarge) return update(path, { status: "tooLarge" });
    ed.open(path, content.text, langOf(path));
    update(path, { status: "text", eol: content.eol, dirty: false });
    if (bufs.active === path) showActive();
  } catch (e) {
    if (g === generation()) update(path, { status: "error", error: errorText(e) });
  }
}

/** Puts the active buffer on screen (or hides the editor view). */
function showActive(): void {
  const b = activeBuffer();
  if (!editor) return;
  if (b && b.status === "text" && editor.has(b.path)) editor.activate(b.path);
  else editor.deactivate();
}

export function activate(path: string): void {
  const b = bufs.list.find((x) => x.path === path);
  if (!b) return;
  setBufs("active", path);
  touch(path);
  if (b.status === "unloaded" || b.status === "error") void load(path);
  showActive();
}

export async function openFile(path: string, opts: { focus?: boolean } = {}): Promise<void> {
  if (!bufs.list.some((b) => b.path === path)) {
    setBufs("list", (l) => [...l, { path, name: basename(path), status: "unloaded", dirty: false, eol: "lf", lang: langOf(path) }]);
  }
  activate(path);
  if (opts.focus !== false) await focusEditorWhenReady(path);
}

async function focusEditorWhenReady(path: string): Promise<void> {
  const ed = await ensureEditor();
  // wait for the content to arrive (load() is already running)
  for (let i = 0; i < 100 && bufs.active === path; i++) {
    const b = bufs.list.find((x) => x.path === path);
    if (!b || b.status !== "loading") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  if (bufs.active !== path) return;
  const b = bufs.list.find((x) => x.path === path);
  if (b?.status === "text") ed.focus();
  else document.querySelector<HTMLElement>("[data-ctx=editor]")?.focus();
}

let closeArmed: { path: string; until: number } | null = null;

export function closeBuffer(path: string | null = bufs.active): void {
  if (!path) return;
  const b = bufs.list.find((x) => x.path === path);
  if (!b) return;
  if (b.dirty && !(closeArmed && closeArmed.path === path && closeArmed.until > Date.now())) {
    closeArmed = { path, until: Date.now() + 4000 };
    flash(`${b.name} ha modifiche non salvate: ripeti per chiudere senza salvare`, true);
    return;
  }
  closeArmed = null;
  editor?.close(path);
  mru = mru.filter((p) => p !== path);
  setBufs(
    produce((s) => {
      s.list = s.list.filter((x) => x.path !== path);
      if (s.active === path) s.active = null;
    }),
  );
  if (!bufs.active) {
    const next = mruPaths()[0];
    if (next) activate(next);
    else showActive();
  }
}

export async function saveActive(): Promise<void> {
  const b = activeBuffer();
  if (!b) return flash("Nessun buffer da salvare");
  if (b.status !== "text" || !editor) return flash(`${b.name} non è modificabile`);
  if (!b.dirty) return flash(`${b.name}: nessuna modifica da salvare`);
  const g = generation();
  const snap = editor.snapshot(b.path);
  const text = editor.text(b.path, b.eol);
  if (text === null || !snap) return;
  try {
    await api.writeFile(root(), b.path, text);
    if (g !== generation()) return;
    editor.markSaved(b.path, snap);
    flash(`Salvato ${b.path} (${b.eol.toUpperCase()})`);
    // git status only when the file lives in the active repository
    if (toRepoPath(repoPrefix(), b.path) !== null) void refreshStatus();
    refreshDirOf(b.path);
  } catch (e) {
    flash(`Salvataggio non riuscito: ${errorText(e)}`, true);
  }
}

export const dirtyBuffers = () => bufs.list.filter((b) => b.dirty);

export function resetBuffers(): void {
  editor?.clear();
  mru = [];
  setBufs({ list: [], active: null });
}

/** Restores tabs from a session: only the active one is read now. */
export function restoreBuffers(paths: string[], active: string | null): void {
  setBufs({
    list: paths.map((path) => ({ path, name: basename(path), status: "unloaded" as BufferStatus, dirty: false, eol: "lf" as const, lang: langOf(path) })),
    active: null,
  });
  mru = active ? [active, ...paths.filter((p) => p !== active)] : [...paths];
  const first = active && paths.includes(active) ? active : paths[0];
  if (first) activate(first);
}
