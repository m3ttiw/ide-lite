import { Match, Show, Switch, createEffect, createMemo, createSignal, on, type JSX } from "solid-js";
import type { DiffLine } from "../api";
import { diffHandles, setActiveDiff, type DiffHandle } from "../state/focus";
import type { DiffEntry } from "../state/git";
import { STATUS_CLASS } from "./common";
import { VirtualList, type VirtualListApi } from "./VirtualList";

const ROW = 21;

type Row =
  | { t: "file"; e: DiffEntry; fi: number }
  | { t: "hunk"; text: string }
  | { t: "line"; l: DiffLine }
  | { t: "note"; text: string; cls?: string };

interface Props {
  name: "history" | "changes" | "review";
  entries: () => DiffEntry[];
  onToggle: (path: string) => void;
  onBack: () => void;
  label: string;
  empty?: JSX.Element;
}

/** Unified diff of one or more files, flattened into one windowed list. */
export function DiffView(props: Props): JSX.Element {
  let list: VirtualListApi | undefined;
  let el!: HTMLDivElement;
  const [cur, setCur] = createSignal(0);

  const rows = createMemo((): Row[] => {
    const out: Row[] = [];
    props.entries().forEach((e, fi) => {
      out.push({ t: "file", e, fi });
      if (!e.open) return;
      if (e.banner) out.push({ t: "note", text: e.banner, cls: "banner" });
      if (e.loading) return out.push({ t: "note", text: "Caricamento del diff…" });
      if (e.error) return out.push({ t: "note", text: `Diff non disponibile: ${e.error}`, cls: "error" });
      const d = e.diff;
      if (!d) return;
      if (d.binary) return out.push({ t: "note", text: "File binario: il contenuto non viene confrontato." });
      if (!d.hunks.length) out.push({ t: "note", text: e.status === "R" ? "Solo rinominato: nessuna modifica al contenuto." : "Nessuna modifica di testo." });
      for (const h of d.hunks) {
        out.push({ t: "hunk", text: h.header });
        for (const l of h.lines) out.push({ t: "line", l });
      }
      if (d.truncated) out.push({ t: "note", text: "Diff troppo lungo: è stato troncato dal backend (20 000 righe).", cls: "warn" });
    });
    return out;
  });

  // a new commit / file selection starts from the first file, scrolled to top
  createEffect(
    on(
      () => props.entries()[0]?.key,
      () => {
        setCur(0);
        list?.scrollToIndex(0, "start");
      },
    ),
  );

  const headerIndex = (fi: number) => rows().findIndex((r) => r.t === "file" && r.fi === fi);

  const goFile = (fi: number) => {
    const n = props.entries().length;
    if (!n) return;
    const f = Math.max(0, Math.min(n - 1, fi));
    setCur(f);
    const i = headerIndex(f);
    if (i >= 0) list?.scrollToIndex(i, "start");
  };

  const handle: DiffHandle = {
    nextFile: () => goFile(cur() + 1),
    prevFile: () => goFile(cur() - 1),
    toggleFile: () => {
      const e = props.entries()[cur()];
      if (e) props.onToggle(e.path);
    },
    back: () => props.onBack(),
    scroll: (n) => list?.scrollBy(n * ROW),
    page: (dir) => list?.scrollBy(dir * (list?.pageRows() ?? 10) * ROW),
    focus: () => el.focus(),
    currentPath: () => props.entries()[cur()]?.path ?? props.entries()[0]?.path ?? null,
  };
  diffHandles[props.name] = handle;

  const LineRow = (p: { l: DiffLine }) => (
    <div class={`d-line ${p.l.kind}`}>
      <span class="ln">{p.l.oldNo ?? ""}</span>
      <span class="ln">{p.l.newNo ?? ""}</span>
      <span class="mk">{p.l.kind === "add" ? "+" : p.l.kind === "del" ? "−" : ""}</span>
      <span class="code">{p.l.text}</span>
    </div>
  );

  const RowView = (p: { i: number }) => {
    const r = () => rows()[p.i];
    return (
      <Show when={r()}>
        {(row) => (
          <Switch>
            <Match when={row().t === "file" && (row() as Extract<Row, { t: "file" }>)}>
              {(f) => (
                <div
                  class="d-file"
                  classList={{ cur: cur() === f().fi }}
                  onClick={() => {
                    setCur(f().fi);
                    props.onToggle(f().e.path);
                  }}
                  title={f().e.path}
                >
                  <span class="caret">{f().e.open ? "▾" : "▸"}</span>
                  <span class={`badge ${STATUS_CLASS[f().e.status] ?? ""}`}>{f().e.status}</span>
                  <span class="d-path">{f().e.origPath && f().e.origPath !== f().e.path ? `${f().e.origPath} → ${f().e.path}` : f().e.path}</span>
                  <Show when={f().e.binary} fallback={
                    <>
                      <Show when={f().e.additions !== null && f().e.additions! > 0}>
                        <span class="add">+{f().e.additions}</span>
                      </Show>
                      <Show when={f().e.deletions !== null && f().e.deletions! > 0}>
                        <span class="del">−{f().e.deletions}</span>
                      </Show>
                    </>
                  }>
                    <span class="muted">binario</span>
                  </Show>
                </div>
              )}
            </Match>
            <Match when={row().t === "hunk" && (row() as Extract<Row, { t: "hunk" }>)}>{(h) => <div class="d-hunk">{h().text}</div>}</Match>
            <Match when={row().t === "line" && (row() as Extract<Row, { t: "line" }>)}>{(l) => <LineRow l={l().l} />}</Match>
            <Match when={row().t === "note" && (row() as Extract<Row, { t: "note" }>)}>
              {(n) => <div class={`d-note ${n().cls ?? ""}`}>{n().text}</div>}
            </Match>
          </Switch>
        )}
      </Show>
    );
  };

  return (
    <div
      ref={el}
      class="diff focusable"
      tabindex="0"
      data-ctx="diff"
      aria-label={props.label}
      onFocus={() => setActiveDiff(handle)}
    >
      <Show when={rows().length} fallback={props.empty}>
        <VirtualList count={rows().length} rowHeight={ROW} overscan={10} row={(i) => <RowView i={i} />} ref={(a) => (list = a)} />
      </Show>
    </div>
  );
}
