import { MergeView, getChunks } from "@codemirror/merge";
import { syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, highlightSpecialChars, lineNumbers } from "@codemirror/view";
import { For, Show, createEffect, on, onCleanup, onMount, type JSX } from "solid-js";
import { editorHighlight, editorTheme } from "../editor/cm";
import { languageExtension } from "../editor/languages";
import { langOf } from "../lib/lang";
import { basename, dirname } from "../lib/path";
import { closeCompare, compare, compareMove, compareSelect, compareSwap, compareTexts, compareWhole, setCompareWhole } from "../state/compare";
import { setCompareHandle } from "../state/focus";
import { flash } from "../state/ui";
import { Kbd, STATUS_CLASS, keyOf } from "./common";

const compareTheme = EditorView.theme(
  {
    "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": { backgroundColor: "rgba(240, 144, 144, 0.11)" },
    "&.cm-merge-b .cm-changedLine": { backgroundColor: "rgba(127, 209, 139, 0.11)" },
    "&.cm-merge-a .cm-changedText": { background: "rgba(240, 144, 144, 0.32)" },
    "&.cm-merge-b .cm-changedText": { background: "rgba(127, 209, 139, 0.3)" },
    "&.cm-merge-a .cm-changedLineGutter": { background: "#f09090" },
    "&.cm-merge-b .cm-changedLineGutter": { background: "#7fd18b" },
    ".cm-collapsedLines": { color: "#9aa0aa", background: "#1e2126", fontFamily: "var(--ui)", fontSize: "12px", padding: "3px 10px" },
    ".cm-content": { padding: "4px 0" },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
  },
  { dark: true },
);

const phrases = EditorState.phrases.of({ "$ unchanged lines": "$ righe uguali" });

function extensions(lang: Extension | null): Extension {
  return [
    lineNumbers(),
    highlightSpecialChars(),
    syntaxHighlighting(editorHighlight),
    editorTheme,
    compareTheme,
    phrases,
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorState.tabSize.of(4),
    lang ?? [],
  ];
}

const LETTER = (s: string) => (s === "?" ? "A" : s);

const KIND_NOTE: Record<string, string> = {
  binary: "file binario: il contenuto non viene confrontato",
  tooLarge: "più grande di 5 MB: non viene caricato",
};

export function CompareScreen(): JSX.Element {
  let host!: HTMLDivElement;
  let section!: HTMLElement;
  let list!: HTMLDivElement;
  let view: MergeView | null = null;
  let chunk = -1;

  const destroy = () => {
    view?.destroy();
    view = null;
    chunk = -1;
  };

  createEffect(
    on([compareTexts, compareWhole], async ([t, whole]) => {
      destroy();
      if (!t?.left || !t.right || t.error) return;
      if (KIND_NOTE[t.left.kind] || KIND_NOTE[t.right.kind]) return;
      const lang = await languageExtension(langOf(t.path));
      if (compareTexts() !== t || compareWhole() !== whole) return;
      destroy();
      view = new MergeView({
        a: { doc: t.left.text ?? "", extensions: extensions(lang) },
        b: { doc: t.right.text ?? "", extensions: extensions(lang) },
        parent: host,
        orientation: "a-b",
        highlightChanges: true,
        gutter: true,
        collapseUnchanged: whole ? undefined : { margin: 3, minSize: 4 },
      });
    }),
  );
  onCleanup(destroy);

  // keep the selected file visible in the list
  createEffect(
    on(
      () => compare()?.sel,
      (i) => {
        if (i === undefined) return;
        list?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
      },
    ),
  );

  const goChunk = (dir: 1 | -1) => {
    if (!view) return compareMove(dir);
    const chunks = getChunks(view.b.state)?.chunks ?? [];
    const next = chunk + dir;
    if (next < 0 || next >= chunks.length) {
      if (!chunks.length) flash("Nessuna differenza in questo file");
      return compareMove(dir);
    }
    chunk = next;
    const c = chunks[next];
    view.b.dispatch({ selection: { anchor: c.fromB }, effects: EditorView.scrollIntoView(c.fromB, { y: "center" }) });
    flash(`Modifica ${next + 1} di ${chunks.length}`);
  };

  onMount(() => {
    section.focus();
    setCompareHandle({
      nextChange: () => goChunk(1),
      prevChange: () => goChunk(-1),
      scroll: (n) => view?.dom.scrollBy({ top: n * 20 }),
      page: (dir) => view?.dom.scrollBy({ top: dir * Math.max(60, view.dom.clientHeight - 60) }),
    });
  });
  onCleanup(() => setCompareHandle(null));

  const file = () => {
    const st = compare();
    return st?.files?.[st.sel] ?? null;
  };
  const counts = () => {
    let a = 0;
    let d = 0;
    for (const f of compare()?.files ?? []) {
      a += f.additions;
      d += f.deletions;
    }
    return { a, d };
  };
  const sideNote = (side: "left" | "right") => {
    const t = compareTexts();
    const ft = t?.[side];
    if (!ft) return "";
    if (ft.kind === "missing") return side === "left" ? "non c'era" : "non c'è più";
    return KIND_NOTE[ft.kind] ?? "";
  };

  return (
    <section class="compare" aria-label="Confronto affiancato" tabindex="-1" data-ctx="compare" ref={section}>
      <header class="cmp-head">
        <span class="cmp-title">Confronto</span>
        <span class="cmp-side del" title={compare()?.req.left.label}>
          {compareTexts()?.leftLabel ?? compare()?.req.left.label}
        </span>
        <span class="cmp-arrow" aria-hidden="true">
          →
        </span>
        <span class="cmp-side add" title={compare()?.req.right.label}>
          {compare()?.req.right.label}
        </span>
        <span class="cmp-push" />
        <Show when={compare()?.files?.length}>
          <span class="muted small">
            {compare()!.files!.length === 1 ? "1 file" : `${compare()!.files!.length} file`} · <span class="add">+{counts().a}</span>{" "}
            <span class="del">−{counts().d}</span>
          </span>
        </Show>
        <button type="button" class="cmp-btn" onClick={() => setCompareWhole(!compareWhole())} title={keyOf("compare.whole", ["compare"]) ? `(${keyOf("compare.whole", ["compare"])})` : undefined}>
          {compareWhole() ? "Solo le modifiche" : "File intero"}
        </button>
        <button type="button" class="cmp-btn" onClick={compareSwap} title={keyOf("compare.swap", ["compare"]) ? `(${keyOf("compare.swap", ["compare"])})` : undefined}>
          Scambia lati
        </button>
        <button type="button" class="cmp-btn cmp-close" aria-label="Chiudi il confronto" onClick={closeCompare}>
          <Show when={keyOf("compare.close", ["compare"])} fallback="×">
            {(k) => <Kbd>{k()}</Kbd>}
          </Show>
        </button>
      </header>
      <div class="cmp-body">
        <div class="cmp-files" ref={list} role="listbox" aria-label="File confrontati">
          <Show when={compare()?.files} fallback={<div class="muted pad">{compare()?.error ? "" : "Caricamento…"}</div>}>
            <For each={compare()!.files!} fallback={<div class="muted pad">Nessuna differenza.</div>}>
              {(f, i) => (
                <div
                  class="ch-row cmp-file"
                  classList={{ sel: compare()?.sel === i() }}
                  data-i={i()}
                  role="option"
                  aria-selected={compare()?.sel === i()}
                  title={f.origPath && f.origPath !== f.path ? `${f.origPath} → ${f.path}` : f.path}
                  onClick={() => compareSelect(i())}
                >
                  <span class={`badge ${STATUS_CLASS[LETTER(f.status)] ?? ""}`}>{LETTER(f.status)}</span>
                  <span class="ch-name">{basename(f.path)}</span>
                  <span class="ch-dir">{dirname(f.path)}</span>
                  <span class="rv-stat">
                    <Show when={!f.binary} fallback={<span class="muted">bin</span>}>
                      <span class="add">+{f.additions}</span> <span class="del">−{f.deletions}</span>
                    </Show>
                  </span>
                </div>
              )}
            </For>
          </Show>
        </div>
        <div class="cmp-main">
          <Show when={compare()?.error}>
            <div class="d-note error">Confronto non disponibile: {compare()?.error}</div>
          </Show>
          <Show when={file()}>
            {(f) => (
              <div class="cmp-paths">
                <span class="cmp-path del">
                  {compareTexts()?.leftPath ?? f().origPath ?? f().path}
                  <Show when={sideNote("left")}>
                    <span class="muted"> · {sideNote("left")}</span>
                  </Show>
                </span>
                <span class="cmp-path add">
                  {f().path}
                  <Show when={sideNote("right")}>
                    <span class="muted"> · {sideNote("right")}</span>
                  </Show>
                </span>
              </div>
            )}
          </Show>
          <Show when={compareTexts()?.error}>
            <div class="d-note error">Contenuto non disponibile: {compareTexts()?.error}</div>
          </Show>
          <Show when={file() && compareTexts() && (!compareTexts()!.left || !compareTexts()!.right) && !compareTexts()!.error}>
            <div class="muted pad">Caricamento…</div>
          </Show>
          <div class="cmp-merge" ref={host} />
        </div>
      </div>
    </section>
  );
}
