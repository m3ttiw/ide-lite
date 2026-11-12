import { For, Show, batch, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack, type JSX } from "solid-js";
import { api, type FolderListing, type Worktree } from "../api";
import { defaultFolderIndex, folderAction, folderRows, parentPath, upAction, type FolderAction, type FolderResult, type FolderRow } from "../lib/folders";
import { defaultProjectIndex, isSelectableProject, projectRows, type ProjectItem, type ProjectResult } from "../lib/projects";
import { containerRepos } from "../state/projects";
import { allCommands, getCommand, runCommand } from "../core/commands";
import { activeContexts } from "../core/keyboard";
import { CONTEXT_TITLES, KEYMAPS, MODE_NAMES, keyFor } from "../core/keymaps";
import { fuzzyMatchPath, fuzzyMatchText, rank } from "../lib/fuzzy";
import { basename, dirname, displayWorktreePath } from "../lib/path";
import { activate, bufs, mruPaths, openFile } from "../state/buffers";
import { closeOverlay, getFolderHandle, getPickerHandle, pickerQuery, setFolderHandle, setHelpHandle, setPickerHandle, setPickerQuery } from "../state/focus";
import { switchRoot } from "../state/session";
import { errorText, flash, ui, type PickerKind } from "../state/ui";
import { generation, root } from "../state/workspace";
import { describeStatus, ensureWtStatus, needsWtStatus, loadingList, mainWorktree, worktrees, wtStatus } from "../state/worktrees";
import { Highlight, Kbd, keyOf } from "./common";
import { VirtualList, type VirtualListApi } from "./VirtualList";

interface Result<T> {
  item: T;
  positions: number[];
}

interface PickerSpec<T> {
  title: string;
  placeholder: string;
  rowHeight: number;
  items: () => T[] | null;
  filter: (q: string, items: T[]) => Result<T>[];
  render: (r: Result<T>, selected: () => boolean) => JSX.Element;
  accept: (r: Result<T> | undefined, q: string) => void;
  empty: (q: string) => JSX.Element;
  counter?: (shown: number, total: number) => string;
  onVisible?: (rows: Result<T>[]) => void;
  footer?: () => JSX.Element;
  /** Line under the input (e.g. the folder being browsed). */
  subtitle?: () => JSX.Element;
  /** Error shown in the overlay without closing it. */
  error?: () => string | null;
  /** Rows that cannot be selected (section headers). */
  selectable?: (item: T) => boolean;
  rowClass?: (item: T) => string;
  /** Row selected when the items or the filter change (default: the first). */
  defaultIndex?: (results: Result<T>[], q: string) => number;
  onInputKeyDown?: (e: KeyboardEvent & { currentTarget: HTMLInputElement }) => void;
}

const MAX_ROWS = 10;

/** The generic overlay: input, windowed results, footer. Keys arrive through the dispatcher. */
function Picker<T>(props: { spec: PickerSpec<T> }): JSX.Element {
  let input!: HTMLInputElement;
  let list: VirtualListApi | undefined;
  const [sel, setSel] = createSignal(0);
  const s = props.spec;
  const results = createMemo(() => {
    const items = s.items();
    return items ? s.filter(pickerQuery(), items) : [];
  });
  const ok = (i: number) => {
    const r = results()[i];
    return !!r && (!s.selectable || s.selectable(r.item));
  };
  /** Nearest selectable row from `i`, looking in direction `dir` first. */
  const fix = (i: number, dir: number) => {
    const n = results().length;
    for (let k = i; k >= 0 && k < n; k += dir) if (ok(k)) return k;
    for (let k = i; k >= 0 && k < n; k -= dir) if (ok(k)) return k;
    return Math.max(0, Math.min(n - 1, i));
  };
  const select = (i: number) => {
    setSel(i);
    if (list) list.scrollToIndex(i);
    else requestAnimationFrame(() => list?.scrollToIndex(i));
  };
  // the filter or the items changed: back to the default row
  createEffect(
    on([pickerQuery, () => s.items()], () => {
      const r = untrack(results);
      select(fix(s.defaultIndex ? s.defaultIndex(r, pickerQuery()) : 0, 1));
    }),
  );
  createEffect(on(results, (r) => sel() >= r.length && setSel(Math.max(0, r.length - 1)), { defer: true }));

  const move = (d: number) => {
    const n = results().length;
    if (!n) return;
    const i = Math.max(0, Math.min(n - 1, sel() + d));
    select(fix(i, d >= 0 ? 1 : -1));
  };
  const handle = {
    move,
    page: (dir: 1 | -1) => move(dir * (list?.pageRows() ?? MAX_ROWS)),
    accept: () => s.accept(results()[sel()], pickerQuery()),
    current: () => results()[sel()]?.item,
  };
  setPickerHandle(handle);
  // a picker replacing another one is created before the old one is disposed
  onCleanup(() => getPickerHandle() === handle && setPickerHandle(null));
  onMount(() => input.focus());

  const height = () => Math.min(results().length, MAX_ROWS) * s.rowHeight;
  const total = () => s.items()?.length ?? 0;

  return (
    <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && closeOverlay()}>
      <div class="picker" role="dialog" aria-modal="true" aria-label={s.title} data-ctx="picker">
        <div class="picker-head">
          <label for="picker-input" class="picker-title">
            {s.title}
          </label>
          <input
            ref={input}
            id="picker-input"
            type="text"
            autocomplete="off"
            spellcheck={false}
            placeholder={s.placeholder}
            value={pickerQuery()}
            onInput={(e) => setPickerQuery(e.currentTarget.value)}
            onKeyDown={(e) => s.onInputKeyDown?.(e)}
            role="combobox"
            aria-expanded="true"
            aria-controls="picker-list"
            aria-activedescendant={results().length ? `picker-row-${sel()}` : undefined}
          />
          <span class="picker-count">{s.items() === null ? "…" : (s.counter?.(results().length, total()) ?? `${results().length} di ${total()}`)}</span>
        </div>
        <Show when={s.subtitle}>
          <div class="picker-sub">{s.subtitle!()}</div>
        </Show>
        <Show when={s.error?.()}>
          {(err) => (
            <div class="picker-error" role="alert">
              {err()}
            </div>
          )}
        </Show>
        <Show when={s.items() !== null} fallback={<div class="picker-empty">Caricamento…</div>}>
          <Show when={results().length} fallback={<div class="picker-empty">{s.empty(pickerQuery())}</div>}>
            <div id="picker-list" role="listbox" aria-label={s.title}>
              <VirtualList
                count={results().length}
                rowHeight={s.rowHeight}
                style={{ height: `${height()}px` }}
                ref={(a) => (list = a)}
                onRange={(a, b) => s.onVisible?.(results().slice(a, b))}
                row={(i) => (
                  <Show when={results()[i]}>
                    {(r) => (
                      <div
                        id={`picker-row-${i}`}
                        role={!s.selectable || s.selectable(r().item) ? "option" : "presentation"}
                        aria-selected={sel() === i}
                        class={`picker-row ${s.rowClass?.(r().item) ?? ""}`}
                        classList={{ sel: sel() === i }}
                        onMouseMove={() => sel() !== i && ok(i) && setSel(i)}
                        onClick={() => ok(i) && s.accept(r(), pickerQuery())}
                      >
                        {s.render(r(), () => sel() === i)}
                      </div>
                    )}
                  </Show>
                )}
              />
            </div>
          </Show>
        </Show>
        <Show when={s.footer}>
          <div class="picker-foot">{s.footer!()}</div>
        </Show>
      </div>
    </div>
  );
}

/** Footer line made of real bindings for the given commands. */
function KeysFooter(props: { items: [string, string][] }): JSX.Element {
  const list = () =>
    props.items
      .map(([cmd, label]) => ({ k: keyFor(KEYMAPS[ui.mode], cmd, cmd === "app.cancel" ? ["global", ...activeContexts()] : activeContexts()), label }))
      .filter((x) => x.k);
  return (
    <For each={list()}>
      {(x) => (
        <span class="foot-item">
          <Kbd>{x.k}</Kbd> {x.label}
        </span>
      )}
    </For>
  );
}

// ------------------------------------------------------------- quick open

let filesCache: { root: string; files: string[] } | null = null;

function FilePicker(): JSX.Element {
  const [files, setFiles] = createSignal<string[] | null>(filesCache?.root === root() ? filesCache.files : null);
  const g = generation();
  const r = root();
  api
    .listFiles(r)
    .then((list) => {
      if (g !== generation()) return;
      filesCache = { root: r, files: list };
      setFiles(list);
    })
    .catch((e) => {
      setFiles([]);
      flash(`Elenco dei file non disponibile: ${errorText(e)}`, true);
    });
  return (
    <Picker
      spec={{
        title: "Apri file",
        placeholder: "nome o percorso…",
        rowHeight: 30,
        items: files,
        filter: (q, items) => rank(q, items, (p) => p, fuzzyMatchPath).map((x) => ({ item: x.item, positions: x.match.positions })),
        render: (res) => {
          const name = basename(res.item);
          const dir = dirname(res.item);
          const off = res.item.length - name.length;
          return (
            <>
              <span class="pk-name">
                <Highlight text={name} positions={res.positions} offset={off} />
              </span>
              <span class="pk-dir">
                <Highlight text={dir} positions={res.positions.filter((p) => p < dir.length)} />
              </span>
            </>
          );
        },
        accept: (res) => {
          if (!res) return;
          closeOverlay();
          void openFile(res.item, { focus: true });
        },
        empty: (q) => (q ? `Nessun file corrisponde a “${q}”.` : "Nessun file."),
        counter: (n, t) => `${n} di ${t}`,
        footer: () => <KeysFooter items={[["picker.next", "scorre"], ["picker.accept", "apri"], ["app.cancel", "annulla"]]} />,
      }}
    />
  );
}

// ------------------------------------------------------------- buffers

function BufferPicker(): JSX.Element {
  // most recent first, the current buffer last: RET jumps to the previous one
  const order = () => {
    const m = mruPaths();
    const cur = bufs.active;
    return cur ? [...m.filter((p) => p !== cur), cur] : m;
  };
  return (
    <Picker
      spec={{
        title: "Cambia buffer",
        placeholder: "nome del buffer…",
        rowHeight: 30,
        items: order,
        filter: (q, items) => rank(q, items, (p) => p, fuzzyMatchPath).map((x) => ({ item: x.item, positions: x.match.positions })),
        render: (res) => {
          const b = () => bufs.list.find((x) => x.path === res.item);
          const name = basename(res.item);
          return (
            <>
              <span class="pk-name">
                <Highlight text={name} positions={res.positions} offset={res.item.length - name.length} />
                <Show when={b()?.dirty}>
                  <span class="dirty"> ●</span>
                </Show>
              </span>
              <span class="pk-dir">{dirname(res.item)}</span>
              <Show when={bufs.active === res.item}>
                <span class="pk-right">attuale</span>
              </Show>
            </>
          );
        },
        accept: (res) => {
          if (!res) return;
          closeOverlay();
          activate(res.item);
          void openFile(res.item, { focus: true });
        },
        empty: () => "Nessun buffer corrisponde.",
        footer: () => <KeysFooter items={[["picker.next", "scorre"], ["picker.accept", "vai al buffer"], ["app.cancel", "annulla"]]} />,
      }}
    />
  );
}

// ------------------------------------------------------------- commands

function CommandPicker(): JSX.Element {
  const items = () => allCommands().filter((c) => c.palette);
  return (
    <Picker
      spec={{
        title: "Comandi",
        placeholder: "nome del comando…",
        rowHeight: 30,
        items,
        filter: (q, list) => rank(q, list, (c) => c.title, fuzzyMatchText).map((x) => ({ item: x.item, positions: x.match.positions })),
        render: (res) => (
          <>
            <span class="pk-name">
              <Highlight text={res.item.title} positions={res.positions} />
            </span>
            <Show when={keyOf(res.item.id)}>
              {(k) => (
                <span class="pk-right">
                  <Kbd>{k()}</Kbd>
                </span>
              )}
            </Show>
          </>
        ),
        accept: (res) => {
          if (!res) return;
          closeOverlay();
          runCommand(res.item.id);
        },
        empty: () => "Nessun comando corrisponde.",
        footer: () => <KeysFooter items={[["picker.next", "scorre"], ["picker.accept", "esegui"], ["app.cancel", "annulla"]]} />,
      }}
    />
  );
}

// ------------------------------------------------------------- worktrees

function WorktreePicker(): JSX.Element {
  const ordered = createMemo(() => {
    const list = worktrees();
    if (!list) return loadingList() ? null : [];
    const cur = list.filter((w) => w.path === root());
    const main = list.filter((w) => w.isMain && w.path !== root());
    const rest = list.filter((w) => !w.isMain && w.path !== root());
    return [...cur, ...main, ...rest];
  });
  const label = (w: Worktree) => w.branch ?? `(staccato) ${w.head.slice(0, 7)}`;
  const mainPath = () => mainWorktree()?.path ?? null;
  return (
    <Picker
      spec={{
        title: "Vai al worktree",
        placeholder: "branch o cartella…",
        rowHeight: 46,
        items: ordered,
        filter: (q, list) => {
          const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
          const out: Result<Worktree>[] = [];
          for (const w of list) {
            const hay = `${label(w)} ${w.path}`.toLowerCase();
            if (tokens.every((t) => hay.includes(t))) out.push({ item: w, positions: [] });
          }
          return out;
        },
        render: (res) => {
          const w = res.item;
          const isCur = w.path === root();
          // only rows that are rendered (on screen, plus a few) ask for their numbers
          createEffect(() => {
            if (needsWtStatus(w.path)) ensureWtStatus(w.path);
          });
          return (
            <>
              <span class="dot" classList={{ current: isCur }} aria-hidden="true" />
              <span class="wt-text">
                <span class="wt-branch">{label(w)}</span>
                <span class="wt-path">{displayWorktreePath(w.path, mainPath())}</span>
              </span>
              <span class="pk-right">{describeStatus(w, wtStatus(w.path), isCur)}</span>
            </>
          );
        },
        accept: (res, q) => {
          if (!res) {
            const k = keyOf("worktree.create", ["picker:worktree"]);
            if (q.trim() && k) flash(`Nessun worktree “${q.trim()}”: ${k} lo crea`);
            return;
          }
          closeOverlay();
          if (res.item.path === root()) return flash("Sei già in questo worktree");
          void switchRoot(res.item.path);
        },
        empty: (q) => {
          const k = keyOf("worktree.create", ["picker:worktree"]);
          return q.trim() ? (
            <>
              Nessun worktree corrisponde.{" "}
              <Show when={k}>
                <Kbd>{k}</Kbd> ne crea uno con questo nome.
              </Show>
            </>
          ) : (
            "Nessun worktree."
          );
        },
        counter: (n, t) => `${n} di ${t}`,
        footer: () => <KeysFooter items={[["picker.next", "scorre"], ["picker.accept", "apri"], ["worktree.create", "nuovo worktree"], ["app.cancel", "annulla"]]} />,
      }}
    />
  );
}

// ------------------------------------------------------------- folder browser (C-x d)

function FolderPicker(): JSX.Element {
  const [listing, setListing] = createSignal<FolderListing | null>(null);
  const [highlight, setHighlight] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  let seq = 0;

  const go = (path: string, hl?: string | null) => {
    const n = ++seq;
    setLoading(true);
    api
      .browseDir(path)
      .then((l) => {
        if (n !== seq) return;
        batch(() => {
          setPickerQuery("");
          setError(null);
          setHighlight(hl ?? null);
          setListing(l);
        });
      })
      .catch((e) => {
        if (n !== seq) return;
        setError(`${path || "Radici"}: ${errorText(e)}`);
        if (!listing()) go("", path); // nothing on screen yet: start from the roots
      })
      .finally(() => n === seq && setLoading(false));
  };

  const open = (path: string) => {
    closeOverlay();
    if (path === root()) return flash("È già la cartella aperta");
    void switchRoot(path);
  };
  const act = (a: FolderAction) => {
    if (!a) return;
    if (a.type === "enter") go(a.path, a.highlight);
    else open(a.path);
  };
  const cur = () => getPickerHandle()?.current() as FolderRow | undefined;
  const up = () => {
    const l = listing();
    if (l) act(upAction(l));
  };
  const fh = {
    enter: () => act(folderAction(cur(), "enter")),
    up,
    openHere: () => act(folderAction(cur(), "open")),
  };
  setFolderHandle(fh);
  onCleanup(() => getFolderHandle() === fh && setFolderHandle(null));
  // an error stays until the next navigation or the next edit of the filter
  createEffect(on(pickerQuery, () => setError(null), { defer: true }));

  // starts in the parent of the workspace, with the workspace highlighted
  const r = root();
  go(r ? parentPath(r) : "", r || null);

  const items = createMemo((): FolderRow[] | null => {
    const l = listing();
    return l ? folderRows(l, "").map((x) => x.item) : null;
  });

  return (
    <Picker<FolderRow>
      spec={{
        title: "Sfoglia cartelle",
        placeholder: "filtra le cartelle…",
        rowHeight: 30,
        items,
        filter: (q) => (listing() ? folderRows(listing()!, q) : []),
        defaultIndex: (res, q) => defaultFolderIndex(res as FolderResult[], q ? null : highlight()),
        subtitle: () => (
          <span class="fb-path" title={listing()?.path}>
            {listing() ? listing()!.path || "Unità disponibili" : "…"}
            <Show when={loading()}>
              <span class="muted"> · caricamento…</span>
            </Show>
          </span>
        ),
        error,
        render: (res) => {
          const it = res.item;
          if (it.kind === "self")
            return (
              <>
                <span class="pk-name">./</span>
                <span class="pk-dir">apri questa cartella</span>
              </>
            );
          return (
            <>
              <span class="pk-name">
                <Highlight text={it.entry.name} positions={res.positions} />
                {"/"}
              </span>
              <Show when={it.entry.isRepo}>
                <span class="git-badge">git</span>
                <span class="pk-dir">{it.entry.branch ?? "HEAD staccato"}</span>
              </Show>
              <Show when={it.entry.path === root()}>
                <span class="pk-right">attuale</span>
              </Show>
            </>
          );
        },
        accept: (res) => act(folderAction(res?.item, "accept")),
        onInputKeyDown: (e) => {
          if (e.key === "Backspace" && !e.ctrlKey && !e.altKey && e.currentTarget.value === "") {
            e.preventDefault();
            up();
          }
        },
        empty: (q) => (q ? `Nessuna cartella corrisponde a “${q}”.` : "Nessuna sottocartella."),
        counter: () => {
          const l = listing();
          return l ? `${l.dirs.length} cartelle` : "…";
        },
        footer: () => (
          <KeysFooter
            items={[
              ["picker.accept", "apri/entra"],
              ["folder.enter", "entra"],
              ["folder.up", "su"],
              ["folder.openHere", "apri questa"],
              ["app.cancel", "chiudi"],
            ]}
          />
        ),
      }}
    />
  );
}

// ------------------------------------------------------------- projects (C-x p)

function ProjectPicker(): JSX.Element {
  const src = () => ({ container: ui.container, repos: containerRepos(), recents: ui.recents });
  const searching = () => !!ui.container && containerRepos() === null;
  const withSearching = (rows: ProjectResult[]): ProjectResult[] =>
    searching() ? [{ item: { kind: "head", label: `Repository in ${ui.container} · ricerca…` }, positions: [] }, ...rows] : rows;
  const items = createMemo(() => withSearching(projectRows(src(), "")).map((r) => r.item));
  return (
    <Picker<ProjectItem>
      spec={{
        title: "Cambia progetto",
        placeholder: "repository o cartella recente…",
        rowHeight: 30,
        items,
        filter: (q) => withSearching(projectRows(src(), q)),
        selectable: isSelectableProject,
        rowClass: (it) => (it.kind === "head" ? "pk-section" : ""),
        defaultIndex: (res, q) => defaultProjectIndex(res as ProjectResult[], q, root()),
        render: (res) => {
          const it = res.item;
          switch (it.kind) {
            case "head":
              return <span class="pk-head">{it.label}</span>;
            case "action":
              return (
                <>
                  <span class="pk-name">Sfoglia cartelle…</span>
                  <Show when={keyOf("folder.browse")}>
                    {(k) => (
                      <span class="pk-right">
                        <Kbd>{k()}</Kbd>
                      </span>
                    )}
                  </Show>
                </>
              );
            case "repo":
              return (
                <>
                  <span class="pk-name">
                    <Highlight text={it.label} positions={res.positions} />
                  </span>
                  <span class="pk-dir">
                    {it.branch ?? "HEAD staccato"}
                    {it.linked ? " · worktree collegato" : ""}
                  </span>
                  <Show when={it.path === root()}>
                    <span class="pk-right">attuale</span>
                  </Show>
                </>
              );
            case "recent": {
              const name = basename(it.path) || it.path;
              const dir = dirname(it.path);
              return (
                <>
                  <span class="pk-name">
                    <Highlight text={name} positions={res.positions} offset={it.path.length - name.length} />
                  </span>
                  <span class="pk-dir">
                    <Highlight text={dir} positions={res.positions.filter((p) => p < dir.length)} />
                  </span>
                  <Show when={it.path === root()}>
                    <span class="pk-right">attuale</span>
                  </Show>
                </>
              );
            }
          }
        },
        accept: (res) => {
          const it = res?.item;
          if (!it || it.kind === "head") return;
          if (it.kind === "action") return runCommand("folder.browse");
          closeOverlay();
          if (it.path === root()) return flash("È già il progetto aperto");
          void switchRoot(it.path);
        },
        empty: () => "Nessun progetto corrisponde.",
        counter: () => {
          const n = containerRepos()?.length;
          return ui.container ? `${n ?? "…"} repository · ${ui.recents.length} recenti` : `${ui.recents.length} recenti`;
        },
        footer: () => <KeysFooter items={[["picker.next", "scorre"], ["picker.accept", "apri"], ["folder.browse", "sfoglia cartelle"], ["app.cancel", "annulla"]]} />,
      }}
    />
  );
}

export function PickerOverlay(props: { kind: PickerKind }): JSX.Element {
  return (
    <>
      <Show when={props.kind === "folder"}>
        <FolderPicker />
      </Show>
      <Show when={props.kind === "project"}>
        <ProjectPicker />
      </Show>
      <Show when={props.kind === "file"}>
        <FilePicker />
      </Show>
      <Show when={props.kind === "buffer"}>
        <BufferPicker />
      </Show>
      <Show when={props.kind === "command"}>
        <CommandPicker />
      </Show>
      <Show when={props.kind === "worktree"}>
        <WorktreePicker />
      </Show>
    </>
  );
}

// ------------------------------------------------------------- C-h

const HELP_ORDER = ["global", "editor", "tree", "history", "changes", "diff", "picker", "picker:worktree", "picker:folder", "picker:project", "settings", "help"];

export function HelpOverlay(): JSX.Element {
  let box!: HTMLDivElement;
  const groups = createMemo(() => {
    const bindings = KEYMAPS[ui.mode];
    return HELP_ORDER.map((ctx) => {
      const byCmd = new Map<string, string[]>();
      for (const b of bindings) if (b.context === ctx) byCmd.set(b.command, [...(byCmd.get(b.command) ?? []), b.keys]);
      return { ctx, title: CONTEXT_TITLES[ctx] ?? ctx, rows: [...byCmd].map(([cmd, keys]) => ({ keys, title: getCommand(cmd)?.title ?? cmd })) };
    }).filter((g) => g.rows.length);
  });
  setHelpHandle({ scroll: (px) => box.scrollBy({ top: px }), page: (d) => box.scrollBy({ top: d * (box.clientHeight - 40) }) });
  onCleanup(() => setHelpHandle(null));
  onMount(() => box.focus());
  return (
    <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && closeOverlay()}>
      <div class="help" role="dialog" aria-modal="true" aria-label="Tutte le scorciatoie" data-ctx="help">
        <div class="help-head">
          <span class="picker-title">Scorciatoie · {MODE_NAMES[ui.mode]}</span>
          <button type="button" class="link-btn" onClick={() => runCommand("keymap.toggle")}>
            passa a {MODE_NAMES[ui.mode === "emacs" ? "standard" : "emacs"]}
          </button>
        </div>
        <div class="help-body focusable" tabindex="-1" ref={box}>
          <For each={groups()}>
            {(g) => (
              <section class="help-group">
                <h2>{g.title}</h2>
                <For each={g.rows}>
                  {(r) => (
                    <div class="help-row">
                      <span class="help-keys">
                        <For each={r.keys}>{(k) => <Kbd>{k}</Kbd>}</For>
                      </span>
                      <span>{r.title}</span>
                    </div>
                  )}
                </For>
              </section>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
