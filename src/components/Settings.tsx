import { Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { runCommand } from "../core/commands";
import { MODE_NAMES, type Mode } from "../core/keymaps";
import { relativeDate, fullDate } from "../lib/reldate";
import { describeUpdate, formatProgress, isBusy, progressFraction } from "../lib/updates";
import { closeOverlay, setSettingsHandle } from "../state/focus";
import { savePrefs, setUi, ui } from "../state/ui";
import { checkNow, ensureUpdates, runUpdate, updateState } from "../state/updates";

/** A switch: a real button with role="switch". */
function Toggle(props: { label: string; on: boolean; onToggle: () => void; disabled?: boolean }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      class="st-toggle"
      data-setting=""
      aria-checked={props.on}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onToggle()}
    >
      <span class="st-switch" classList={{ on: props.on }} aria-hidden="true">
        <span class="st-knob" />
      </span>
      <span>{props.label}</span>
    </button>
  );
}

export function SettingsOverlay(): JSX.Element {
  let box!: HTMLDivElement;
  let notes: HTMLPreElement | undefined;
  const [loadError, setLoadError] = createSignal<string | null>(null);
  // the timer re-renders "5 minuti fa" while Settings is open
  const [now, setNow] = createSignal(Date.now());
  const tick = window.setInterval(() => setNow(Date.now()), 20_000);
  onCleanup(() => clearInterval(tick));

  ensureUpdates().catch((e) => setLoadError(String(e)));

  const s = updateState;
  const disabled = () => s()?.phase === "disabled";
  const busy = () => isBusy(s()?.phase);

  const controls = () => [...box.querySelectorAll<HTMLElement>("[data-setting]")].filter((el) => !(el as HTMLButtonElement).disabled);
  const move = (d: 1 | -1) => {
    const list = controls();
    if (!list.length) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    const next = list[i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + d))];
    next.focus();
    next.scrollIntoView({ block: "nearest" });
  };
  setSettingsHandle({
    move,
    activate: () => {
      const el = document.activeElement as HTMLElement | null;
      if (el && box.contains(el) && el.matches("button")) el.click();
    },
    scrollNotes: (d) => notes?.scrollBy({ top: d * (notes.clientHeight - 24) }),
  });
  onCleanup(() => setSettingsHandle(null));
  onMount(() => move(1));

  const setMode = (m: Mode) => {
    if (ui.mode !== m) runCommand("keymap.toggle");
  };

  return (
    <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && closeOverlay()}>
      <div class="settings" role="dialog" aria-modal="true" aria-label="Impostazioni" data-ctx="settings" ref={box}>
        <div class="help-head">
          <span class="picker-title">Impostazioni</span>
        </div>
        <div class="settings-body">
          <section class="st-section" aria-labelledby="st-upd">
            <h2 id="st-upd">Aggiornamenti</h2>
            <dl class="st-facts">
              <dt>Versione installata</dt>
              <dd>{s()?.currentVersion ?? "…"}</dd>
              <dt>Stato</dt>
              <dd>{loadError() ? `Non disponibile: ${loadError()}` : describeUpdate(s())}</dd>
              <dt>Ultimo controllo</dt>
              <dd title={s()?.checkedAt ? fullDate(s()!.checkedAt!) : undefined}>{s()?.checkedAt ? relativeDate(s()!.checkedAt!, now()) : "mai"}</dd>
            </dl>
            <Show when={disabled()}>
              <p class="st-note">Gli aggiornamenti sono disponibili solo nell'app installata.</p>
            </Show>
            <Toggle
              label="Controlla automaticamente (all'avvio e ogni 6 ore)"
              on={ui.autoUpdate}
              disabled={disabled()}
              onToggle={() => {
                setUi("autoUpdate", !ui.autoUpdate);
                savePrefs();
              }}
            />
            <div class="st-row">
              <button type="button" class="st-btn" data-setting="" disabled={disabled() || busy() || !s()} onClick={async (e) => {
                  // the button is disabled while checking, which drops focus: give it back
                  const b = e.currentTarget;
                  await checkNow();
                  if (document.activeElement === document.body || !document.activeElement) b.focus();
                }}
              >
                {s()?.phase === "checking" ? "Controllo…" : "Controlla ora"}
              </button>
            </div>
            <Show when={s()?.phase === "error" && s()?.error}>
              <p class="st-error" role="alert">
                {s()!.error}
              </p>
            </Show>
            <Show when={s()?.newVersion && ["available", "downloading", "installing"].includes(s()!.phase)}>
              <div class="st-update">
                <div class="st-new">
                  Nuova versione <strong>{s()!.newVersion}</strong>
                </div>
                <Show when={s()!.notes}>
                  {/* plain text: Solid inserts it as a text node, never as HTML */}
                  <pre class="st-notes focusable" tabindex="0" data-setting="" ref={notes} aria-label="Note di rilascio">
                    {s()!.notes}
                  </pre>
                </Show>
                <Show when={s()!.phase === "downloading"}>
                  <div
                    class="st-progress"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round((progressFraction(s()!.downloaded, s()!.total) ?? 0) * 100)}
                  >
                    <div class="st-bar" style={{ width: `${(progressFraction(s()!.downloaded, s()!.total) ?? 0) * 100}%` }} />
                  </div>
                  <div class="st-progress-text">{formatProgress(s()!.downloaded, s()!.total)}</div>
                </Show>
                <div class="st-row">
                  <button type="button" class="st-btn primary" data-setting="" disabled={busy()} onClick={() => void runUpdate()}>
                    {s()!.phase === "installing" ? "Installazione…" : s()!.phase === "downloading" ? "Download…" : `Scarica e installa ${s()!.newVersion}`}
                  </button>
                </div>
              </div>
            </Show>
          </section>

          <section class="st-section" aria-labelledby="st-keys">
            <h2 id="st-keys">Tasti</h2>
            <div class="st-row" role="group" aria-labelledby="st-keys">
              {(["emacs", "standard"] as Mode[]).map((m) => (
                <button type="button" class="st-btn" classList={{ on: ui.mode === m }} data-setting="" aria-pressed={ui.mode === m} onClick={() => setMode(m)}>
                  {MODE_NAMES[m]}
                </button>
              ))}
            </div>
          </section>

          <section class="st-section" aria-labelledby="st-hints">
            <h2 id="st-hints">Suggerimenti</h2>
            <Toggle label="Mostra la barra dei suggerimenti" on={ui.hintsVisible} onToggle={() => runCommand("hints.toggle")} />
          </section>
        </div>
      </div>
    </div>
  );
}
