import { For, Show, createMemo, type JSX } from "solid-js";
import { getCommand, runCommand } from "../core/commands";
import { activeContexts } from "../core/keyboard";
import { CONTEXT_TITLES, HINTS, KEYMAPS, MODE_NAMES, keyFor } from "../core/keymaps";
import { continuations } from "../lib/keys";
import { activeBuffer, activeLanguageName } from "../state/buffers";
import { message, ui } from "../state/ui";
import { projectName, repo, root, status } from "../state/workspace";
import { FileIcon, GitIcon, WorktreeIcon } from "./icons";
import { Kbd, keyOf } from "./common";

// ------------------------------------------------------------- top bar

export function TopBar(): JSX.Element {
  return (
    <header class="topbar">
      <div class="tb-title">
        <span class="tb-name">{projectName() || "ide-lite"}</span>
        <span class="tb-path" title={root()}>
          {root()}
        </span>
      </div>
      <label class="tb-open">
        <span>Apri file</span>
        <input
          type="search"
          placeholder="nome o percorso…"
          data-no-return=""
          onFocus={() => runCommand("file.quickOpen")}
          onMouseDown={(e) => {
            if (document.activeElement === e.currentTarget) runCommand("file.quickOpen");
          }}
        />
        <Show when={keyOf("file.quickOpen")}>{(k) => <Kbd>{k()}</Kbd>}</Show>
      </label>
      <button type="button" class="tb-cmd" onClick={() => runCommand("palette.open")}>
        <Show when={keyOf("palette.open")}>{(k) => <Kbd>{k()}</Kbd>}</Show> comandi
      </button>
    </header>
  );
}

// ------------------------------------------------------------- rail

export function Rail(): JSX.Element {
  return (
    <nav class="rail" aria-label="Viste">
      <button
        type="button"
        class="rail-btn"
        classList={{ on: ui.sidebarVisible }}
        aria-label="File"
        title="File"
        aria-pressed={ui.sidebarVisible}
        onClick={() => runCommand(ui.sidebarVisible && ui.focusCtx === "tree" ? "sidebar.toggle" : "focus.tree")}
      >
        <FileIcon />
      </button>
      <button
        type="button"
        class="rail-btn"
        classList={{ on: ui.bottomVisible }}
        aria-label="Cronologia git"
        title={`Cronologia git${keyOf("git.history") ? " (" + keyOf("git.history") + ")" : ""}`}
        aria-pressed={ui.bottomVisible}
        onClick={() => runCommand(ui.bottomTab === "changes" ? "git.changes" : "git.history")}
      >
        <GitIcon />
      </button>
      <button
        type="button"
        class="rail-btn"
        classList={{ on: ui.overlay?.kind === "picker" && ui.overlay.picker === "worktree" }}
        aria-label="Worktree"
        title={`Worktree${keyOf("worktree.pick") ? " (" + keyOf("worktree.pick") + ")" : ""}`}
        onClick={() => runCommand("worktree.pick")}
      >
        <WorktreeIcon />
      </button>
    </nav>
  );
}

// ------------------------------------------------------------- hint bar

const PICKER_TITLES: Record<string, string> = {
  file: "Apri file",
  buffer: "Cambia buffer",
  command: "Comandi",
  worktree: "Selettore worktree",
};

export function HintBar(): JSX.Element {
  const ctxKey = () => {
    const o = ui.overlay;
    if (o?.kind === "picker") return HINTS[`picker:${o.picker}`] ? `picker:${o.picker}` : "picker";
    if (o?.kind === "help") return "help";
    return HINTS[ui.focusCtx] ? ui.focusCtx : "global";
  };
  const chip = () => {
    if (ui.pending.length) return `${ui.pending.join(" ")} –`;
    const o = ui.overlay;
    if (o?.kind === "picker") return PICKER_TITLES[o.picker];
    if (o?.kind === "help") return "Scorciatoie";
    return CONTEXT_TITLES[ui.focusCtx] ?? "Generale";
  };
  const items = createMemo((): { keys: string; label: string }[] => {
    const bindings = KEYMAPS[ui.mode];
    const ctxs = activeContexts();
    if (ui.pending.length) {
      return continuations(bindings, ui.pending, ctxs).map((c) => ({ keys: c.rest, label: getCommand(c.binding.command)?.title.toLowerCase() ?? c.binding.command }));
    }
    const out: { keys: string; label: string }[] = [];
    for (const h of HINTS[ctxKey()] ?? []) {
      const keys = h.cmds.map((c) => keyFor(bindings, c, ctxs)).filter((k): k is string => !!k);
      if (keys.length) out.push({ keys: keys.join("/"), label: h.label });
    }
    return out;
  });
  const right = () => {
    if (ui.pending.length) return { keys: "C-g", label: "annulla" };
    if (ui.overlay) {
      const k = keyFor(KEYMAPS[ui.mode], "app.cancel", ["global", ...activeContexts()]);
      return k ? { keys: k, label: ui.overlay.kind === "help" ? "chiudi" : "annulla" } : null;
    }
    const k = keyOf("help.open");
    return k ? { keys: k, label: "tutte le scorciatoie" } : null;
  };
  return (
    <Show when={ui.hintsVisible}>
      <div class="hintbar" classList={{ pending: ui.pending.length > 0 }}>
        <span class="chip">{chip()}</span>
        <Show
          when={!ui.pending.length && message()}
          fallback={
            <For each={items()}>
              {(it) => (
                <span class="hint">
                  <Kbd>{it.keys}</Kbd> {it.label}
                </span>
              )}
            </For>
          }
        >
          {(m) => (
            <span class="echo" classList={{ error: m().error }} role="status">
              {m().text}
            </span>
          )}
        </Show>
        <Show when={right()}>
          {(r) => (
            <span class="hint right">
              <Kbd>{r().keys}</Kbd> {r().label}
            </span>
          )}
        </Show>
      </div>
    </Show>
  );
}

/** Messages must stay visible when the hint bar is hidden. */
export function FloatingMessage(): JSX.Element {
  return (
    <Show when={!ui.hintsVisible && message()}>
      {(m) => (
        <div class="toast" classList={{ error: m().error }} role="status">
          {m().text}
        </div>
      )}
    </Show>
  );
}

// ------------------------------------------------------------- status bar

export function StatusBar(): JSX.Element {
  const b = activeBuffer;
  return (
    <footer class="statusbar">
      <Show when={repo()?.isRepo} fallback={<span>{root() ? "nessun repository git" : ""}</span>}>
        <span class="accent">{repo()?.branch ?? `HEAD staccato ${repo()?.head?.slice(0, 7) ?? ""}`}</span>
        <Show when={repo()?.upstream}>
          <span title={`rispetto a ${repo()?.upstream}`}>
            ↑{repo()?.ahead} ↓{repo()?.behind}
          </span>
        </Show>
        <button type="button" class="sb-btn" onClick={() => runCommand("git.changes")}>
          {status().length === 1 ? "1 modifica" : `${status().length} modifiche`}
        </button>
      </Show>
      <span class="sb-push" />
      <Show when={b()?.status === "text"}>
        <span>
          L{ui.cursor.line}, C{ui.cursor.col}
        </span>
      </Show>
      <Show when={b()}>
        <span>{activeLanguageName()}</span>
        <span>UTF-8 · {b()!.eol === "crlf" ? "CRLF" : "LF"}</span>
      </Show>
      <button type="button" class="sb-btn" title="Cambia tasti" onClick={() => runCommand("keymap.toggle")}>
        Tasti: {MODE_NAMES[ui.mode]}
      </button>
    </footer>
  );
}
