import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { api, type Worktree } from "../api";
import { allCommands, getCommand, runCommand } from "../core/commands";
import { activeContexts } from "../core/keyboard";
import { CONTEXT_TITLES, KEYMAPS, MODE_NAMES, keyFor } from "../core/keymaps";
import { fuzzyMatchPath, fuzzyMatchText, rank } from "../lib/fuzzy";
import { basename, dirname, displayWorktreePath } from "../lib/path";
import { activate, bufs, mruPaths, openFile } from "../state/buffers";
import { closeOverlay, pickerQuery, setHelpHandle, setPickerHandle, setPickerQuery } from "../state/focus";
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
  createEffect(on(pickerQuery, () => setSel(0), { defer: true }));
  createEffect(on(results, (r) => sel() >= r.length && setSel(Math.max(0, r.length - 1)), { defer: true }));

  const move = (d: number) => {
    const n = results().length;
    if (!n) return;
    const i = Math.max(0, Math.min(n - 1, sel() + d));
    setSel(i);
    list?.scrollToIndex(i);
  };
  setPickerHandle({
    move,
    page: (dir) => move(dir * (list?.pageRows() ?? MAX_ROWS)),
    accept: () => s.accept(results()[sel()], pickerQuery()),
  });
  onCleanup(() => setPickerHandle(null));
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
            role="combobox"
            aria-expanded="true"
            aria-controls="picker-list"
            aria-activedescendant={results().length ? `picker-row-${sel()}` : undefined}
          />
          <span class="picker-count">{s.items() === null ? "…" : (s.counter?.(results().length, total()) ?? `${results().length} di ${total()}`)}</span>
        </div>
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
                        role="option"
                        aria-selected={sel() === i}
                        class="picker-row"
                        classList={{ sel: sel() === i }}
                        onMouseMove={() => sel() !== i && setSel(i)}
                        onClick={() => s.accept(r(), pickerQuery())}
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

export function PickerOverlay(props: { kind: PickerKind }): JSX.Element {
  return (
    <>
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

const HELP_ORDER = ["global", "editor", "tree", "history", "changes", "diff", "picker", "picker:worktree", "help"];

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
