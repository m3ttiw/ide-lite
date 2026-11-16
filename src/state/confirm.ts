import { createSignal } from "solid-js";

/** One line of a confirmation: what will be affected. */
export interface ConfirmItem {
  label: string;
  detail?: string;
  /** What will be lost, shown in red. */
  warn?: string | null;
}

export interface ConfirmSpec {
  title: string;
  items?: ConfirmItem[];
  note?: string;
  /** Label of the button that goes ahead (e.g. "Elimina"). */
  confirmLabel: string;
}

interface Request extends ConfirmSpec {
  resolve: (ok: boolean) => void;
}

const [request, setRequest] = createSignal<Request | null>(null);
export const confirmRequest = request;

let returnFocus: Element | null = null;

/**
 * Shows the confirmation dialog over everything else. Resolves true only when
 * the user confirms (C-RET or the button); false on cancel.
 */
export function askConfirm(spec: ConfirmSpec): Promise<boolean> {
  request()?.resolve(false);
  returnFocus = document.activeElement;
  return new Promise((resolve) => setRequest({ ...spec, resolve }));
}

export function resolveConfirm(ok: boolean): void {
  const r = request();
  if (!r) return;
  setRequest(null);
  const el = returnFocus;
  returnFocus = null;
  if (el instanceof HTMLElement && el.isConnected) el.focus();
  r.resolve(ok);
}
