import { createSignal } from "solid-js";
import { api, type FileStatus, type FileText, type ReviewFile } from "../api";
import { closeOverlay, openOverlay } from "./focus";
import { errorText, flash, ui } from "./ui";

/** `git hash-object -t tree /dev/null`: the "parent" of a root commit. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface CompareSide {
  /** Commit (hash, branch, the empty tree) or null for the working tree. */
  rev: string | null;
  /** What the user reads: "a1b2c3d · subject", "albero di lavoro", "main"… */
  label: string;
}

export interface CompareRequest {
  root: string;
  left: CompareSide;
  right: CompareSide;
  /** File shown first. */
  path?: string | null;
  /** Left side of some files: the snapshot taken when they were marked as seen. */
  since?: Record<string, { blob: string; label: string }>;
}

interface CompareState {
  req: CompareRequest;
  files: ReviewFile[] | null;
  error: string | null;
  sel: number;
}

export interface CompareTexts {
  key: string;
  path: string;
  leftPath: string;
  left: FileText | null;
  right: FileText | null;
  /** Label of the left side for this file (a reviewed snapshot overrides it). */
  leftLabel: string;
  error: string | null;
}

const [compare, setCompare] = createSignal<CompareState | null>(null);
const [texts, setTexts] = createSignal<CompareTexts | null>(null);
/** Commit marked in the history to compare another one with. */
export const [historyMark, setHistoryMark] = createSignal<{ root: string; hash: string } | null>(null);

/** Show whole files instead of folding what did not change. */
export const [compareWhole, setCompareWhole] = createSignal(false);
export { compare, texts as compareTexts };

const INVERSE: Partial<Record<FileStatus, FileStatus>> = { A: "D", "?": "D", D: "A" };

/** A file list from `compareFiles(b, a)` seen the other way round. */
function invert(f: ReviewFile): ReviewFile {
  const renamed = f.origPath && f.origPath !== f.path;
  return {
    ...f,
    path: renamed ? f.origPath! : f.path,
    origPath: renamed ? f.path : f.origPath,
    status: INVERSE[f.status] ?? f.status,
    additions: f.deletions,
    deletions: f.additions,
    blob: null,
  };
}

let seq = 0;

export async function openCompare(req: CompareRequest): Promise<void> {
  if (req.left.rev === null && req.right.rev === null) return flash("Niente da confrontare: entrambi i lati sono l'albero di lavoro");
  const n = ++seq;
  setCompare({ req, files: null, error: null, sel: 0 });
  setTexts(null);
  if (ui.overlay?.kind !== "compare") openOverlay({ kind: "compare" });
  // compareFiles takes the working tree only on its right side
  const swapped = req.left.rev === null;
  try {
    const raw = swapped ? await api.compareFiles(req.root, req.right.rev!, null) : await api.compareFiles(req.root, req.left.rev!, req.right.rev);
    if (n !== seq) return;
    const files = swapped ? raw.map(invert).sort((a, b) => a.path.localeCompare(b.path)) : raw;
    const i = req.path ? files.findIndex((f) => f.path === req.path || f.origPath === req.path) : -1;
    setCompare({ req, files, error: null, sel: Math.max(0, i) });
    if (files.length) loadTexts();
  } catch (e) {
    if (n === seq) setCompare({ req, files: null, error: errorText(e), sel: 0 });
  }
}

function loadTexts(): void {
  const st = compare();
  const f = st?.files?.[st.sel];
  if (!st || !f) {
    setTexts(null);
    return;
  }
  const { req } = st;
  const leftPath = f.origPath ?? f.path;
  const snap = req.left.rev !== null ? req.since?.[f.path] : undefined;
  const key = `${seq}:${st.sel}:${f.path}`;
  const leftLabel = snap ? snap.label : req.left.label;
  setTexts({ key, path: f.path, leftPath, left: null, right: null, leftLabel, error: null });
  const none: FileText = { kind: "missing", text: null };
  const left = f.status === "A" || f.status === "?" ? Promise.resolve(none) : api.fileText(req.root, snap ? snap.blob : req.left.rev, leftPath);
  const right = f.status === "D" ? Promise.resolve(none) : api.fileText(req.root, req.right.rev, f.path);
  Promise.all([left, right]).then(
    ([l, r]) => {
      if (texts()?.key === key) setTexts({ key, path: f.path, leftPath, left: l, right: r, leftLabel, error: null });
    },
    (e) => {
      if (texts()?.key === key) setTexts({ key, path: f.path, leftPath, left: null, right: null, leftLabel, error: errorText(e) });
    },
  );
}

export function compareSelect(i: number): void {
  const st = compare();
  if (!st?.files?.length) return;
  const sel = Math.max(0, Math.min(st.files.length - 1, i));
  if (sel === st.sel && texts()) return;
  setCompare({ ...st, sel });
  loadTexts();
}

export const compareMove = (d: number) => {
  const st = compare();
  if (!st?.files?.length) return;
  const i = st.sel + d;
  if (i < 0 || i >= st.files.length) return flash(d > 0 ? "Ultimo file" : "Primo file");
  compareSelect(i);
};

export function compareSwap(): void {
  const st = compare();
  if (!st) return;
  const f = st.files?.[st.sel];
  void openCompare({ root: st.req.root, left: st.req.right, right: st.req.left, path: f ? (f.origPath ?? f.path) : st.req.path });
}

export function closeCompare(): void {
  seq++;
  setCompare(null);
  setTexts(null);
  closeOverlay();
}

export const comparePath = () => {
  const st = compare();
  return st?.files?.[st.sel] ?? null;
};
