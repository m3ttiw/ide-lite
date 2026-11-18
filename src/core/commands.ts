import { api, isTauri, type Worktree } from "../api";
import { extendMarks, toggleMark } from "../lib/marks";
import { dirname, displayWorktreePath } from "../lib/path";
import { askConfirm, confirmRequest, resolveConfirm } from "../state/confirm";
import { bufs, closeBuffer, currentEditor, dirtyBuffers, openFile, saveActive } from "../state/buffers";
import {
  closeOverlay, diffHandles, focusBottom, focusEditor, focusNext, focusTree, getActiveDiff, getFolderHandle, getHelpHandle,
  getPickerHandle, getRepoHandle, getSettingsHandle, focusRepos, listHandles, openOverlay, pickerQuery,
} from "../state/focus";
import { runUpdate } from "../state/updates";
import { loadRepos, openProjectPicker } from "../state/projects";
import { changeSel, refreshChangeDiff, reloadLog, commits } from "../state/git";
import { markAllSeen, reviewSel, toggleFull, toggleSeen } from "../state/review";
import { invalidateRepoDirty, openWorktree } from "../state/activeRepo";
import { toWorkspacePath } from "../lib/gitroot";
import { switchRoot } from "../state/session";
import { collapse, expand, isExpanded, refreshTree, selected, setSelected, toggleDir, treeRows } from "../state/tree";
import { errorText, flash, savePrefs, setUi, ui } from "../state/ui";
import { activeRepo, gitRoot, isFolderWs, refreshRepo, refreshStatus, repo, repoPrefix, root } from "../state/workspace";
import {
  cannotRemove, clearWtMarks, invalidateWtStatuses, loadWorktrees, mainWorktree, reloadWorktrees, setWtDeleting, setWtMarks, worktreeLabel,
  worktrees, wtDeleting, wtMarks,
} from "../state/worktrees";
import { KEYMAPS, MODE_NAMES, keyFor } from "./keymaps";

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
def("git.review", "Revisione del worktree", () => focusBottom("review"));
def("worktree.pick", "Cerca worktree", () => {
  if (isFolderWs() && !activeRepo()) return flash("Scegli prima un repository dalla colonna Repository");
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
  const inside = ["history", "changes", "review", "diff", "repos"].includes(ui.focusCtx);
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
  if (confirmRequest()) return resolveConfirm(false);
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
  invalidateRepoDirty();
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

const listCtx = () => (ui.focusCtx === "changes" || ui.focusCtx === "review" ? ui.focusCtx : "history");
def("list.next", "Elemento successivo", () => listHandles[listCtx()]?.next(), false);
def("list.prev", "Elemento precedente", () => listHandles[listCtx()]?.prev(), false);
def("list.toDiff", "Vai al diff", () => listHandles[listCtx()]?.toDiff(), false);

// ------------------------------------------------------------- review

/** Review commands act from the review list or from its diff. */
const inReview = () => ui.focusCtx === "review" || (ui.focusCtx === "diff" && getActiveDiff() === diffHandles.review);
def("review.toggleSeen", "Segna come visto / da rivedere", () => {
  if (inReview()) void toggleSeen();
}, false);
def("review.toggleFull", "Revisione: solo le novità / tutto rispetto alla base", () => {
  if (inReview()) toggleFull();
}, false);
def("review.markAll", "Segna tutta la revisione come vista", () => void markAllSeen());
def("review.openFile", "Apri il file in revisione", () => {
  const path = reviewSel();
  if (!path) return flash("Nessun file selezionato");
  const p = toWorkspacePath(repoPrefix(), path);
  if (p === null) return flash("Il repository attivo è fuori dalla cartella aperta", true);
  void openFile(p, { focus: true });
}, false);

def("changes.openFile", "Apri il file modificato", () => {
  const sel = changeSel();
  if (!sel) return flash("Nessun file selezionato");
  const p = toWorkspacePath(repoPrefix(), sel.path);
  if (p === null) return flash("Il repository attivo è fuori dalla cartella aperta", true);
  void openFile(p, { focus: true });
}, false);

// ------------------------------------------------------------- repository column (folder workspace)

def("repos.next", "Repository successivo", () => getRepoHandle()?.move(1), false);
def("repos.prev", "Repository precedente", () => getRepoHandle()?.move(-1), false);
def("repos.pageDown", "Pagina giù", () => getRepoHandle()?.page(1), false);
def("repos.pageUp", "Pagina su", () => getRepoHandle()?.page(-1), false);
def("repos.activate", "Attiva il repository", () => getRepoHandle()?.activate(), false);
def("repos.openHere", "Apri il repository come cartella di lavoro", () => getRepoHandle()?.openHere(), false);
def("repos.focus", "Torna ai repository", () => {
  // only meaningful in a folder workspace; a no-op in a repository workspace
  if (!isFolderWs()) return;
  if (!ui.bottomVisible) setUi("bottomVisible", true);
  if (!focusRepos()) flash("Nessun repository in questa cartella");
}, false);
def("repos.refresh", "Cerca di nuovo i repository", () => {
  if (!isFolderWs()) return;
  void loadRepos(root(), true);
  invalidateRepoDirty();
  flash("Repository aggiornati");
}, false);

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
  const wt = await api.addWorktree(gitRoot(), name);
  closeOverlay();
  if (await openWorktree(wt.path, (p) => switchRoot(p))) flash(`Creato il worktree ${name} in ${wt.path}`);
}, false);
// ------------------------------------------------------------- deleting worktrees

const inWorktreePicker = () => ui.overlay?.kind === "picker" && ui.overlay.picker === "worktree";

/** From C-<delete> until the last worktree is gone (or the confirmation is declined). */
let deleteBusy = false;
function stillDeleting(): boolean {
  if (!deleteBusy) return false;
  const p = wtDeleting();
  flash(p ? `Eliminazione in corso (${p.done} di ${p.total})…` : "Eliminazione in corso…");
  return true;
}

/** Ctrl+arrow in the worktree picker: moves and selects, like Shift+arrows in a file manager. */
function markWorktrees(d: 1 | -1): void {
  const h = getPickerHandle();
  if (!h || !inWorktreePicker()) return;
  if (deleteBusy) return h.move(d);
  const from = h.index();
  h.move(d);
  const to = h.index();
  const rows = h.rows() as Worktree[];
  if (!rows.length) return;
  setWtMarks(extendMarks(wtMarks(), rows.map((w) => w.path), (i) => !cannotRemove(rows[i]), from, to));
  const why = rows[to] ? cannotRemove(rows[to]) : null;
  if (why) flash(why);
}

function toggleWorktreeMark(): void {
  const w = getPickerHandle()?.current() as Worktree | undefined;
  if (!w || !inWorktreePicker() || stillDeleting()) return;
  const why = cannotRemove(w);
  if (why) return flash(why, true);
  setWtMarks(toggleMark(wtMarks(), w.path));
}

const lost = (n: number) => (n === 1 ? "1 file modificato o nuovo: andrà perso" : `${n} file modificati o nuovi: andranno persi`);

/** Deletes the selected worktrees (or the highlighted one) after a confirmation. */
async function deleteWorktrees(): Promise<void> {
  if (stillDeleting()) return;
  deleteBusy = true;
  try {
    await confirmAndDelete();
  } finally {
    deleteBusy = false;
    setWtDeleting(null);
  }
}

async function confirmAndDelete(): Promise<void> {
  if (!inWorktreePicker()) {
    runCommand("worktree.pick");
    if (!inWorktreePicker()) return;
    const sel = keyFor(KEYMAPS[ui.mode], "worktree.markNext", ["picker:worktree"]);
    const del = keyFor(KEYMAPS[ui.mode], "worktree.delete", ["picker:worktree"]);
    return flash(`Seleziona i worktree con ${sel} e premi ${del} per eliminarli`);
  }
  let targets = (worktrees() ?? []).filter((w) => wtMarks().keys.has(w.path));
  if (!targets.length) {
    const cur = getPickerHandle()?.current() as Worktree | undefined;
    if (!cur) return flash("Nessun worktree da eliminare");
    const why = cannotRemove(cur);
    if (why) return flash(why, true);
    targets = [cur];
  }
  // fresh numbers: what each deletion would lose (null: unknown)
  const dirty = await Promise.all(
    targets.map((w) => (w.prunable ? Promise.resolve(0) : api.worktreeStatus(w.path, null).then((s) => s.dirty, () => null))),
  );
  const main = mainWorktree()?.path ?? null;
  const n = targets.length;
  const name = worktreeLabel(targets[0]);
  const ok = await askConfirm({
    title: n === 1 ? `Eliminare il worktree ${name}?` : `Eliminare ${n} worktree?`,
    items: targets.map((w, i) => {
      const d = dirty[i];
      return {
        label: worktreeLabel(w),
        detail: displayWorktreePath(w.path, main) + (w.prunable ? " (cartella già assente)" : ""),
        warn: d === null ? "Stato non disponibile: se ha modifiche non verrà eliminato" : d ? lost(d) : null,
      };
    }),
    note: "Le cartelle vengono cancellate dal disco. I branch restano nel repository.",
    confirmLabel: "Elimina",
  });
  if (!ok) return;
  const failed: string[] = [];
  for (const [i, w] of targets.entries()) {
    setWtDeleting({ done: i, total: n });
    flash(n === 1 ? `Elimino ${name}…` : `Elimino ${worktreeLabel(w)} (${i + 1} di ${n})…`);
    try {
      await api.removeWorktree(gitRoot(), w.path, (dirty[i] ?? 0) > 0);
      if (i < n - 1) void reloadWorktrees(); // rows go away one by one
    } catch (e) {
      failed.push(`${worktreeLabel(w)}: ${errorText(e)}`);
    }
  }
  setWtDeleting({ done: n, total: n });
  clearWtMarks();
  await reloadWorktrees();
  const done = n - failed.length;
  if (failed.length) flash(`${done ? `Eliminati ${done} di ${n}. ` : ""}Non eliminati: ${failed.join(" · ")}`, true);
  else flash(n === 1 ? `Eliminato il worktree ${name}` : `Eliminati ${n} worktree`);
}

def("worktree.markNext", "Seleziona e scendi", () => markWorktrees(1), false);
def("worktree.markPrev", "Seleziona e sali", () => markWorktrees(-1), false);
def("worktree.toggleMark", "Seleziona / deseleziona il worktree", () => toggleWorktreeMark(), false);
def("worktree.delete", "Elimina worktree", () => deleteWorktrees());
def("confirm.accept", "Conferma", () => resolveConfirm(true), false);

def("settings.open", "Impostazioni", () => openOverlay({ kind: "settings" }));
def("app.update", "Aggiorna ide-lite", () => runUpdate());
def("settings.next", "Controllo successivo", () => getSettingsHandle()?.move(1), false);
def("settings.prev", "Controllo precedente", () => getSettingsHandle()?.move(-1), false);
def("settings.activate", "Attiva", () => getSettingsHandle()?.activate(), false);
def("settings.pageDown", "Scorri le note giù", () => getSettingsHandle()?.scrollNotes(1), false);
def("settings.pageUp", "Scorri le note su", () => getSettingsHandle()?.scrollNotes(-1), false);
def("project.openHere", "Apri il repository come cartella di lavoro", () => {
  const it = getPickerHandle()?.current() as { kind: string; path?: string } | undefined;
  if (!it?.path || (it.kind !== "repo" && it.kind !== "recent")) return;
  closeOverlay();
  if (it.path === root()) return flash("È già il progetto aperto");
  void switchRoot(it.path);
}, false);
def("folder.enter","Entra nella cartella", () => getFolderHandle()?.enter(), false);
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
