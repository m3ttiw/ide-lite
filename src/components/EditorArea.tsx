import { For, Match, Show, Switch, createMemo, onMount, type JSX } from "solid-js";
import { activate, activeBuffer, bufs, closeBuffer, registerEditorHost } from "../state/buffers";
import { focusEditor, registerRegion } from "../state/focus";
import { dirname } from "../lib/path";
import { Kbd, keyOf } from "./common";

function Tabs(): JSX.Element {
  const dupes = createMemo(() => {
    const seen = new Map<string, number>();
    for (const b of bufs.list) seen.set(b.name, (seen.get(b.name) ?? 0) + 1);
    return seen;
  });
  return (
    <div class="tabs" role="tablist" aria-label="Buffer aperti">
      <For each={bufs.list}>
        {(b) => (
          <div class="tab" classList={{ active: bufs.active === b.path }}>
            <button
              type="button"
              role="tab"
              class="tab-main"
              aria-selected={bufs.active === b.path}
              title={b.path}
              onClick={() => {
                activate(b.path);
                requestAnimationFrame(focusEditor);
              }}
              onAuxClick={(e) => e.button === 1 && closeBuffer(b.path)}
            >
              {b.name}
              <Show when={(dupes().get(b.name) ?? 0) > 1}>
                <span class="tab-dir"> {dirname(b.path) || "/"}</span>
              </Show>
              <Show when={b.dirty}>
                <span class="dirty" aria-label="modificato">
                  {" "}●
                </span>
              </Show>
            </button>
            <button type="button" class="tab-x" aria-label={`Chiudi ${b.name}`} title="Chiudi" onClick={() => closeBuffer(b.path)}>
              ×
            </button>
          </div>
        )}
      </For>
    </div>
  );
}

function Welcome(): JSX.Element {
  const rows: [string, string][] = [
    ["file.quickOpen", "apri un file"],
    ["palette.open", "tutti i comandi"],
    ["project.pick", "cambia progetto"],
    ["folder.browse", "sfoglia cartelle"],
    ["worktree.pick", "cambia worktree"],
    ["git.history", "cronologia git"],
    ["help.open", "tutte le scorciatoie"],
  ];
  return (
    <div class="welcome">
      <div class="welcome-title">Nessun file aperto</div>
      <For each={rows}>
        {([cmd, label]) => (
          <Show when={keyOf(cmd)}>
            {(k) => (
              <div class="welcome-row">
                <Kbd>{k()}</Kbd>
                <span>{label}</span>
              </div>
            )}
          </Show>
        )}
      </For>
    </div>
  );
}

export function EditorArea(): JSX.Element {
  let host!: HTMLDivElement;
  onMount(() => registerEditorHost(host));
  const b = activeBuffer;
  return (
    <>
      <Tabs />
      <div class="editor-pane" tabindex="-1" data-ctx="editor" ref={(el) => registerRegion("editorPane", el)} aria-label="Editor">
        <div ref={host} class="cm-host" style={{ display: b()?.status === "text" ? "block" : "none" }} />
        <Switch>
          <Match when={!b()}>
            <Welcome />
          </Match>
          <Match when={b()?.status === "loading" || b()?.status === "unloaded"}>
            <div class="notice-pane muted">Caricamento di {b()!.name}…</div>
          </Match>
          <Match when={b()?.status === "binary"}>
            <div class="notice-pane">
              <strong>{b()!.name}</strong> è un file binario: non viene mostrato.
            </div>
          </Match>
          <Match when={b()?.status === "tooLarge"}>
            <div class="notice-pane">
              <strong>{b()!.name}</strong> è più grande di 5 MB: non viene caricato.
            </div>
          </Match>
          <Match when={b()?.status === "error"}>
            <div class="notice-pane error">
              Impossibile aprire <strong>{b()!.name}</strong>: {b()!.error}
            </div>
          </Match>
        </Switch>
      </div>
    </>
  );
}
