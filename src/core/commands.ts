import { api, isTauri } from "../api";
import { dirname } from "../lib/path";
import { bufs, closeBuffer, currentEditor, dirtyBuffers, openFile, saveActive } from "../state/buffers";
import {
  closeOverlay, diffHandles, focusBottom, focusEditor, focusNext, focusTree, getActiveDiff, getFolderHandle, getHelpHandle,
  getPickerHandle, listHandles, openOverlay, pickerQuery,
} from "../state/focus";
import { openProjectPicker } from "../state/projects";
import { refreshChangeDiff, reloadLog, commits } from "../state/git";
import { switchRoot } from "../state/session";
import { collapse, expand, isExpanded, refreshTree, selected, setSelected, toggleDir, treeRows } from "../state/tree";
import { errorText, flash, savePrefs, setUi, ui } from "../state/ui";
import { refreshRepo, refreshStatus, repo, root } from "../state/workspace";
import { invalidateWtStatuses, loadWorktrees } from "../state/worktrees";
import { MODE_NAMES } from "./keymaps";

export interface Command {
  id: string;
  title: string;
  run: () => unknown;
  /** Listed in the command palette (M-x). */
  palette?: boolean;
}

const registry = new Map<string, Command>();

function def(id: string, title: string, run: () => unknown, palette = true): void {
  registry.set(id, { id, title, run, palette });
}

export const getCommand = (id: string) => registry.get(id);
export const allCommands = () => [...registry.values()];

export function runCommand(id: string): void {
  const c = registry.get(id);
  if (!c) return flash(`Comando sconosciuto: ${id}`, true);
  try {
    const r = c.run();
    if (r instanceof Promise) r.catch((e) => flash(errorText(e), true));
  } catch (e) {
    flash(errorText(e), true);
  }
}

// ------------------------------------------------------------- global

def("file.quickOpen", "Apri file", () => {
  if (!root()) return flash("Nessuna cartella aperta");
  openOverlay({ kind: "picker", picker: "file" });
});
def("file.save", "Salva", () => saveActive());
def("buffer.switch", "Cambia buffer", () => {
  if (!bufs.list.length) return flash("Nessun buffer aperto");
  openOverlay({ kind: "picker", picker: "buffer" });
});
def("buffer.close", "Chiudi buffer", () => {
  if (!bufs.active) return flash("Nessun buffer da chiudere");
  closeBuffer();
});
def("focus.next", "Pannello successivo", () => focusNext());
def("focus.tree", "Vai ai file", () => focusTree());
def("focus.editor", "Vai all'editor", () => focusEditor());
def("git.history", "Cronologia git", () => focusBottom("history"));
def("git.changes", "Modifiche", () => focusBottom("changes"));
def("worktree.pick", "Cerca worktree", () => {
  if (!repo()?.isRepo) return flash("La cartella aperta non è un repository git");
  void loadWorktrees();
  openOverlay({ kind: "picker", picker: "worktree" });
});
def("folder.browse", "Sfoglia cartelle", () => openOverlay({ kind: "picker", picker: "folder" }));
def("project.pick", "Cambia progetto", () => openProjectPicker());
def("folder.open", "Apri cartella con la finestra di sistema", async () => {
  const p = await api.pickFolder();
  if (p) await switchRoot(p);
});
def("panel.toggleBottom", "Mostra/nascondi pannello in basso", () => {
  const hide = ui.bottomVisible;
  const inside = ["history", "changes", "diff"].includes(ui.focusCtx);
  setUi("bottomVisible", !hide);
  if (hide && inside) focusEditor();
});
def("sidebar.toggle", "Mostra/nascondi barra laterale", () => {
  const hide = ui.sidebarVisible;
  setUi("sidebarVisible", !hide);
  if (hide && ui.focusCtx === "tree") focusEditor();
});
def("hints.toggle", "Mostra/nascondi barra dei suggerimenti", () => {
  setUi("hintsVisible", !ui.hintsVisible);
  savePrefs();
});
def("keymap.toggle", "Cambia tasti (Emacs / Standard)", () => {
  const mode = ui.mode === "emacs" ? "standard" : "emacs";
  setUi("mode", mode);
  savePrefs();
  currentEditor()?.setMode(mode);
  flash(`Tasti: ${MODE_NAMES[mode]}`);
});
def("palette.open", "Comandi", () => openOverlay({ kind: "picker", picker: "command" }));
def("help.open", "Tutte le scorciatoie", () => openOverlay({ kind: "help" }));
def("app.cancel", "Annulla", () => {
  if (ui.overlay) return closeOverlay();
  const ed = currentEditor();
  if (ui.focusCtx === "editor" && ed?.current) return ed.cancel();
  if (ui.focusCtx === "diff") return getActiveDiff()?.back();
  flash("Annullato");
});

let quitArmed = 0;
def("app.quit", "Esci", async () => {
  const dirty = dirtyBuffers();
  if (dirty.length && Date.now() > quitArmed) {
    quitArmed = Date.now() + 4000;
    return flash(`${dirty.length} buffer non salvati: ripeti per uscire comunque`, true);
  }
  if (!isTauri) return flash("Nel browser la finestra non si può chiudere da qui");
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
});
def("git.refresh", "Aggiorna stato git", () => {
  void refreshStatus().then(refreshChangeDiff);
  void refreshRepo();
  invalidateWtStatuses();
  if (commits().length) void reloadLog();
  flash("Stato git aggiornato");
});
def("tree.refresh", "Aggiorna l'albero dei file", () => refreshTree());

// ------------------------------------------------------------- file tree

function treeIndex(): number {
  const rows = treeRows();
  const i = rows.findIndex((r) => r.entry.path === selected());
  return i;
}

function treeMove(delta: number): void {
  const rows = treeRows();
  if (!rows.length) return;
  const i = treeIndex();
  const n = i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + delta));
  setSelected(rows[n].entry.path);
}

function treeCurrent() {
  const rows = treeRows();
  const i = treeIndex();
  return i >= 0 ? rows[i] : undefined;
}

def("tree.next", "Voce successiva", () => treeMove(1), false);
def("tree.prev", "Voce precedente", () => treeMove(-1), false);
def("tree.first", "Prima voce", () => treeMove(-Infinity), false);
def("tree.last", "Ultima voce", () => treeMove(Infinity), false);
def("tree.open", "Apri file / espandi cartella", () => {
  const r = treeCurrent();
  if (!r) return treeMove(0);
  if (r.entry.kind === "dir") toggleDir(r.entry.path);
  else void openFile(r.entry.path, { focus: true });
}, false);
def("tree.expand", "Espandi / anteprima file", () => {
  const r = treeCurrent();
  if (!r) return treeMove(0);
  if (r.entry.kind === "file") return void openFile(r.entry.path, { focus: false });
  if (!isExpanded(r.entry.path)) return void expand(r.entry.path);
  treeMove(1);
}, false);
def("tree.collapse", "Comprimi / vai alla cartella superiore", () => {
  const r = treeCurrent();
  if (!r) return;
  if (r.entry.kind === "dir" && isExpanded(r.entry.path)) return collapse(r.entry.path);
  const parent = dirname(r.entry.path);
  if (parent) setSelected(parent);
}, false);

// ------------------------------------------------------------- lists and diffs

const listCtx = () => (ui.focusCtx === "changes" ? "changes" : "history");
def("list.next", "Elemento successivo", () => listHandles[listCtx()]?.next(), false);
def("list.prev", "Elemento precedente", () => listHandles[listCtx()]?.prev(), false);
def("list.toDiff", "Vai al diff", () => listHandles[listCtx()]?.toDiff(), false);

const diff = () => getActiveDiff() ?? diffHandles[ui.bottomTab];
def("diff.nextFile", "File successivo", () => diff()?.nextFile(), false);
def("diff.prevFile", "File precedente", () => diff()?.prevFile(), false);
def("diff.toggleFile", "Apri/chiudi file", () => diff()?.toggleFile(), false);
def("diff.back", "Torna all'elenco", () => diff()?.back(), false);
def("diff.down", "Scorri giù", () => diff()?.scroll(1), false);
def("diff.up", "Scorri su", () => diff()?.scroll(-1), false);
def("diff.pageDown", "Pagina giù", () => diff()?.page(1), false);
def("diff.pageUp", "Pagina su", () => diff()?.page(-1), false);

// ------------------------------------------------------------- pickers and help

def("picker.next", "Risultato successivo", () => getPickerHandle()?.move(1), false);
def("picker.prev", "Risultato precedente", () => getPickerHandle()?.move(-1), false);
def("picker.pageDown", "Pagina giù", () => getPickerHandle()?.page(1), false);
def("picker.pageUp", "Pagina su", () => getPickerHandle()?.page(-1), false);
def("picker.accept", "Apri la scelta", () => getPickerHandle()?.accept(), false);
def("worktree.create", "Nuovo worktree con questo nome", async () => {
  const name = pickerQuery().trim();
  if (!name) return flash("Scrivi il nome del branch per il nuovo worktree");
  if (/\s/.test(name)) return flash("Il nome del branch non può contenere spazi", true);
  flash(`Creo il worktree ${name}…`);
  const wt = await api.addWorktree(root(), name);
  closeOverlay();
  if (await switchRoot(wt.path)) flash(`Creato il worktree ${name} in ${wt.path}`);
}, false);
def("folder.enter", "Entra nella cartella", () => getFolderHandle()?.enter(), false);
def("folder.up", "Cartella superiore", () => getFolderHandle()?.up(), false);
def("folder.openHere", "Apri la cartella evidenziata", () => getFolderHandle()?.openHere(), false);
def("help.down", "Scorri giù", () => getHelpHandle()?.scroll(40), false);
def("help.up", "Scorri su", () => getHelpHandle()?.scroll(-40), false);
def("help.pageDown", "Pagina giù", () => getHelpHandle()?.page(1), false);
def("help.pageUp", "Pagina su", () => getHelpHandle()?.page(-1), false);

// ------------------------------------------------------------- editor (run by CodeMirror)

const EDITOR_TITLES: Record<string, string> = {
  "editor.charForward": "Carattere avanti",
  "editor.charBackward": "Carattere indietro",
  "editor.lineDown": "Riga successiva",
  "editor.lineUp": "Riga precedente",
  "editor.lineStart": "Inizio riga",
  "editor.lineEnd": "Fine riga",
  "editor.wordForward": "Parola avanti",
  "editor.wordBackward": "Parola indietro",
  "editor.docStart": "Inizio file",
  "editor.docEnd": "Fine file",
  "editor.pageDown": "Pagina giù",
  "editor.pageUp": "Pagina su",
  "editor.deleteChar": "Cancella carattere",
  "editor.killLine": "Taglia fino a fine riga (kill)",
  "editor.killRegion": "Taglia la regione",
  "editor.copyRegion": "Copia la regione",
  "editor.yank": "Incolla (yank)",
  "editor.yankPop": "Yank precedente del kill ring",
  "editor.setMark": "Imposta il mark",
  "editor.undo": "Annulla modifica",
  "editor.redo": "Ripeti modifica",
  "editor.search": "Cerca nel file",
  "editor.searchBack": "Cerca all'indietro",
  "editor.toggleComment": "Commenta / decommenta",
  "editor.selectAll": "Seleziona tutto",
};
for (const [id, title] of Object.entries(EDITOR_TITLES)) def(id, title, () => focusEditor(), false);
