// App updates: one store fed by onUpdateState, the automatic check, and the
// "Aggiorna ide-lite" command. Nothing here runs before the first timer
// fires, Settings opens or the command is used.

import { createRoot, createSignal, on, createEffect } from "solid-js";
import { api, isTauri, type UpdateState } from "../api";
import { AUTO_EVERY_MS, AUTO_FIRST_MS, autoCheckDelay, decideUpdate, formatProgress, isBusy, type AutoTiming } from "../lib/updates";
import { dirtyBuffers } from "./buffers";
import { errorText, flash, ui } from "./ui";

const [state, setState] = createSignal<UpdateState | null>(null);
export const updateState = state;

/** True while the command (or a Settings / status-bar install) drives an update: progress goes to the flash area. */
const [driving, setDriving] = createSignal(false);
export const updateDriving = driving;

let ready: Promise<void> | null = null;

/** Subscribes once and reads the current state. */
export function ensureUpdates(): Promise<void> {
  ready ??= (async () => {
    await api.onUpdateState((s) => setState(s));
    const s = await api.updateState();
    // an event may have arrived meanwhile: keep whichever is further along
    if (!state()) setState(s);
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

const apply = (s: UpdateState) => {
  setState(s);
  return s;
};

// ------------------------------------------------------------- automatic check

/** Test hook: `?updateTimers=first,every` (milliseconds) in a development build. */
function timing(): AutoTiming {
  if (import.meta.env.DEV) {
    const p = new URLSearchParams(location.search).get("updateTimers");
    const [a, b] = (p ?? "").split(",").map(Number);
    if (a > 0 && b > 0) return { first: a, every: b };
  }
  return { first: AUTO_FIRST_MS, every: AUTO_EVERY_MS };
}

const startedAt = Date.now();
let lastAutoAt: number | null = null;
let timer: number | undefined;
let announced: string | null = null;

function schedule(): void {
  clearTimeout(timer);
  const d = autoCheckDelay(Date.now(), startedAt, lastAutoAt, ui.autoUpdate, state()?.phase ?? null, timing());
  if (d !== null) timer = window.setTimeout(autoCheck, d);
}

async function autoCheck(): Promise<void> {
  lastAutoAt = Date.now();
  try {
    await ensureUpdates();
    const cur = state();
    if (ui.autoUpdate && cur && cur.phase !== "disabled" && !isBusy(cur.phase) && cur.phase !== "available") {
      announce(apply(await api.updateCheck()));
    } else if (cur) announce(cur);
  } catch {
    /* automatic checks never interrupt: errors show only in Settings */
  }
  schedule();
}

/** One flash per new version found by the automatic check. */
function announce(s: UpdateState): void {
  if (s.phase !== "available" || !s.newVersion || announced === s.newVersion) return;
  announced = s.newVersion;
  if (!driving()) flash(`Disponibile ide-lite ${s.newVersion}: “Aggiornamento ${s.newVersion}” nella barra di stato lo installa`);
}

/** Starts the automatic check timer (call once after the first paint). */
export function startAutoUpdates(): void {
  schedule();
  // the preference can be switched at any time
  createRoot(() => createEffect(on(() => ui.autoUpdate, () => schedule(), { defer: true })));
}

// ------------------------------------------------------------- manual actions

/** "Controlla ora" in Settings: errors stay in Settings. */
export async function checkNow(): Promise<void> {
  await ensureUpdates();
  if (isBusy(state()?.phase) || state()?.phase === "disabled") return;
  try {
    const s = apply(await api.updateCheck());
    if (s.phase === "available") announced = s.newVersion;
  } catch (e) {
    const cur = state();
    if (cur) setState({ ...cur, phase: "error", error: errorText(e) });
  }
}

let armedUntil = 0;
const ARM_MS = 4000;

/**
 * "Aggiorna ide-lite": checks, then downloads and installs a newer version.
 * Repeat-to-confirm with unsaved buffers; a second call while running does nothing.
 */
export async function runUpdate(): Promise<void> {
  if (driving()) return flash("Aggiornamento già in corso");
  setDriving(true);
  try {
    await ensureUpdates();
    let s = state()!;
    let justChecked = false;
    for (;;) {
      const armed = Date.now() <= armedUntil;
      const d = decideUpdate(s.phase, { dirty: dirtyBuffers().length, armed, justChecked });
      switch (d) {
        case "busy":
          return flash("Aggiornamento già in corso");
        case "disabled":
          return flash("Gli aggiornamenti sono disponibili solo nell'app installata");
        case "latest":
          return flash(`ide-lite ${s.currentVersion} è già l'ultima versione`);
        case "failed":
          return flash(`Controllo degli aggiornamenti non riuscito: ${s.error ?? "errore sconosciuto"}`, true);
        case "confirm": {
          armedUntil = Date.now() + ARM_MS;
          const n = dirtyBuffers().length;
          announced = s.newVersion;
          return flash(`${n === 1 ? "1 buffer non salvato" : `${n} buffer non salvati`}: ripeti il comando per installare ${s.newVersion} comunque`, true);
        }
        case "check":
          flash("Controllo degli aggiornamenti…");
          s = apply(await api.updateCheck());
          justChecked = true;
          if (s.phase === "available") announced = s.newVersion;
          continue;
        case "install": {
          armedUntil = 0;
          flash(`Scarico ide-lite ${s.newVersion}…`);
          const after = apply(await api.updateInstall());
          // only reached when nothing was installed
          if (after.phase === "error") flash(`Aggiornamento non riuscito: ${after.error ?? "errore sconosciuto"}`, true);
          else if (after.phase === "upToDate") flash(`ide-lite ${after.currentVersion} è già l'ultima versione`);
          return;
        }
      }
    }
  } catch (e) {
    flash(`Aggiornamento non riuscito: ${errorText(e)}`, true);
  } finally {
    setDriving(false);
  }
}

// Progress of an install goes to the flash / hint area, whoever started it.
createRoot(() =>
  createEffect(
    on(state, (s, prev) => {
      if (!s) return;
      if (s.phase === "downloading") flash(`Download di ide-lite ${s.newVersion ?? ""}: ${formatProgress(s.downloaded, s.total)}`);
      else if (s.phase === "installing" && prev?.phase !== "installing") {
        flash(
          isTauri
            ? `Installazione di ide-lite ${s.newVersion ?? ""}: l'app si riavvierà`
            : `Installazione di ${s.newVersion ?? ""} (mock): qui l'app reale si chiuderebbe e si riavvierebbe`,
        );
      }
    }),
  ),
);
