import { Show, createEffect, createMemo, on, type JSX } from "solid-js";
import { runCommand } from "../core/commands";
import type { Worktree } from "../api";
import { samePath, worktreeLabelPath } from "../lib/gitroot";
import { openWorktree, folderRepos } from "../state/activeRepo";
import { switchRoot } from "../state/session";
import { bufs, openFile } from "../state/buffers";
import { registerRegion } from "../state/focus";
import { isExpanded, isLoading, selected, setSelected, toggleDir, treeLoaded, treeRows } from "../state/tree";
import { ui } from "../state/ui";
import { activeRepo, dirtyDirs, gitRoot, isFolderWs, repo, repoPrefix, root, status, statusByPath } from "../state/workspace";
import { ensureWtStatus, mainWorktree, needsWtStatus, worktrees, wtStatus } from "../state/worktrees";
import { containerRepos } from "../state/projects";
import { Kbd, STATUS_CLASS, keyOf } from "./common";
import { VirtualList, type VirtualListApi } from "./VirtualList";

const ROW = 24;

function FileTree(): JSX.Element {
  let list: VirtualListApi | undefined;
  const index = createMemo(() => treeRows().findIndex((r) => r.entry.path === selected()));

  // keep the keyboard selection on screen
  createEffect(on(index, (i) => i >= 0 && list?.scrollToIndex(i), { defer: true }));

  const Row = (props: { i: number }) => {
    const row = () => treeRows()[props.i];
    return (
      <Show when={row()}>
        {(r) => {
          const e = () => r().entry;
          const isDir = () => e().kind === "dir";
          const letter = () => statusByPath().get(e().path);
          const pad = () => 14 + r().depth * 16 + (isDir() ? 0 : 16);
          return (
            <div
              id={`tree-row-${props.i}`}
              role="treeitem"
              aria-level={r().depth + 1}
              aria-expanded={isDir() ? isExpanded(e().path) : undefined}
              aria-selected={selected() === e().path}
              class="tree-row"
              classList={{ sel: selected() === e().path, ignored: e().ignored, open: bufs.active === e().path }}
              style={{ "padding-left": `${pad()}px` }}
              title={e().path}
              onClick={() => {
                setSelected(e().path);
                if (isDir()) toggleDir(e().path);
                else void openFile(e().path, { focus: false });
              }}
              onDblClick={() => !isDir() && void openFile(e().path, { focus: true })}
            >
              <Show when={isDir()}>
                <span class="chev" aria-hidden="true">
                  {isLoading(e().path) ? "◌" : isExpanded(e().path) ? "▾" : "▸"}
                </span>
              </Show>
              <span class="tree-name">{e().name}</span>
              <Show when={letter()}>{(l) => <span class={`badge ${STATUS_CLASS[l()] ?? ""}`}>{l()}</span>}</Show>
              <Show when={isDir() && !isExpanded(e().path) && dirtyDirs().has(e().path)}>
                <span class="dir-dot" title="Contiene modifiche" aria-hidden="true">
                  •
                </span>
              </Show>
            </div>
          );
        }}
      </Show>
    );
  };

  return (
    <div
      class="tree focusable"
      tabindex="0"
      role="tree"
      aria-label="File del progetto"
      aria-activedescendant={index() >= 0 ? `tree-row-${index()}` : undefined}
      data-ctx="tree"
      ref={(el) => registerRegion("tree", el)}
      onFocus={() => {
        if (!selected() && treeRows().length) setSelected(treeRows()[0].entry.path);
      }}
    >
      <Show when={treeLoaded()} fallback={<div class="muted pad">Caricamento…</div>}>
        <Show when={treeRows().length} fallback={<div class="muted pad">Cartella vuota</div>}>
          <VirtualList count={treeRows().length} rowHeight={ROW} row={(i) => <Row i={i} />} ref={(a) => (list = a)} />
        </Show>
      </Show>
    </div>
  );
}

const WT_ROW = 38;
const WT_MAX_ROWS = 6;

/** Worktrees of the active repository (the workspace's in a repository workspace). */
function WorktreeBlock(): JSX.Element {
  const list = () => worktrees();
  const count = () => list()?.length ?? 0;
  const label = (w: Worktree) => w.branch ?? `(staccato) ${w.head.slice(0, 7)}`;
  const short = (w: Worktree, isCur: boolean) => {
    const s = wtStatus(w.path);
    const parts: string[] = [];
    if (w.isMain) parts.push("principale");
    if (s && typeof s === "object") {
      if (!w.isMain && s.ahead) parts.push(`↑${s.ahead}`);
      if (!w.isMain && s.behind) parts.push(`↓${s.behind}`);
      if (!w.isMain && !s.ahead && !s.behind) parts.push("allineato");
      // the current worktree's count follows the live status
      const dirty = isCur ? status().length : s.dirty;
      if (dirty) parts.push(`${dirty} mod.`);
    } else if (s === "error") parts.push("?");
    else parts.push("…");
    return parts.join(" · ");
  };
  const Row = (props: { i: number }) => {
    const w = () => list()?.[props.i];
    return (
      <Show when={w()}>
        {(wt) => {
          const isCur = () => samePath(wt().path, gitRoot());
          // only rows on screen ask for their numbers
          createEffect(() => {
            if (needsWtStatus(wt().path)) ensureWtStatus(wt().path);
          });
          return (
            <div
              class="wt-row"
              classList={{ current: isCur() }}
              role="option"
              aria-selected={isCur()}
              title={wt().path}
              onClick={() => {
                if (isCur()) return;
                void openWorktree(wt().path, (p) => switchRoot(p));
              }}
            >
              <span class="dot" classList={{ current: isCur() }} aria-hidden="true" />
              <div class="wt-text">
                <div class="wt-branch">{label(wt())}</div>
                <div class="wt-path">{worktreeLabelPath(wt().path, mainWorktree()?.path ?? null)}</div>
              </div>
              <span class="wt-info">{short(wt(), isCur())}</span>
            </div>
          );
        }}
      </Show>
    );
  };
  const noRepo = () => isFolderWs() && !activeRepo();
  // keep the current worktree on screen when the list (or the git root) changes
  let wtList: VirtualListApi | undefined;
  const curIndex = () => list()?.findIndex((w) => samePath(w.path, gitRoot())) ?? -1;
  createEffect(on(curIndex, (i) => i >= 0 && requestAnimationFrame(() => wtList?.scrollToIndex(i))));
  return (
    <div class="wt-block">
      <div class="side-head split">
        <span>WORKTREE{count() ? ` · ${count()}` : ""}</span>
        <Show when={isFolderWs() && activeRepo()}>
          <span class="side-count" title={activeRepo()!}>
            {repoPrefix() || activeRepo()}
          </span>
        </Show>
      </div>
      <Show
        when={!noRepo()}
        fallback={<div class="wt-empty muted">Nessun repository attivo</div>}
      >
        <Show when={repo()?.isRepo} fallback={<div class="wt-empty muted">{isFolderWs() ? "Caricamento…" : "Nessun repository git"}</div>}>
          <Show when={list()} fallback={<div class="wt-empty muted">Caricamento…</div>}>
            <div class="wt-list" role="listbox" aria-label="Worktree" style={{ height: `${Math.min(count(), WT_MAX_ROWS) * WT_ROW}px` }}>
              <VirtualList count={count()} rowHeight={WT_ROW} overscan={1} style={{ height: "100%" }} row={(i) => <Row i={i} />} ref={(a) => (wtList = a)} />
            </div>
          </Show>
        </Show>
      </Show>
      <div class="wt-btn-wrap">
        <Show
          when={!noRepo()}
          fallback={
            <button type="button" class="wt-search" onClick={() => runCommand("project.pick")}>
              <span>Cerca repository…</span>
              <Show when={keyOf("project.pick")}>{(k) => <Kbd>{k()}</Kbd>}</Show>
            </button>
          }
        >
          <button type="button" class="wt-search" onClick={() => runCommand("worktree.pick")}>
            <span>Cerca worktree…</span>
            <Show when={keyOf("worktree.pick")}>{(k) => <Kbd>{k()}</Kbd>}</Show>
          </button>
        </Show>
      </div>
    </div>
  );
}
/** Shown instead of the worktree block when the workspace is not a repository. */
function RepoBlock(): JSX.Element {
  const repos = () => (ui.container === root() ? containerRepos() : null);
  const count = () => {
    const r = repos();
    return r ? String(r.length) : "…";
  };
  return (
    <div class="wt-block">
      <div class="side-head split">
        <span>REPOSITORY · {count()}</span>
      </div>
      <div class="wt-current muted">
        {repos()?.length === 0 ? "Nessun repository in questa cartella" : "La cartella non è un repository git"}
      </div>
      <div class="wt-btn-wrap">
        <button type="button" class="wt-search" onClick={() => runCommand(repos()?.length === 0 ? "folder.browse" : "project.pick")}>
          <Show
            when={repos()?.length === 0}
            fallback={
              <>
                <span>Cerca repository…</span>
                <Show when={keyOf("project.pick")}>{(k) => <Kbd>{k()}</Kbd>}</Show>
              </>
            }
          >
            <span>Sfoglia cartelle…</span>
            <Show when={keyOf("folder.browse")}>{(k) => <Kbd>{k()}</Kbd>}</Show>
          </Show>
        </button>
      </div>
    </div>
  );
}

export function Sidebar(): JSX.Element {
  return (
    <aside class="sidebar" aria-label="Barra laterale" style={{ width: `${ui.sidebarWidth}px` }}>
      <div class="side-head">FILE</div>
      <FileTree />
      <Show when={!isFolderWs() || folderRepos() === null || folderRepos()!.length > 0 || activeRepo()} fallback={<RepoBlock />}>
        <WorktreeBlock />
      </Show>
    </aside>
  );
}
