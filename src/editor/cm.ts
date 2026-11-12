// The CodeMirror side of the editor: one EditorView, one EditorState per
// buffer. Loaded lazily as its own chunk.

import { Compartment, EditorSelection, EditorState, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import {
  EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers,
  type Command, type KeyBinding, type ViewUpdate,
} from "@codemirror/view";
import {
  cursorCharLeft, cursorCharRight, cursorDocEnd, cursorDocStart, cursorGroupBackward, cursorGroupForward, cursorLineDown,
  cursorLineEnd, cursorLineStart, cursorLineUp, cursorPageDown, cursorPageUp, defaultKeymap, deleteCharForward, history,
  historyKeymap, indentWithTab, redo, selectAll, selectCharLeft, selectCharRight, selectDocEnd, selectDocStart,
  selectGroupBackward, selectGroupForward, selectLineDown, selectLineEnd, selectLineStart, selectLineUp, selectPageDown,
  selectPageUp, toggleComment, undo,
} from "@codemirror/commands";
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { closeSearchPanel, findNext, findPrevious, highlightSelectionMatches, openSearchPanel, search, searchKeymap, searchPanelOpen } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { KEYMAPS, type Mode } from "../core/keymaps";
import { toCodeMirrorKey } from "../lib/keys";
import type { LangId } from "../lib/lang";
import { languageExtension } from "./languages";

export interface EditorHost {
  mode(): Mode;
  onDirty(path: string, dirty: boolean): void;
  onCursor(line: number, col: number): void;
  flash(text: string): void;
}

// ------------------------------------------------------------- emacs mark

const setMark = StateEffect.define<boolean>();
const markField = StateField.define<boolean>({
  create: () => false,
  update(active, tr) {
    for (const e of tr.effects) if (e.is(setMark)) return e.value;
    if (tr.docChanged || tr.isUserEvent("select.pointer")) return false;
    return active;
  },
});

const markActive = (s: EditorState) => s.field(markField, false) ?? false;
const move = (plain: Command, extend: Command): Command => (view) => (markActive(view.state) ? extend(view) : plain(view));

// ------------------------------------------------------------- kill ring

const ring: string[] = [];
let lastKill = false;
let lastYank: { from: number; to: number; index: number } | null = null;
let flashFn: (t: string) => void = () => {};

function pushKill(text: string, append: boolean): void {
  if (append && ring.length) ring[0] += text;
  else {
    ring.unshift(text);
    if (ring.length > 30) ring.pop();
  }
  navigator.clipboard?.writeText(ring[0]).catch(() => {});
}

const KILL = "delete.cut.kill";
const YANK = "input.paste.yank";

const killLine: Command = (view) => {
  const { state } = view;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const rest = state.sliceDoc(head, line.to);
  const to = head === line.to || /^\s*$/.test(rest) ? Math.min(line.to + 1, state.doc.length) : line.to;
  if (to <= head) return true;
  const append = lastKill;
  pushKill(state.sliceDoc(head, to), append);
  view.dispatch({ changes: { from: head, to }, selection: EditorSelection.cursor(head), userEvent: KILL, scrollIntoView: true });
  lastKill = true;
  return true;
};

const killRegion: Command = (view) => {
  const sel = view.state.selection.main;
  if (sel.empty) {
    flashFn("Nessuna regione selezionata (C-SPC imposta il mark)");
    return true;
  }
  pushKill(view.state.sliceDoc(sel.from, sel.to), lastKill);
  view.dispatch({ changes: { from: sel.from, to: sel.to }, selection: EditorSelection.cursor(sel.from), effects: setMark.of(false), userEvent: KILL });
  lastKill = true;
  return true;
};

const copyRegion: Command = (view) => {
  const sel = view.state.selection.main;
  if (sel.empty) {
    flashFn("Nessuna regione selezionata (C-SPC imposta il mark)");
    return true;
  }
  pushKill(view.state.sliceDoc(sel.from, sel.to), false);
  view.dispatch({ selection: EditorSelection.cursor(sel.head), effects: setMark.of(false) });
  flashFn("Regione copiata");
  return true;
};

function insertYank(view: EditorView, text: string, index: number): void {
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: EditorSelection.cursor(sel.from + text.length),
    effects: setMark.of(false),
    userEvent: YANK,
    scrollIntoView: true,
  });
  lastYank = { from: sel.from, to: sel.from + text.length, index };
}

/** Text copied by other programs enters the kill ring on the next yank. */
async function syncClipboard(): Promise<void> {
  try {
    const text = await navigator.clipboard?.readText();
    if (text && text !== ring[0]) ring.unshift(text);
  } catch {
    /* clipboard not readable: use the ring as it is */
  }
}

const yank: Command = (view) => {
  void syncClipboard().then(() => {
    if (ring.length) insertYank(view, ring[0], 0);
    else flashFn("Il kill ring è vuoto");
  });
  return true;
};

const yankPop: Command = (view) => {
  if (!lastYank || ring.length < 2) {
    flashFn("Il comando precedente non era uno yank");
    return true;
  }
  const index = (lastYank.index + 1) % ring.length;
  const text = ring[index];
  const { from, to } = lastYank;
  view.dispatch({ changes: { from, to, insert: text }, selection: EditorSelection.cursor(from + text.length), userEvent: YANK });
  lastYank = { from, to: from + text.length, index };
  return true;
};

const setMarkCmd: Command = (view) => {
  const active = markActive(view.state);
  const head = view.state.selection.main.head;
  view.dispatch({ selection: EditorSelection.cursor(head), effects: setMark.of(!active || !view.state.selection.main.empty) });
  flashFn(markActive(view.state) ? "Mark impostato" : "Mark disattivato");
  return true;
};

const searchForward: Command = (view) => (searchPanelOpen(view.state) ? findNext(view) : openSearchPanel(view));
const searchBackward: Command = (view) => (searchPanelOpen(view.state) ? findPrevious(view) : openSearchPanel(view));

/** Command id (from the keymap table) -> CodeMirror command. */
export const EDITOR_COMMANDS: Record<string, Command> = {
  "editor.charForward": move(cursorCharRight, selectCharRight),
  "editor.charBackward": move(cursorCharLeft, selectCharLeft),
  "editor.lineDown": move(cursorLineDown, selectLineDown),
  "editor.lineUp": move(cursorLineUp, selectLineUp),
  "editor.lineStart": move(cursorLineStart, selectLineStart),
  "editor.lineEnd": move(cursorLineEnd, selectLineEnd),
  "editor.wordForward": move(cursorGroupForward, selectGroupForward),
  "editor.wordBackward": move(cursorGroupBackward, selectGroupBackward),
  "editor.docStart": move(cursorDocStart, selectDocStart),
  "editor.docEnd": move(cursorDocEnd, selectDocEnd),
  "editor.pageDown": move(cursorPageDown, selectPageDown),
  "editor.pageUp": move(cursorPageUp, selectPageUp),
  "editor.deleteChar": deleteCharForward,
  "editor.killLine": killLine,
  "editor.killRegion": killRegion,
  "editor.copyRegion": copyRegion,
  "editor.yank": yank,
  "editor.yankPop": yankPop,
  "editor.setMark": setMarkCmd,
  "editor.undo": undo,
  "editor.redo": redo,
  "editor.search": searchForward,
  "editor.searchBack": searchBackward,
  "editor.toggleComment": toggleComment,
  "editor.selectAll": selectAll,
};

function tableKeymap(mode: Mode): KeyBinding[] {
  const out: KeyBinding[] = [];
  for (const b of KEYMAPS[mode]) {
    if (b.context !== "editor") continue;
    const run = EDITOR_COMMANDS[b.command];
    if (!run) continue;
    const isSearch = b.command === "editor.search" || b.command === "editor.searchBack";
    out.push({ key: toCodeMirrorKey(b.keys), run, preventDefault: true, scope: isSearch ? "editor search-panel" : undefined });
  }
  return out;
}

function modeExtension(mode: Mode): Extension {
  return [
    keymap.of([...tableKeymap(mode), indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    EditorView.editorAttributes.of({ class: mode === "emacs" ? "cm-mode-emacs" : "cm-mode-standard" }),
  ];
}

// ------------------------------------------------------------- look

const ACCENT = "#e8b04a";

const theme = EditorView.theme(
  {
    "&": { height: "100%", backgroundColor: "#17191c", color: "#d7dae0", fontSize: "12.5px" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "20px" },
    ".cm-content": { padding: "6px 0", caretColor: ACCENT },
    ".cm-gutters": { backgroundColor: "#17191c", color: "#9aa0aa", border: "none" },
    ".cm-lineNumbers .cm-gutterElement": { minWidth: "28px", padding: "0 16px 0 8px", textAlign: "right" },
    ".cm-activeLine": { backgroundColor: "#20242a" },
    ".cm-activeLineGutter": { backgroundColor: "#20242a", color: "#d7dae0" },
    ".cm-cursor, .cm-dropCursor": { borderLeft: `2px solid ${ACCENT}` },
    "&.cm-mode-emacs .cm-cursor": { borderLeft: "none", width: "1ch", backgroundColor: "rgba(232,176,74,0.75)" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "#35404f" },
    ".cm-selectionBackground": { backgroundColor: "#2c3440" },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "#3a3f48", outline: "1px solid #5a606b" },
    ".cm-nonmatchingBracket": { color: "#f09090" },
    ".cm-selectionMatch": { backgroundColor: "rgba(124,196,232,0.16)" },
    ".cm-searchMatch": { backgroundColor: "rgba(232,176,74,0.22)", outline: "1px solid rgba(232,176,74,0.55)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(232,176,74,0.55)" },
    ".cm-panels": { backgroundColor: "#1e2126", color: "#d7dae0" },
    ".cm-panels.cm-panels-bottom": { borderTop: "1px solid #2f343b" },
    ".cm-panel.cm-search": { padding: "6px 10px", fontFamily: "var(--ui)", fontSize: "12px" },
    ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label": { fontSize: "12px" },
    ".cm-textfield": { backgroundColor: "#17191c", border: "1px solid #2f343b", borderRadius: "5px", color: "#d7dae0", padding: "3px 6px" },
    ".cm-textfield:focus": { outline: "none", borderColor: ACCENT },
    ".cm-button": { backgroundImage: "none", backgroundColor: "#2a2e35", border: "1px solid #2f343b", borderRadius: "5px", color: "#d7dae0" },
    ".cm-panel.cm-search [name=close]": { color: "#9aa0aa" },
    ".cm-tooltip": { backgroundColor: "#1e2126", border: "1px solid #2f343b" },
  },
  { dark: true },
);

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword, t.modifier, t.self], color: "#c79bf2" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName, t.standard(t.typeName)], color: "#7cc4e8" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName, t.attributeName], color: "#e8c37a" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.inserted], color: "#9ccf8a" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta], color: "#9aa0aa", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: "#f0a37a" },
  { tag: [t.heading], color: ACCENT, fontWeight: "600" },
  { tag: [t.strong], fontWeight: "600" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.link, t.url], color: "#7cc4e8", textDecoration: "underline" },
  { tag: [t.propertyName, t.labelName], color: "#d7dae0" },
  { tag: [t.invalid, t.deleted], color: "#f09090" },
  { tag: [t.processingInstruction, t.annotation], color: "#e8c37a" },
]);

const phrases = EditorState.phrases.of({
  Find: "Cerca",
  Replace: "Sostituisci",
  next: "successivo",
  previous: "precedente",
  all: "tutti",
  "match case": "maiuscole",
  regexp: "regexp",
  "by word": "parola intera",
  replace: "sostituisci",
  "replace all": "sostituisci tutti",
  close: "chiudi",
  "Go to line": "Vai alla riga",
  go: "vai",
  "current match": "risultato corrente",
  "on line": "alla riga",
  "replaced match on line $": "sostituito alla riga $",
  "replaced $ matches": "sostituiti $ risultati",
});

// ------------------------------------------------------------- editor

interface Doc {
  state: EditorState;
  saved: Text;
  dirty: boolean;
  mode: Mode;
  scroll: StateEffect<unknown> | null;
}

export class Editor {
  readonly view: EditorView;
  private readonly keymapC = new Compartment();
  private readonly langC = new Compartment();
  private readonly docs = new Map<string, Doc>();
  private readonly empty: EditorState;
  current: string | null = null;

  constructor(parent: HTMLElement, private readonly host: EditorHost) {
    flashFn = (t) => host.flash(t);
    this.empty = EditorState.create({ doc: "", extensions: [EditorState.readOnly.of(true), theme, EditorView.editable.of(false)] });
    this.view = new EditorView({ parent, state: this.empty });
  }

  private extensions(path: string): Extension {
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: false }),
      syntaxHighlighting(highlight),
      theme,
      phrases,
      markField,
      EditorState.tabSize.of(4),
      this.keymapC.of(modeExtension(this.host.mode())),
      this.langC.of([]),
      EditorView.updateListener.of((u) => this.onUpdate(path, u)),
    ];
  }

  private onUpdate(path: string, u: ViewUpdate): void {
    for (const tr of u.transactions) {
      if (!tr.isUserEvent(KILL) && (tr.docChanged || tr.selection)) lastKill = false;
      if (!tr.isUserEvent(YANK) && (tr.docChanged || tr.selection)) lastYank = null;
    }
    const doc = this.docs.get(path);
    if (!doc) return;
    if (u.docChanged) {
      const d = u.state.doc;
      const dirty = d.length !== doc.saved.length || !d.eq(doc.saved);
      if (dirty !== doc.dirty) {
        doc.dirty = dirty;
        this.host.onDirty(path, dirty);
      }
    }
    if ((u.selectionSet || u.docChanged) && path === this.current) this.reportCursor();
  }

  private reportCursor(): void {
    const s = this.view.state;
    const head = s.selection.main.head;
    const line = s.doc.lineAt(head);
    this.host.onCursor(line.number, head - line.from + 1);
  }

  has(path: string): boolean {
    return this.docs.has(path);
  }

  open(path: string, text: string, lang: LangId): void {
    const state = EditorState.create({ doc: text, extensions: this.extensions(path) });
    this.docs.set(path, { state, saved: state.doc, dirty: false, mode: this.host.mode(), scroll: null });
    void languageExtension(lang).then((ext) => {
      if (ext) this.apply(path, this.langC.reconfigure(ext));
    });
  }

  /** Applies effects to a buffer, whether it is on screen or not. */
  private apply(path: string, effects: StateEffect<unknown>): void {
    const doc = this.docs.get(path);
    if (!doc) return;
    if (path === this.current) this.view.dispatch({ effects });
    else doc.state = doc.state.update({ effects }).state;
  }

  activate(path: string): void {
    const doc = this.docs.get(path);
    if (!doc || path === this.current) return;
    this.stash();
    this.view.setState(doc.state);
    this.current = path;
    const mode = this.host.mode();
    if (doc.mode !== mode) {
      doc.mode = mode;
      this.view.dispatch({ effects: this.keymapC.reconfigure(modeExtension(mode)) });
    }
    const scroll = doc.scroll;
    if (scroll) {
      // after setState the view needs one measure before a scroll target sticks
      this.view.dispatch({ effects: scroll });
      requestAnimationFrame(() => {
        if (this.current === path) this.view.dispatch({ effects: scroll });
      });
    }
    this.reportCursor();
  }

  /** Remembers the on-screen buffer's state and scroll position. */
  private stash(): void {
    if (!this.current) return;
    const cur = this.docs.get(this.current);
    if (cur) {
      cur.state = this.view.state;
      cur.scroll = this.view.scrollSnapshot();
    }
  }

  deactivate(): void {
    this.stash();
    this.current = null;
    this.view.setState(this.empty);
  }

  close(path: string): void {
    if (path === this.current) {
      this.current = null;
      this.view.setState(this.empty);
    }
    this.docs.delete(path);
  }

  clear(): void {
    this.docs.clear();
    this.current = null;
    this.view.setState(this.empty);
  }

  text(path: string, eol: "lf" | "crlf"): string | null {
    const doc = this.docs.get(path);
    if (!doc) return null;
    const state = path === this.current ? this.view.state : doc.state;
    return state.doc.toJSON().join(eol === "crlf" ? "\r\n" : "\n");
  }

  markSaved(path: string, savedText?: Text): void {
    const doc = this.docs.get(path);
    if (!doc) return;
    const state = path === this.current ? this.view.state : doc.state;
    doc.saved = savedText ?? state.doc;
    const dirty = !state.doc.eq(doc.saved);
    doc.dirty = dirty;
    this.host.onDirty(path, dirty);
  }

  /** The document as it is now, to mark exactly that version as saved later. */
  snapshot(path: string): Text | null {
    const doc = this.docs.get(path);
    if (!doc) return null;
    return (path === this.current ? this.view.state : doc.state).doc;
  }

  setMode(mode: Mode): void {
    const effects = this.keymapC.reconfigure(modeExtension(mode));
    for (const [path, doc] of this.docs) {
      doc.mode = mode;
      if (path === this.current) this.view.dispatch({ effects });
      else doc.state = doc.state.update({ effects }).state;
    }
  }

  focus(): void {
    this.view.focus();
  }

  hasFocus(): boolean {
    return this.view.hasFocus;
  }

  /** C-g inside the editor: drop the mark and selection, close the search panel. */
  cancel(): void {
    if (!this.current) return;
    const v = this.view;
    if (searchPanelOpen(v.state)) closeSearchPanel(v);
    v.dispatch({ selection: EditorSelection.cursor(v.state.selection.main.head), effects: setMark.of(false) });
    v.focus();
  }
}
