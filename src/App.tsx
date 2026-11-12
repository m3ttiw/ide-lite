import { Show, createEffect, onCleanup, onMount, type JSX } from "solid-js";
import { api } from "./api";
import { FloatingMessage, HintBar, Rail, StatusBar, TopBar } from "./components/Bars";
import { EditorArea } from "./components/EditorArea";
import { BottomPanel } from "./components/GitPanel";
import { HelpOverlay, PickerOverlay } from "./components/Overlays";
import { Resizer } from "./components/Resizer";
import { Sidebar } from "./components/Sidebar";
import { refreshTree } from "./state/tree";
import { afterFirstPaint, onWindowFocus, openRoot } from "./state/session";
import { errorText, flash, setUi, ui } from "./state/ui";
import { repo, root } from "./state/workspace";
import { ensureWtStatus, invalidateWtStatuses, needsWtStatus, worktrees } from "./state/worktrees";

export default function App(): JSX.Element {
  onMount(async () => {
    try {
      await openRoot(await api.initialRoot());
    } catch (e) {
      flash(`Impossibile aprire la cartella iniziale: ${errorText(e)}`, true);
    }
    afterFirstPaint();
  });

  const onFocus = () =>
    onWindowFocus(refreshTree, () => {
      invalidateWtStatuses();
    });
  window.addEventListener("focus", onFocus);
  onCleanup(() => window.removeEventListener("focus", onFocus));

  // numbers of the current worktree against the main one (sidebar, git panel)
  createEffect(() => {
    if (worktrees() && root() && repo()?.isRepo && needsWtStatus(root())) ensureWtStatus(root());
  });

  return (
    <div class="app">
      <TopBar />
      <div class="body">
        <Rail />
        <Show when={ui.sidebarVisible}>
          <Sidebar />
          <Resizer
            orient="v"
            label="Larghezza della barra laterale"
            value={() => ui.sidebarWidth}
            set={(n) => setUi("sidebarWidth", n)}
            min={160}
            max={() => Math.max(200, Math.floor(window.innerWidth * 0.6))}
          />
        </Show>
        <main class="main">
          <EditorArea />
          <Show when={ui.bottomVisible}>
            <Resizer
              orient="h"
              invert
              label="Altezza del pannello git"
              value={() => ui.bottomHeight}
              set={(n) => setUi("bottomHeight", n)}
              min={120}
              max={() => Math.max(160, window.innerHeight - 220)}
            />
            <BottomPanel />
          </Show>
        </main>
      </div>
      <HintBar />
      <StatusBar />
      <FloatingMessage />
      <Show when={ui.overlay} keyed>
        {(o) => (o.kind === "picker" ? <PickerOverlay kind={o.picker} /> : <HelpOverlay />)}
      </Show>
    </div>
  );
}
