import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, type JSX } from "solid-js";
import type { Commit } from "../api";
import { runCommand } from "../core/commands";
import { edgesBetween } from "../lib/lanes";
import { basename, dirname } from "../lib/path";
import { fullDate, relativeDate } from "../lib/reldate";
import { diffHandles, focusBottom, getRepoHandle, listHandles, registerRegion, setRepoHandle, type RepoColumnHandle } from "../state/focus";
import { activateRepo, ensureRepoDirty, folderRepos, repoDirty, showRepoColumn } from "../state/activeRepo";
import { switchRoot } from "../state/session";
import { repoRows, samePath } from "../lib/gitroot";
import {
  GROUP_TITLES, changeEntries, changeRows, changeSel, commitDiffEntries, commits, detail, laneRows, laneWidth, loadMoreLog,
  logDone, logError, logLoading, refreshChangeDiff, selectChange, selectCommit, selectedCommit, toggleCommitFile,
} from "../state/git";
import { loadReview, review, reviewBase, reviewCounts, reviewEntries, reviewRows, reviewSel, selectReview } from "../state/review";
import { setUi, ui } from "../state/ui";
import { activeRepo, gitRoot, isFolderWs, repo, root, status } from "../state/workspace";
import { baseRef, mainWorktree, wtStatus } from "../state/worktrees";
import { DiffView } from "./DiffView";
import { Kbd, LANE_COLORS, STATUS_CLASS, keyOf } from "./common";
import { VirtualList, type VirtualListApi } from "./VirtualList";

/** No git root: a plain folder (offer the project picker) or a folder workspace with no active repository. */
function NotRepo(): JSX.Element {
  return (
    <Show
      when={!isFolderWs() || !folderRepos()?.length || activeRepo()}
      fallback={
        <div class="not-repo pad">
          <div class="muted">Scegli un repository</div>
          <div class="muted small">
            dalla colonna Repository<Show when={keyOf("repos.focus", ["history"])}>{(k) => <> (<Kbd>{k()}</Kbd>)</>}</Show> o con{" "}
            <Show when={keyOf("project.pick")}>{(k) => <Kbd>{k()}</Kbd>}</Show>
          </div>
        </div>
      }
    >
      <Show when={!(isFolderWs() && activeRepo())} fallback={<div class="muted pad">Caricamento…</div>}>
        <PlainNotRepo />
      </Show>
    </Show>
  );
}

function PlainNotRepo(): JSX.Element {
  return (
    <div class="not-repo pad">
      <div class="muted">La cartella non è un repository git.</div>
      <button type="button" class="wt-search" onClick={() => runCommand("project.pick")}>
        <span>Cerca repository…</span>
        <Show when={keyOf("project.pick")}>{(k) => <Kbd>{k()}</Kbd>}</Show>
      </button>
    </div>
  );
}

const ROW = 30;
const LANE = 16;
const GRAPH_LEFT = 14;
const MAX_LANES = 14;
const color = (i: number) => LANE_COLORS[i % LANE_COLORS.length];

// ------------------------------------------------------------- graph

function Graph(props: { start: number; end: number }): JSX.Element {
  const shapes = createMemo(() => {
    const rows = laneRows();
    const cs = commits();
    const s = Math.max(0, props.start - 1);
    const e = Math.min(rows.length, props.end);
    const base = props.start * ROW;
    const x = (col: number) => 8 + col * LANE;
    const lines: { d: string; c: string }[] = [];
    const nodes: { x: number; y: number; c: string; head: boolean }[] = [];
    for (let i = s; i < e; i++) {
      const r = rows[i];
      const y1 = i * ROW + ROW / 2 - base;
      const y2 = y1 + ROW;
      const next = i + 1 < rows.length ? { hash: cs[i + 1].hash, row: rows[i + 1] } : undefined;
      for (const ed of edgesBetween(r, next)) {
        const x1 = x(ed.from);
        const x2 = x(ed.to);
        const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${y1 + ROW / 2} ${x2} ${y1 + ROW / 2} ${x2} ${y2}`;
        lines.push({ d, c: color(ed.color) });
      }
      if (i >= props.start) nodes.push({ x: x(r.col), y: y1, c: color(r.color), head: cs[i].isHead });
    }
    return { lines, nodes };
  });
  const width = () => Math.max(1, laneWidth()) * LANE + 8;
  return (
    <svg
      class="graph"
      aria-hidden="true"
      width={width()}
      height={(props.end - props.start) * ROW}
      style={{ top: `${props.start * ROW}px`, left: `${GRAPH_LEFT}px` }}
    >
      <For each={shapes().lines}>{(l) => <path d={l.d} stroke={l.c} />}</For>
      <For each={shapes().nodes}>
        {(n) => (
          <>
            <Show when={n.head}>
              <circle cx={n.x} cy={n.y} r={7.5} fill="none" stroke={n.c} stroke-width="1.5" />
            </Show>
            <circle cx={n.x} cy={n.y} r={n.head ? 4.5 : 4} fill={n.c} />
          </>
        )}
      </For>
    </svg>
  );
}

// ------------------------------------------------------------- history

function CommitRow(props: { i: number; pad: number }): JSX.Element {
  const c = (): Commit | undefined => commits()[props.i];
  const nodeColor = () => color(laneRows()[props.i]?.color ?? 0);
  return (
    <Show
      when={c()}
      fallback={
        <div class="commit-row muted" style={{ "padding-left": `${props.pad}px` }}>
          {logError() ? `Errore: ${logError()}` : "Caricamento…"}
        </div>
      }
    >
      {(cm) => (
        <div
          id={`commit-${props.i}`}
          role="option"
          aria-selected={selectedCommit() === props.i}
          class="commit-row"
          classList={{ sel: selectedCommit() === props.i }}
          style={{ "padding-left": `${props.pad}px` }}
          title={`${cm().author} · ${fullDate(cm().date)}`}
          onClick={() => selectCommit(props.i)}
        >
          <span class="c-hash">{cm().hash.slice(0, 7)}</span>
          <span class="c-subj">{cm().subject}</span>
          <Show when={cm().isHead}>
            <span class="ref head" style={{ background: nodeColor() }}>
              HEAD
            </span>
          </Show>
          <For each={cm().refs}>
            {(r) => (
              <span class={`ref ${r.kind}`} style={{ color: nodeColor(), "border-color": nodeColor() }}>
                {r.name}
              </span>
            )}
          </For>
        </div>
      )}
    </Show>
  );
}

function CommitDetail(): JSX.Element {
  const c = () => commits()[selectedCommit()];
  const totals = createMemo(() => {
    const files = detail()?.files;
    if (!files) return null;
    let a = 0;
    let d = 0;
    for (const f of files) {
      a += f.additions;
      d += f.deletions;
    }
    return { n: files.length, a, d };
  });
  return (
    <div class="detail">
      <Show when={c()} fallback={<div class="muted pad">Nessun commit selezionato</div>}>
        {(cm) => (
          <>
            <div class="detail-head">
              <span class="d-subj">{cm().subject}</span>
              <span class="muted small" title={fullDate(cm().date)}>
                {cm().hash.slice(0, 7)} · {cm().author} · {relativeDate(cm().date)}
              </span>
              <span class="totals muted small">
                <Show when={totals()} fallback="…">
                  {(t) => (
                    <>
                      {t().n === 1 ? "1 file" : `${t().n} file`} · <span class="add">+{t().a}</span> <span class="del">−{t().d}</span>
                    </>
                  )}
                </Show>
              </span>
            </div>
            <Show when={detail()?.error}>
              <div class="d-note error">{detail()?.error}</div>
            </Show>
            <DiffView
              name="history"
              label="Diff del commit"
              entries={commitDiffEntries}
              onToggle={(p) => toggleCommitFile(p)}
              onBack={() => document.getElementById("commit-list")?.focus()}
              empty={<div class="muted pad">{detail()?.files ? "Nessun file modificato" : "Caricamento…"}</div>}
            />
          </>
        )}
      </Show>
    </div>
  );
}

function History(): JSX.Element {
  let list: VirtualListApi | undefined;
  const pad = () => GRAPH_LEFT + Math.min(Math.max(1, laneWidth()), MAX_LANES) * LANE + 14;
  const count = () => commits().length + (logDone() ? 0 : 1);

  createEffect(() => {
    if (ui.bottomVisible && ui.bottomTab === "history" && repo()?.isRepo && !commits().length && !logLoading() && !logDone() && !logError()) {
      void loadMoreLog();
    }
  });

  const move = (d: number) => {
    const n = commits().length;
    if (!n) return;
    const i = Math.max(0, Math.min(n - 1, (selectedCommit() < 0 ? -1 : selectedCommit()) + d));
    selectCommit(i);
    list?.scrollToIndex(i);
  };
  listHandles.history = { next: () => move(1), prev: () => move(-1), toDiff: () => diffHandles.history?.focus() };

  return (
    <div class="git-split">
      <div
        id="commit-list"
        class="commit-list focusable"
        tabindex="0"
        role="listbox"
        aria-label="Commit"
        aria-activedescendant={selectedCommit() >= 0 ? `commit-${selectedCommit()}` : undefined}
        data-ctx="history"
        ref={(el) => registerRegion("history", el)}
      >
        <Show when={repo()?.isRepo} fallback={<NotRepo />}>
          <VirtualList
            count={count()}
            rowHeight={ROW}
            row={(i) => <CommitRow i={i} pad={pad()} />}
            overlay={(s, e) => <Graph start={s} end={Math.min(e, commits().length)} />}
            onRange={(_s, e) => {
              if (e >= commits().length - 20) void loadMoreLog();
            }}
            ref={(a) => (list = a)}
          />
        </Show>
      </div>
      <CommitDetail />
    </div>
  );
}

// ------------------------------------------------------------- changes

function Changes(): JSX.Element {
  let list: VirtualListApi | undefined;
  const RH = 26;
  const selIndex = () => {
    const s = changeSel();
    if (!s) return -1;
    return changeRows().findIndex((r) => r.kind === "file" && r.group === s.group && r.entry?.path === s.path);
  };

  createEffect(() => {
    if (ui.bottomVisible && ui.bottomTab === "changes" && !changeSel()) {
      const f = changeRows().find((r) => r.kind === "file");
      if (f) selectChange(f);
    }
  });
  createEffect(on(status, () => refreshChangeDiff(), { defer: true }));

  const move = (d: number) => {
    const rows = changeRows();
    let i = selIndex();
    for (let k = 0; k < rows.length; k++) {
      i += d;
      if (i < 0 || i >= rows.length) return;
      if (rows[i].kind === "file") break;
    }
    selectChange(rows[i]);
    list?.scrollToIndex(i);
  };
  listHandles.changes = { next: () => move(1), prev: () => move(-1), toDiff: () => diffHandles.changes?.focus() };

  return (
    <div class="git-split">
      <div
        id="changes-list"
        class="commit-list focusable"
        tabindex="0"
        role="listbox"
        aria-label="File modificati"
        aria-activedescendant={selIndex() >= 0 ? `change-${selIndex()}` : undefined}
        data-ctx="changes"
        ref={(el) => registerRegion("changes", el)}
      >
        <Show when={changeRows().length} fallback={repo()?.isRepo ? <div class="muted pad">Nessuna modifica: l'albero di lavoro è pulito.</div> : <NotRepo />}>
          <VirtualList
            count={changeRows().length}
            rowHeight={RH}
            ref={(a) => (list = a)}
            row={(i) => {
              const r = () => changeRows()[i];
              return (
                <Show when={r()}>
                  {(row) => (
                    <Show
                      when={row().kind === "file"}
                      fallback={
                        <div class="ch-head">
                          {GROUP_TITLES[row().group]} · {row().count}
                        </div>
                      }
                    >
                      <div
                        id={`change-${i}`}
                        role="option"
                        aria-selected={selIndex() === i}
                        class="ch-row"
                        classList={{ sel: selIndex() === i }}
                        title={row().entry!.path}
                        onClick={() => selectChange(row())}
                      >
                        <span class={`badge ${STATUS_CLASS[row().letter!] ?? ""}`}>{row().letter}</span>
                        <span class="ch-name">{basename(row().entry!.path)}</span>
                        <span class="ch-dir">
                          {row().entry!.origPath ? `da ${row().entry!.origPath}` : dirname(row().entry!.path)}
                        </span>
                      </div>
                    </Show>
                  )}
                </Show>
              );
            }}
          />
        </Show>
      </div>
      <div class="detail">
        <DiffView
          name="changes"
          label="Diff della modifica"
          entries={changeEntries}
          onToggle={() => {}}
          onBack={() => document.getElementById("changes-list")?.focus()}
          empty={<div class="muted pad">Seleziona un file per vederne il diff.</div>}
        />
      </div>
    </div>
  );
}

// ------------------------------------------------------------- review

const REVIEW_TITLES = { todo: "DA RIVEDERE", seen: "VISTI" } as const;
/** Letter of a review row: an untracked file is new to the branch like an added one. */
const reviewLetter = (s: string) => (s === "?" ? "A" : s);

function Review(): JSX.Element {
  let list: VirtualListApi | undefined;
  const RH = 26;
  const selIndex = () => {
    const s = reviewSel();
    return s ? reviewRows().findIndex((r) => r.kind === "file" && r.file!.path === s) : -1;
  };

  // reload when the tab is shown and whenever git state may have moved
  createEffect(
    on(
      () => [ui.bottomVisible && ui.bottomTab === "review", gitRoot(), reviewBase(), status(), repo()?.head] as const,
      ([visible]) => {
        if (visible) void loadReview();
      },
    ),
  );

  const move = (d: number) => {
    const rows = reviewRows();
    let i = selIndex();
    for (let k = 0; k < rows.length; k++) {
      i += d;
      if (i < 0 || i >= rows.length) return;
      if (rows[i].kind === "file") break;
    }
    selectReview(rows[i].file!.path);
    list?.scrollToIndex(i);
  };
  listHandles.review = { next: () => move(1), prev: () => move(-1), toDiff: () => diffHandles.review?.focus() };
  // keep the selection on screen when marking moves it to the next file
  createEffect(
    on(selIndex, (i) => {
      if (i >= 0) list?.scrollToIndex(i);
    }),
  );

  const counts = reviewCounts;
  const progress = () => {
    const c = counts();
    return c.total ? Math.round(((c.total - c.todo) / c.total) * 100) : 0;
  };
  const empty = () => {
    const rv = review();
    if (!repo()?.isRepo) return <NotRepo />;
    if (rv?.error) return <div class="muted pad error-text">Revisione non disponibile: {rv.error}</div>;
    if (!rv?.info) return <div class="muted pad">Caricamento…</div>;
    return <div class="muted pad">Nessuna differenza rispetto a {rv.base ?? "HEAD"}: niente da rivedere.</div>;
  };

  return (
    <div class="git-split">
      <div
        id="review-list"
        class="commit-list review-list focusable"
        tabindex="0"
        role="listbox"
        aria-label="File da rivedere"
        aria-activedescendant={selIndex() >= 0 ? `review-${selIndex()}` : undefined}
        data-ctx="review"
        ref={(el) => registerRegion("review", el)}
      >
        <Show when={review()?.info && counts().total}>
          <div class="rv-head">
            <div class="rv-sum">
              <span>
                rispetto a <span class="accent">{review()?.base ?? "HEAD"}</span>
              </span>
              <span class="muted">
                {counts().total === 1 ? "1 file" : `${counts().total} file`} · <span class="add">+{counts().additions}</span>{" "}
                <span class="del">−{counts().deletions}</span>
              </span>
            </div>
            <div class="rv-prog" title={`${counts().total - counts().todo} di ${counts().total} file visti`}>
              <span class="rv-bar">
                <span style={{ width: `${progress()}%` }} classList={{ done: !counts().todo }} />
              </span>
              <span class="muted small">{counts().todo ? `${counts().total - counts().todo}/${counts().total} visti` : "tutto visto"}</span>
            </div>
          </div>
        </Show>
        <Show when={reviewRows().length} fallback={empty()}>
          <VirtualList
            count={reviewRows().length}
            rowHeight={RH}
            ref={(a) => (list = a)}
            row={(i) => {
              const r = () => reviewRows()[i];
              return (
                <Show when={r()}>
                  {(row) => (
                    <Show
                      when={row().kind === "file"}
                      fallback={
                        <div class="ch-head">
                          {REVIEW_TITLES[row().group]} · {row().count}
                        </div>
                      }
                    >
                      <div
                        id={`review-${i}`}
                        role="option"
                        aria-selected={selIndex() === i}
                        class="ch-row rv-row"
                        classList={{ sel: selIndex() === i, seen: row().state === "seen" }}
                        title={row().file!.origPath ? `${row().file!.path} (da ${row().file!.origPath})` : row().file!.path}
                        onClick={() => selectReview(row().file!.path)}
                      >
                        <span class={`badge ${STATUS_CLASS[reviewLetter(row().file!.status)] ?? ""}`}>{reviewLetter(row().file!.status)}</span>
                        <span class="ch-name">{basename(row().file!.path)}</span>
                        <Show when={row().state === "changed"}>
                          <span class="rv-tag" title="Modificato di nuovo dopo che l'hai segnato come visto">
                            ritoccato
                          </span>
                        </Show>
                        <span class="ch-dir">{row().file!.origPath ? `da ${row().file!.origPath}` : dirname(row().file!.path)}</span>
                        <span class="rv-stat">
                          <Show when={!row().file!.binary} fallback={<span class="muted">bin</span>}>
                            <span class="add">+{row().file!.additions}</span> <span class="del">−{row().file!.deletions}</span>
                          </Show>
                        </span>
                        <span class="rv-check" aria-label={row().state === "seen" ? "visto" : undefined}>
                          {row().state === "seen" ? "✓" : ""}
                        </span>
                      </div>
                    </Show>
                  )}
                </Show>
              );
            }}
          />
        </Show>
      </div>
      <div class="detail">
        <DiffView
          name="review"
          label="Diff in revisione"
          entries={reviewEntries}
          onToggle={() => {}}
          onBack={() => document.getElementById("review-list")?.focus()}
          empty={<div class="muted pad">Seleziona un file per vederne il diff.</div>}
        />
      </div>
    </div>
  );
}

// ------------------------------------------------------------- repository column (folder workspace)

const REPO_ROW = 40;

function RepoColumn(): JSX.Element {
  let list: VirtualListApi | undefined;
  const rows = createMemo(() => repoRows(root(), folderRepos() ?? [], activeRepo()));
  const [sel, setSel] = createSignal(0);
  const activeIndex = () => rows().findIndex((r) => r.active);
  // the keyboard cursor starts (and lands after a switch) on the active repository
  createEffect(
    on(activeIndex, (i) => {
      if (i >= 0) {
        setSel(i);
        list?.scrollToIndex(i);
      }
    }),
  );
  const clamp = (i: number) => Math.max(0, Math.min(rows().length - 1, i));
  const move = (d: number) => {
    if (!rows().length) return;
    const i = clamp(sel() + d);
    setSel(i);
    list?.scrollToIndex(i);
  };
  const activate = async (i = sel()) => {
    const r = rows()[i];
    if (!r) return;
    setSel(i);
    if (await activateRepo(r.path)) focusBottom(ui.bottomTab);
  };
  const handle: RepoColumnHandle = {
    move,
    page: (dir) => move(dir * (list?.pageRows() ?? 8)),
    activate: () => void activate(),
    openHere: () => {
      const r = rows()[sel()];
      if (r) void switchRoot(r.path);
    },
  };
  setRepoHandle(handle);
  onCleanup(() => getRepoHandle() === handle && setRepoHandle(null));

  const Row = (props: { i: number }) => {
    const r = () => rows()[props.i];
    return (
      <Show when={r()}>
        {(row) => {
          // only rows on screen ask for their change count
          createEffect(() => {
            repoDirty(row().path);
            ensureRepoDirty(row().path);
          });
          const dirty = () => {
            const d = repoDirty(row().path);
            return d === undefined || d === "loading" ? "…" : d === "error" ? "?" : d ? `${d} mod.` : "";
          };
          return (
            <div
              id={`repo-${props.i}`}
              role="option"
              aria-selected={sel() === props.i}
              aria-current={row().active ? "true" : undefined}
              class="repo-row"
              classList={{ sel: sel() === props.i, active: row().active }}
              title={row().path}
              onClick={() => void activate(props.i)}
            >
              <span class="dot" classList={{ current: row().active }} aria-hidden="true" />
              <span class="repo-text">
                <span class="repo-name">{row().relPath || "."}</span>
                <span class="repo-branch">
                  {row().branch ?? "HEAD staccato"}
                  <Show when={row().linked}>
                    <span class="repo-linked" title="Worktree collegato">
                      {" "}
                      · worktree
                    </span>
                  </Show>
                </span>
              </span>
              <span class="repo-dirty">{dirty()}</span>
            </div>
          );
        }}
      </Show>
    );
  };

  return (
    <div class="repo-col">
      <div class="repo-head">
        <span>Repository · {folderRepos()?.length ?? "…"}</span>
      </div>
      <div
        id="repo-list"
        class="repo-list focusable"
        tabindex="0"
        role="listbox"
        aria-label="Repository"
        aria-activedescendant={rows().length ? `repo-${sel()}` : undefined}
        data-ctx="repos"
        ref={(el) => registerRegion("repos", el)}
      >
        <VirtualList count={rows().length} rowHeight={REPO_ROW} overscan={1} row={(i) => <Row i={i} />} ref={(a) => (list = a)} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------- panel

export function BottomPanel(): JSX.Element {
  const info = () => {
    const r = repo();
    if (!r?.isRepo) return "";
    const branch = r.branch ?? "HEAD staccato";
    const main = mainWorktree();
    const g = gitRoot();
    if (!main || samePath(main.path, g)) return branch;
    const s = wtStatus(g);
    if (!s || typeof s !== "object") return branch;
    const parts = [branch];
    if (s.ahead) parts.push(`↑${s.ahead}`);
    if (s.behind) parts.push(`↓${s.behind}`);
    const rel = s.ahead || s.behind ? `${parts.slice(1).join(" ")} rispetto a ${baseRef()}` : `allineato a ${baseRef()}`;
    return `${branch} · ${rel}`;
  };
  const TAB_COMMANDS = { history: "git.history", changes: "git.changes", review: "git.review" } as const;
  const tab = (t: keyof typeof TAB_COMMANDS, label: () => string, title?: string) => (
    <button
      type="button"
      role="tab"
      class="bp-tab"
      classList={{ active: ui.bottomTab === t }}
      aria-selected={ui.bottomTab === t}
      title={title}
      onClick={() => {
        setUi("bottomTab", t);
        runCommand(TAB_COMMANDS[t]);
      }}
    >
      {label()}
    </button>
  );
  return (
    <section class="bottom" aria-label="Git" style={{ height: `${ui.bottomHeight}px` }}>
      <div class="bp-bar" role="tablist" aria-label="Viste git">
        {tab("history", () => "Cronologia")}
        {tab("changes", () => `Modifiche · ${status().length}`)}
        {tab(
          "review",
          () => (review()?.info ? `Revisione · ${reviewCounts().todo}` : "Revisione"),
          "Tutto ciò che il branch cambia rispetto alla base: segna i file come visti",
        )}
        <span class="bp-info">{info()}</span>
      </div>
      <div class="bp-body">
        <Show when={showRepoColumn()}>
          <RepoColumn />
        </Show>
        <div class="bp-page" style={{ display: ui.bottomTab === "history" ? "flex" : "none" }}>
          <History />
        </div>
        <div class="bp-page" style={{ display: ui.bottomTab === "changes" ? "flex" : "none" }}>
          <Changes />
        </div>
        <div class="bp-page" style={{ display: ui.bottomTab === "review" ? "flex" : "none" }}>
          <Review />
        </div>
      </div>
    </section>
  );
}
