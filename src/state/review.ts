import { createMemo, createRoot, createSignal } from "solid-js";
import { api, type FileDiff, type FileStatus, type ReviewFile, type ReviewInfo } from "../api";
import type { DiffEntry } from "./git";
import { errorText, flash } from "./ui";
import { gitGeneration as generation, gitRoot as root } from "./workspace";
import { baseRef } from "./worktrees";

// ------------------------------------------------------------- what has been seen

/** A file marked as reviewed: the blob id of its content then ("" = deleted), and when. */
export interface Seen {
  blob: string;
  at: number;
}

const STORE = "ide-lite:reviewed";
/** Worktrees kept in the store; the least recently reviewed are dropped beyond this. */
const MAX_WORKTREES = 200;

type Store = Record<string, { at: number; files: Record<string, Seen> }>;

function readStore(): Store {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "{}");
    return v && typeof v === "object" ? (v as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(s: Store): void {
  const keys = Object.keys(s);
  if (keys.length > MAX_WORKTREES) {
    keys.sort((a, b) => s[a].at - s[b].at);
    for (const k of keys.slice(0, keys.length - MAX_WORKTREES)) delete s[k];
  }
  try {
    localStorage.setItem(STORE, JSON.stringify(s));
  } catch {
    // storage full or blocked: marks live until the window closes
  }
}

const [seenVersion, setSeenVersion] = createSignal(0);
let seenCache: { root: string; files: Record<string, Seen> } | null = null;

function seenFiles(r: string): Record<string, Seen> {
  seenVersion();
  if (seenCache?.root !== r) seenCache = { root: r, files: { ...(readStore()[r]?.files ?? {}) } };
  return seenCache.files;
}

function saveSeen(r: string, update: (files: Record<string, Seen>) => void): void {
  const s = readStore();
  const entry = s[r] ?? { at: 0, files: {} };
  update(entry.files);
  entry.at = Date.now();
  if (Object.keys(entry.files).length) s[r] = entry;
  else delete s[r];
  writeStore(s);
  seenCache = { root: r, files: { ...entry.files } };
  setSeenVersion((v) => v + 1);
}

// ------------------------------------------------------------- review list

export type ReviewKind = "new" | "changed" | "seen";

export interface ReviewRow {
  kind: "header" | "file";
  group: "todo" | "seen";
  count?: number;
  file?: ReviewFile;
  /** new: never seen; changed: touched again after being seen; seen: as it was seen. */
  state?: ReviewKind;
  seen?: Seen;
}

const [review, setReview] = createSignal<{ root: string; base: string | null; info: ReviewInfo | null; error: string | null; loading: boolean } | null>(null);
export { review };

/** Branch the worktree is compared with: the main worktree's branch for now. */
export const reviewBase = () => baseRef();

let loadSeq = 0;

export async function loadReview(): Promise<void> {
  const r = root();
  if (!r) {
    setReview(null);
    return;
  }
  const base = reviewBase();
  const g = generation();
  const seq = ++loadSeq;
  const prev = review();
  setReview({ root: r, base, info: prev?.root === r ? prev.info : null, error: null, loading: true });
  try {
    const info = await api.reviewFiles(r, base);
    if (g !== generation() || seq !== loadSeq) return;
    setReview({ root: r, base, info, error: null, loading: false });
    syncSelection();
  } catch (e) {
    if (g !== generation() || seq !== loadSeq) return;
    setReview({ root: r, base, info: null, error: errorText(e), loading: false });
  }
}

export function resetReview(): void {
  loadSeq++;
  setReview(null);
  setReviewSel(null);
  setReviewDiff(null);
}

function stateOf(f: ReviewFile, seen: Seen | undefined): ReviewKind {
  if (!seen) return "new";
  return seen.blob === (f.blob ?? "") ? "seen" : "changed";
}

export const reviewRows = createRoot(() =>
  createMemo((): ReviewRow[] => {
    const rv = review();
    if (!rv?.info) return [];
    const seen = seenFiles(rv.root);
    const todo: ReviewRow[] = [];
    const done: ReviewRow[] = [];
    for (const f of rv.info.files) {
      const s = seen[f.path];
      const state = stateOf(f, s);
      (state === "seen" ? done : todo).push({ kind: "file", group: state === "seen" ? "seen" : "todo", file: f, state, seen: s });
    }
    const out: ReviewRow[] = [];
    if (todo.length) out.push({ kind: "header", group: "todo", count: todo.length }, ...todo);
    if (done.length) out.push({ kind: "header", group: "seen", count: done.length }, ...done);
    return out;
  }),
);

export const reviewCounts = createRoot(() =>
  createMemo(() => {
    let todo = 0;
    let total = 0;
    let additions = 0;
    let deletions = 0;
    for (const r of reviewRows()) {
      if (r.kind !== "file") continue;
      total++;
      if (r.state !== "seen") todo++;
      additions += r.file!.additions;
      deletions += r.file!.deletions;
    }
    return { todo, total, additions, deletions };
  }),
);

// ------------------------------------------------------------- selection and diff

export const [reviewSel, setReviewSel] = createSignal<string | null>(null);
/** Show the whole diff against the base even for a file touched after being seen. */
export const [reviewFull, setReviewFull] = createSignal(false);

const [reviewDiff, setReviewDiff] = createSignal<{
  key: string;
  diff: FileDiff | null;
  loading: boolean;
  error: string | null;
  /** The diff shown is only what changed since the file was seen. */
  delta: boolean;
  note: string | null;
} | null>(null);

export const selectedRow = () => reviewRows().find((r) => r.kind === "file" && r.file!.path === reviewSel());

function diffKey(row: ReviewRow, full: boolean): string {
  const f = row.file!;
  return `${f.path}\0${f.blob ?? "-"}\0${row.state}\0${full ? "full" : "delta"}\0${review()?.info?.baseCommit}`;
}

export function selectReview(path: string | null, force = false): void {
  setReviewSel(path);
  const row = selectedRow();
  if (!row) {
    setReviewDiff(null);
    return;
  }
  const full = reviewFull() || row.state !== "changed" || !row.seen?.blob;
  const key = diffKey(row, full);
  if (!force && reviewDiff()?.key === key) return;
  const rv = review()!;
  const f = row.file!;
  const g = generation();
  setReviewDiff({ key, diff: null, loading: true, error: null, delta: !full, note: null });
  const done = (diff: FileDiff | null, error: string | null, delta: boolean, note: string | null) => {
    if (g === generation() && reviewDiff()?.key === key) setReviewDiff({ key, diff, loading: false, error, delta, note });
  };
  const fetchFull = (note: string | null) =>
    api.reviewFileDiff(rv.root, rv.info!.baseCommit, f.path, f.origPath, null).then(
      (d) => done(d, null, false, note),
      (e) => done(null, errorText(e), false, note),
    );
  if (full) return void fetchFull(null);
  api.reviewFileDiff(rv.root, rv.info!.baseCommit, f.path, f.origPath, row.seen!.blob).then(
    (d) => done(d, null, true, null),
    () => void fetchFull("La versione vista non è più disponibile: ecco tutto rispetto alla base."),
  );
}

/** After a reload: keep the selected file when it is still listed, else the first one to review. */
function syncSelection(): void {
  const rows = reviewRows().filter((r) => r.kind === "file");
  const cur = reviewSel();
  if (cur && rows.some((r) => r.file!.path === cur)) return selectReview(cur);
  selectReview(rows[0]?.file!.path ?? null);
}

export const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "poco fa";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min fa`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h fa`;
  return `${Math.round(h / 24)} giorni fa`;
};

export const reviewEntries = createRoot(() =>
  createMemo((): DiffEntry[] => {
    const row = selectedRow();
    const d = reviewDiff();
    if (!row || !d) return [];
    const f = row.file!;
    const diff = d.diff;
    let additions: number | null = f.additions;
    let deletions: number | null = f.deletions;
    if (diff && d.delta) {
      additions = 0;
      deletions = 0;
      for (const h of diff.hunks) for (const l of h.lines) l.kind === "add" ? additions++ : l.kind === "del" ? deletions++ : 0;
    }
    let banner = d.note;
    if (!banner && d.delta && row.seen) banner = `Solo le modifiche da quando l'hai segnato come visto (${ago(row.seen.at)}).`;
    if (!banner && row.state === "seen" && row.seen) banner = `Visto ${ago(row.seen.at)}: non è cambiato da allora.`;
    return [
      {
        key: d.key,
        path: f.path,
        origPath: diff?.origPath ?? f.origPath,
        status: (diff && !d.delta ? diff.status : f.status) as FileStatus,
        additions,
        deletions,
        binary: diff?.binary ?? f.binary,
        open: true,
        diff,
        loading: d.loading,
        error: d.error,
        banner,
      },
    ];
  }),
);

// ------------------------------------------------------------- marking

/** Marks the selected file as seen (or not seen again); moves on to the next one to review. */
export async function toggleSeen(): Promise<void> {
  const rv = review();
  const row = selectedRow();
  if (!rv || !row) return flash("Nessun file selezionato");
  const path = row.file!.path;
  if (row.state === "seen") {
    saveSeen(rv.root, (files) => delete files[path]);
    return flash(`${path}: da rivedere`);
  }
  let id: string | null;
  try {
    [id] = await api.markReviewed(rv.root, [path]);
  } catch (e) {
    return flash(`Non riesco a segnarlo come visto: ${errorText(e)}`, true);
  }
  saveSeen(rv.root, (files) => (files[path] = { blob: id ?? "", at: Date.now() }));
  // changed on disk after the list was read: reload so that it shows up as touched
  if ((id ?? "") !== (row.file!.blob ?? "")) void loadReview();
  const next = reviewRows().find((r) => r.kind === "file" && r.state !== "seen");
  if (next) selectReview(next.file!.path);
  else {
    selectReview(path, true);
    flash("Tutto visto");
  }
}

export async function markAllSeen(): Promise<void> {
  const rv = review();
  const todo = reviewRows().filter((r) => r.kind === "file" && r.state !== "seen");
  if (!rv || !todo.length) return flash("Niente da segnare: è già tutto visto");
  try {
    const ids = await api.markReviewed(rv.root, todo.map((r) => r.file!.path));
    const now = Date.now();
    saveSeen(rv.root, (files) => todo.forEach((r, i) => (files[r.file!.path] = { blob: ids[i] ?? "", at: now })));
    flash(todo.length === 1 ? "1 file segnato come visto" : `${todo.length} file segnati come visti`);
    selectReview(reviewSel(), true);
  } catch (e) {
    flash(`Non riesco a segnarli come visti: ${errorText(e)}`, true);
  }
}

export function toggleFull(): void {
  const row = selectedRow();
  if (!row) return;
  if (row.state !== "changed") return flash("Il diff mostra già tutto rispetto alla base");
  setReviewFull(!reviewFull());
  selectReview(row.file!.path);
  flash(reviewFull() ? "Tutto rispetto alla base" : "Solo le modifiche dopo la tua revisione");
}
