import type { Binding } from "../lib/keys";

export type Mode = "emacs" | "standard";

/** Focus contexts, most specific first when resolving keys. */
export const CONTEXT_TITLES: Record<string, string> = {
  global: "Generale",
  editor: "Editor",
  tree: "File",
  history: "Cronologia",
  changes: "Modifiche",
  diff: "Diff",
  picker: "Selettori",
  "picker:worktree": "Selettore worktree",
  "picker:folder": "Sfoglia cartelle",
  "picker:project": "Cambia progetto",
  settings: "Impostazioni",
  help: "Scorciatoie",
};

const t = (context: string, list: [string, string][]): Binding[] =>
  list.map(([keys, command]) => ({ keys, command, context }));

const pickerCommon = (mode: Mode): Binding[] => [
  ...t("picker", [
    ...(mode === "emacs" ? ([["C-n", "picker.next"], ["C-p", "picker.prev"]] as [string, string][]) : []),
    ["<down>", "picker.next"],
    ["<up>", "picker.prev"],
    ["<next>", "picker.pageDown"],
    ["<prior>", "picker.pageUp"],
    ["RET", "picker.accept"],
    ["ESC", "app.cancel"],
  ]),
  ...t("picker:worktree", [["M-n", "worktree.create"]]),
  ...t("picker:folder", [
    ["TAB", "folder.enter"],
    ["<right>", "folder.enter"],
    ["<left>", "folder.up"],
    ...(mode === "emacs" ? ([["C-l", "folder.up"]] as [string, string][]) : []),
    ["C-RET", "folder.openHere"],
  ]),
  ...t("settings", [
    ...(mode === "emacs" ? ([["C-n", "settings.next"], ["C-p", "settings.prev"]] as [string, string][]) : []),
    ["<down>", "settings.next"],
    ["<up>", "settings.prev"],
    ["RET", "settings.activate"],
    ["SPC", "settings.activate"],
    ["<next>", "settings.pageDown"],
    ["<prior>", "settings.pageUp"],
    ["q", "app.cancel"],
    ["ESC", "app.cancel"],
  ]),
  ...t("help", [
    ...(mode === "emacs" ? ([["C-n", "help.down"], ["C-p", "help.up"], ["C-v", "help.pageDown"], ["M-v", "help.pageUp"]] as [string, string][]) : []),
    ["<down>", "help.down"],
    ["<up>", "help.up"],
    ["<next>", "help.pageDown"],
    ["<prior>", "help.pageUp"],
    ["q", "app.cancel"],
    ["ESC", "app.cancel"],
  ]),
];

const listKeys = (ctx: string, mode: Mode): Binding[] =>
  t(ctx, [
    ["n", "list.next"],
    ["p", "list.prev"],
    ...(mode === "emacs" ? ([["C-n", "list.next"], ["C-p", "list.prev"]] as [string, string][]) : []),
    ["<down>", "list.next"],
    ["<up>", "list.prev"],
    ["RET", "list.toDiff"],
    ["g", "git.refresh"],
  ]);

const diffKeys = (mode: Mode): Binding[] =>
  t("diff", [
    ["n", "diff.nextFile"],
    ["p", "diff.prevFile"],
    ["RET", "diff.toggleFile"],
    ["TAB", "diff.toggleFile"],
    ["q", "diff.back"],
    ...(mode === "emacs"
      ? ([["C-n", "diff.down"], ["C-p", "diff.up"], ["C-v", "diff.pageDown"], ["M-v", "diff.pageUp"], ["<left>", "diff.back"]] as [string, string][])
      : ([["ESC", "diff.back"]] as [string, string][])),
    ["<down>", "diff.down"],
    ["<up>", "diff.up"],
    ["<next>", "diff.pageDown"],
    ["<prior>", "diff.pageUp"],
  ]);

const EMACS: Binding[] = [
  ...t("global", [
    ["C-x C-f", "file.quickOpen"],
    ["C-x C-s", "file.save"],
    ["C-x b", "buffer.switch"],
    ["C-x k", "buffer.close"],
    ["C-x o", "focus.next"],
    ["C-x g", "git.history"],
    ["C-x m", "git.changes"],
    ["C-x w", "worktree.pick"],
    ["C-x d", "folder.browse"],
    ["C-x p", "project.pick"],
    ["C-,", "settings.open"],
    ["C-x 1", "panel.toggleBottom"],
    ["C-x C-c", "app.quit"],
    ["M-x", "palette.open"],
    ["C-h", "help.open"],
    ["C-g", "app.cancel"],
  ]),
  ...t("editor", [
    ["C-f", "editor.charForward"],
    ["C-b", "editor.charBackward"],
    ["C-n", "editor.lineDown"],
    ["C-p", "editor.lineUp"],
    ["C-a", "editor.lineStart"],
    ["C-e", "editor.lineEnd"],
    ["M-f", "editor.wordForward"],
    ["M-b", "editor.wordBackward"],
    ["C-d", "editor.deleteChar"],
    ["C-k", "editor.killLine"],
    ["C-w", "editor.killRegion"],
    ["M-w", "editor.copyRegion"],
    ["C-y", "editor.yank"],
    ["M-y", "editor.yankPop"],
    ["C-SPC", "editor.setMark"],
    ["C-/", "editor.undo"],
    ["C-_", "editor.undo"],
    ["C-S-z", "editor.redo"],
    ["M-<", "editor.docStart"],
    ["M->", "editor.docEnd"],
    ["C-v", "editor.pageDown"],
    ["M-v", "editor.pageUp"],
    ["C-s", "editor.search"],
    ["C-r", "editor.searchBack"],
    ["M-;", "editor.toggleComment"],
  ]),
  ...t("tree", [
    ["C-n", "tree.next"],
    ["<down>", "tree.next"],
    ["C-p", "tree.prev"],
    ["<up>", "tree.prev"],
    ["RET", "tree.open"],
    ["<right>", "tree.expand"],
    ["<left>", "tree.collapse"],
    ["M-<", "tree.first"],
    ["M->", "tree.last"],
    ["g", "tree.refresh"],
  ]),
  ...listKeys("history", "emacs"),
  ...listKeys("changes", "emacs"),
  ...diffKeys("emacs"),
  ...pickerCommon("emacs"),
];

const STANDARD: Binding[] = [
  ...t("global", [
    ["C-p", "file.quickOpen"],
    ["C-s", "file.save"],
    ["C-w", "buffer.close"],
    ["C-TAB", "buffer.switch"],
    ["C-S-p", "palette.open"],
    ["<f1>", "palette.open"],
    ["C-S-g", "git.history"],
    ["C-S-w", "worktree.pick"],
    ["C-o", "folder.browse"],
    ["C-r", "project.pick"],
    ["C-,", "settings.open"],
    ["C-b", "sidebar.toggle"],
    ["C-j", "panel.toggleBottom"],
    ["<f6>", "focus.next"],
    ["C-k C-s", "help.open"],
    ["C-q", "app.quit"],
    ["ESC", "app.cancel"],
    ["C-g", "app.cancel"],
  ]),
  ...t("editor", [
    ["C-f", "editor.search"],
    ["<f3>", "editor.search"],
    ["S-<f3>", "editor.searchBack"],
    ["C-z", "editor.undo"],
    ["C-y", "editor.redo"],
    ["C-S-z", "editor.redo"],
    ["C-/", "editor.toggleComment"],
    ["C-a", "editor.selectAll"],
  ]),
  ...t("tree", [
    ["<down>", "tree.next"],
    ["<up>", "tree.prev"],
    ["RET", "tree.open"],
    ["<right>", "tree.expand"],
    ["<left>", "tree.collapse"],
    ["<home>", "tree.first"],
    ["<end>", "tree.last"],
  ]),
  ...listKeys("history", "standard"),
  ...listKeys("changes", "standard"),
  ...diffKeys("standard"),
  ...pickerCommon("standard"),
];

export const KEYMAPS: Record<Mode, Binding[]> = { emacs: EMACS, standard: STANDARD };

export const MODE_NAMES: Record<Mode, string> = { emacs: "Emacs", standard: "Standard" };

/** A hint groups one or more commands under a short label. */
export interface HintSpec {
  cmds: string[];
  label: string;
}

const h = (label: string, ...cmds: string[]): HintSpec => ({ cmds, label });

/** Curated hints per context; keys are always looked up in the active keymap. */
export const HINTS: Record<string, HintSpec[]> = {
  editor: [
    h("cerca", "editor.search"),
    h("salva", "file.save"),
    h("apri file", "file.quickOpen"),
    h("cambia buffer", "buffer.switch"),
    h("altro pannello", "focus.next"),
    h("cronologia", "git.history"),
    h("worktree", "worktree.pick"),
  ],
  tree: [
    h("scorre", "tree.next", "tree.prev"),
    h("apri", "tree.open"),
    h("chiudi cartella", "tree.collapse"),
    h("apri file", "file.quickOpen"),
    h("altro pannello", "focus.next"),
    h("worktree", "worktree.pick"),
    h("progetto", "project.pick"),
    h("cartelle", "folder.browse"),
  ],
  history: [
    h("scorre", "list.next", "list.prev"),
    h("vai al diff", "list.toDiff"),
    h("modifiche", "git.changes"),
    h("aggiorna", "git.refresh"),
    h("altro pannello", "focus.next"),
    h("pannello", "panel.toggleBottom"),
  ],
  changes: [
    h("scorre", "list.next", "list.prev"),
    h("vai al diff", "list.toDiff"),
    h("cronologia", "git.history"),
    h("aggiorna", "git.refresh"),
    h("altro pannello", "focus.next"),
  ],
  diff: [
    h("file succ./prec.", "diff.nextFile", "diff.prevFile"),
    h("apri/chiudi file", "diff.toggleFile"),
    h("torna all'elenco", "diff.back"),
    h("altro pannello", "focus.next"),
  ],
  picker: [h("scorre", "picker.next", "picker.prev"), h("apri", "picker.accept")],
  "picker:worktree": [h("scorre", "picker.next", "picker.prev"), h("apri", "picker.accept"), h("nuovo worktree", "worktree.create")],
  "picker:folder": [
    h("scorre", "picker.next", "picker.prev"),
    h("apri/entra", "picker.accept"),
    h("entra", "folder.enter"),
    h("su", "folder.up"),
    h("apri questa", "folder.openHere"),
  ],
  "picker:project": [h("scorre", "picker.next", "picker.prev"), h("apri", "picker.accept"), h("sfoglia cartelle", "folder.browse")],
  help: [h("scorre", "help.down", "help.up"), h("chiudi", "app.cancel")],
  settings: [h("scorre", "settings.next", "settings.prev"), h("attiva", "settings.activate")],
  global: [
    h("apri file", "file.quickOpen"),
    h("comandi", "palette.open"),
    h("progetto", "project.pick"),
    h("cartelle", "folder.browse"),
    h("worktree", "worktree.pick"),
    h("altro pannello", "focus.next"),
  ],
};

/** First binding of `command` reachable from the given contexts. */
export function keyFor(bindings: Binding[], command: string, contexts: string[]): string | null {
  for (const ctx of contexts) {
    const b = bindings.find((x) => x.context === ctx && x.command === command);
    if (b) return b.keys;
  }
  return null;
}
