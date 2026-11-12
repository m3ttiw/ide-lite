// Pure logic of app updates: when the automatic check is due, how progress
// reads, and what the one-shot "Aggiorna ide-lite" command does next.

import type { UpdatePhase, UpdateState } from "../api/types";

export const AUTO_FIRST_MS = 15_000;
export const AUTO_EVERY_MS = 6 * 60 * 60 * 1000;

export const BUSY_PHASES: readonly UpdatePhase[] = ["checking", "downloading", "installing"];
export const isBusy = (p: UpdatePhase | undefined) => !!p && BUSY_PHASES.includes(p);

export interface AutoTiming {
  first: number;
  every: number;
}

/**
 * Milliseconds until the next automatic check, or null when there is none:
 * the preference is off or updates are disabled. The first check is `first`
 * after startup, then one every `every` after the previous automatic one.
 */
export function autoCheckDelay(
  now: number,
  startedAt: number,
  lastAutoAt: number | null,
  enabled: boolean,
  phase: UpdatePhase | null,
  t: AutoTiming = { first: AUTO_FIRST_MS, every: AUTO_EVERY_MS },
): number | null {
  if (!enabled || phase === "disabled") return null;
  const due = lastAutoAt === null ? startedAt + t.first : lastAutoAt + t.every;
  return Math.max(0, due - now);
}

const nf1 = new Intl.NumberFormat("it-IT", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** "512 B", "1,5 KB", "18,0 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.max(0, Math.round(n))} B`;
  if (n < 1024 * 1024) return `${nf1.format(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${nf1.format(n / (1024 * 1024))} MB`;
  return `${nf1.format(n / (1024 * 1024 * 1024))} GB`;
}

/** 0..1, or null when the total is unknown. */
export function progressFraction(downloaded: number, total: number | null): number | null {
  if (!total || total <= 0) return null;
  return Math.max(0, Math.min(1, downloaded / total));
}

/** "3,4 MB di 18,0 MB (19%)", or "3,4 MB scaricati" without a total. */
export function formatProgress(downloaded: number, total: number | null): string {
  const f = progressFraction(downloaded, total);
  if (f === null) return `${formatBytes(downloaded)} scaricati`;
  return `${formatBytes(downloaded)} di ${formatBytes(total!)} (${Math.floor(f * 100)}%)`;
}

/** The state in words, for Settings. */
export function describeUpdate(s: UpdateState | null): string {
  if (!s) return "…";
  switch (s.phase) {
    case "disabled":
      return "Non disponibili in questa build";
    case "idle":
      return "Non ancora controllato";
    case "checking":
      return "Controllo in corso…";
    case "upToDate":
      return "Hai già l'ultima versione";
    case "available":
      return `Disponibile la versione ${s.newVersion ?? "nuova"}`;
    case "downloading":
      return `Download di ${s.newVersion ?? "aggiornamento"}: ${formatProgress(s.downloaded, s.total)}`;
    case "installing":
      return `Installazione di ${s.newVersion ?? "aggiornamento"}…`;
    case "error":
      return "Ultima operazione non riuscita";
  }
}

export type UpdateDecision =
  /** Something is already running: do nothing. */
  | "busy"
  | "disabled"
  /** Ask the release feed first. */
  | "check"
  /** Unsaved buffers: warn, and install on a repeat. */
  | "confirm"
  | "install"
  /** The check said there is nothing newer. */
  | "latest"
  /** The check failed. */
  | "failed";

/**
 * Next step of "Aggiorna ide-lite". Called once on invocation and once more
 * after the check (`justChecked`). `armed` = the user repeated the command
 * after the unsaved-buffers warning.
 */
export function decideUpdate(phase: UpdatePhase, opts: { dirty: number; armed: boolean; justChecked: boolean }): UpdateDecision {
  if (isBusy(phase)) return "busy";
  if (phase === "disabled") return "disabled";
  if (phase === "available") return opts.dirty > 0 && !opts.armed ? "confirm" : "install";
  if (opts.justChecked) return phase === "error" ? "failed" : "latest";
  return "check";
}
