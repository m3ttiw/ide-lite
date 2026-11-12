import { Show, createEffect, createMemo, on, type JSX } from "solid-js";
import { runCommand } from "../core/commands";
import { displayWorktreePath } from "../lib/path";
import { bufs, openFile } from "../state/buffers";
import { registerRegion } from "../state/focus";
import { isExpanded, isLoading, selected, setSelected, toggleDir, treeLoaded, treeRows } from "../state/tree";
import { ui } from "../state/ui";
import { dirtyDirs, repo, root, status, statusByPath } from "../state/workspace";
import { mainWorktree, worktrees, wtStatus } from "../state/worktrees";
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

function WorktreeBlock(): JSX.Element {
  const count = () => worktrees()?.length ?? 0;
  const st = () => wtStatus(root());
  const info = () => {
    const parts: string[] = [];
    const w = worktrees()?.find((x) => x.path === root());
    const s = st();
    if (w?.isMain) parts.push("principale");
    else if (s && typeof s === "object" && s.ahead) parts.push(`↑${s.ahead}`);
    if (s && typeof s === "object" && s.behind && !w?.isMain) parts.push(`↓${s.behind}`);
    const n = status().length;
    if (n) parts.push(`${n} mod.`);
    return parts.join(" · ");
  };
  return (
    <div class="wt-block">
      <div class="side-head split">
        <span>WORKTREE</span>
        <span class="side-count">{count() ? `1 di ${count()}` : ""}</span>
      </div>
      <Show when={repo()?.isRepo} fallback={<div class="wt-current muted">Nessun repository git</div>}>
        <div class="wt-current">
          <span class="dot current" aria-hidden="true" />
          <div class="wt-text">
            <div class="wt-branch">{repo()?.branch ?? `(staccato) ${repo()?.head?.slice(0, 7) ?? ""}`}</div>
            <div class="wt-path" title={root()}>
              {displayWorktreePath(root(), mainWorktree()?.path ?? null)}
            </div>
          </div>
          <span class="wt-info">{info()}</span>
        </div>
      </Show>
      <div class="wt-btn-wrap">
        <button type="button" class="wt-search" onClick={() => runCommand("worktree.pick")}>
          <span>Cerca worktree…</span>
          <Show when={keyOf("worktree.pick")}>{(k) => <Kbd>{k()}</Kbd>}</Show>
        </button>
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
      <Show when={!repo() || repo()!.isRepo} fallback={<RepoBlock />}>
        <WorktreeBlock />
      </Show>
    </aside>
  );
}
