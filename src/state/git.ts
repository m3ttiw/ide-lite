import { createMemo, createRoot, createSignal } from "solid-js";
import { api, type Commit, type CommitFile, type FileDiff, type FileStatus, type StatusEntry } from "../api";
import { LaneBuilder } from "../lib/lanes";
import { errorText, flash } from "./ui";
import { gitGeneration as generation, gitRoot as root, repo, status } from "./workspace";

export const PAGE = 200;

// ------------------------------------------------------------- history

let builder = new LaneBuilder();
const list: Commit[] = [];
const [logVersion, setLogVersion] = createSignal(0);
const [logLoading, setLogLoading] = createSignal(false);
const [logDone, setLogDone] = createSignal(false);
const [logError, setLogError] = createSignal<string | null>(null);
export { logLoading, logDone, logError };

export const commits = () => (logVersion(), list);
export const laneRows = () => (logVersion(), builder.rows);
export const laneWidth = () => (logVersion(), builder.maxWidth);

export async function loadMoreLog(): Promise<void> {
  if (logLoading() || logDone() || !repo()?.isRepo) return;
  const g = generation();
  setLogLoading(true);
  setLogError(null);
  try {
    const page = await api.gitLog(root(), list.length, PAGE, true);
    if (g !== generation()) return;
    builder.add(page);
    list.push(...page);
    if (page.length < PAGE) setLogDone(true);
    setLogVersion((v) => v + 1);
    if (list.length === page.length && page.length > 0 && selectedCommit() < 0) selectCommit(0);
  } catch (e) {
    if (g === generation()) setLogError(errorText(e));
  } finally {
    if (g === generation()) setLogLoading(false);
  }
}

export function resetLog(): void {
  builder = new LaneBuilder();
  list.length = 0;
  setLogDone(false);
  setLogError(null);
  setLogLoading(false);
  setSelectedCommit(-1);
  setDetail(null);
  setLogVersion((v) => v + 1);
}

/** Reloads history from the top, keeping the selected commit when possible. */
export async function reloadLog(): Promise<void> {
  const keep = list[selectedCommit()]?.hash;
  resetLog();
  await loadMoreLog();
  if (keep) {
    const i = list.findIndex((c) => c.hash === keep);
    if (i >= 0) selectCommit(i);
  }
}

// ------------------------------------------------------------- commit detail

export interface DiffEntry {
  key: string;
  path: string;
  origPath: string | null;
  status: FileStatus;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  open: boolean;
  diff: FileDiff | null;
  loading: boolean;
  error: string | null;
  /** Line shown under the file header (what the diff is compared with). */
  banner?: string | null;
}

export const [selectedCommit, setSelectedCommit] = createSignal(-1);
const [detail, setDetail] = createSignal<{ hash: string; files: CommitFile[] | null; error: string | null } | null>(null);
export { detail };

const openFiles = new Set<string>();
const diffs = new Map<string, FileDiff | "loading" | { error: string }>();
const [detailVersion, setDetailVersion] = createSignal(0);
const bumpDetail = () => setDetailVersion((v) => v + 1);

let detailTimer: number | undefined;

export function selectCommit(i: number): void {
  if (i < 0 || i >= list.length) return;
  setSelectedCommit(i);
  const c = list[i];
  if (detail()?.hash === c.hash) return;
  setDetail({ hash: c.hash, files: null, error: null });
  openFiles.clear();
  bumpDetail();
  clearTimeout(detailTimer);
  // short delay so that holding n/p does not fire one request per row
  detailTimer = window.setTimeout(() => void loadDetail(c.hash), 90);
}

async function loadDetail(hash: string): Promise<void> {
  const g = generation();
  try {
    const files = await api.commitFiles(root(), hash);
    if (g !== generation() || detail()?.hash !== hash) return;
    setDetail({ hash, files, error: null });
    if (files[0]) toggleCommitFile(files[0].path, true);
  } catch (e) {
    if (g === generation() && detail()?.hash === hash) setDetail({ hash, files: [], error: errorText(e) });
  }
}

export function toggleCommitFile(path: string, open?: boolean): void {
  const d = detail();
  if (!d) return;
  const want = open ?? !openFiles.has(path);
  if (want) openFiles.add(path);
  else openFiles.delete(path);
  bumpDetail();
  const key = d.hash + "\0" + path;
  if (want && !diffs.has(key)) {
    const g = generation();
    diffs.set(key, "loading");
    api
      .commitFileDiff(root(), d.hash, path)
      .then((fd) => g === generation() && diffs.set(key, fd))
      .catch((e) => g === generation() && diffs.set(key, { error: errorText(e) }))
      .finally(bumpDetail);
  }
}

export const commitDiffEntries = createRoot(() =>
  createMemo((): DiffEntry[] => {
    detailVersion();
    const d = detail();
    if (!d?.files) return [];
    return d.files.map((f) => {
      const key = d.hash + "\0" + f.path;
      const v = diffs.get(key);
      return {
        key,
        path: f.path,
        origPath: f.origPath,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        binary: f.binary,
        open: openFiles.has(f.path),
        diff: v && v !== "loading" && !("error" in v) ? v : null,
        loading: v === "loading",
        error: v && v !== "loading" && "error" in v ? v.error : null,
      };
    });
  }),
);

// ------------------------------------------------------------- working changes

export type ChangeGroup = "staged" | "unstaged" | "untracked";

export interface ChangeRow {
  kind: "header" | "file";
  group: ChangeGroup;
  count?: number;
  entry?: StatusEntry;
  letter?: string;
}

export const GROUP_TITLES: Record<ChangeGroup, string> = { staged: "IN STAGE", unstaged: "NON IN STAGE", untracked: "NON TRACCIATI" };

export const changeRows = createRoot(() =>
  createMemo((): ChangeRow[] => {
    const groups: Record<ChangeGroup, ChangeRow[]> = { staged: [], unstaged: [], untracked: [] };
    for (const s of status()) {
      if (s.index && s.index !== "?") groups.staged.push({ kind: "file", group: "staged", entry: s, letter: s.index });
      if (s.worktree === "?") groups.untracked.push({ kind: "file", group: "untracked", entry: s, letter: "?" });
      else if (s.worktree) groups.unstaged.push({ kind: "file", group: "unstaged", entry: s, letter: s.worktree });
    }
    const out: ChangeRow[] = [];
    for (const g of ["staged", "unstaged", "untracked"] as ChangeGroup[]) {
      if (!groups[g].length) continue;
      out.push({ kind: "header", group: g, count: groups[g].length });
      out.push(...groups[g]);
    }
    return out;
  }),
);

export const [changeSel, setChangeSel] = createSignal<{ path: string; group: ChangeGroup } | null>(null);
const [changeDiff, setChangeDiff] = createSignal<{ key: string; diff: FileDiff | null; loading: boolean; error: string | null } | null>(null);
export { changeDiff };

export function selectChange(row: ChangeRow | undefined): void {
  if (!row?.entry) return;
  const staged = row.group === "staged";
  const path = row.entry.path;
  setChangeSel({ path, group: row.group });
  const key = `${row.group}\0${path}`;
  setChangeDiff({ key, diff: null, loading: true, error: null });
  const g = generation();
  api
    .workingFileDiff(root(), path, staged)
    .then((diff) => {
      if (g === generation() && changeDiff()?.key === key) setChangeDiff({ key, diff, loading: false, error: null });
    })
    .catch((e) => {
      if (g === generation() && changeDiff()?.key === key) setChangeDiff({ key, diff: null, loading: false, error: errorText(e) });
    });
}

/** Re-fetches the shown working diff (after a save or a refresh). */
export function refreshChangeDiff(): void {
  const sel = changeSel();
  if (!sel) return;
  const row = changeRows().find((r) => r.kind === "file" && r.group === sel.group && r.entry?.path === sel.path);
  if (row) selectChange(row);
  else {
    setChangeSel(null);
    setChangeDiff(null);
  }
}

export const changeEntries = createRoot(() =>
  createMemo((): DiffEntry[] => {
    const sel = changeSel();
    const d = changeDiff();
    if (!sel || !d) return [];
    const row = changeRows().find((r) => r.kind === "file" && r.group === sel.group && r.entry?.path === sel.path);
    const diff = d.diff;
    let additions: number | null = null;
    let deletions: number | null = null;
    if (diff) {
      additions = 0;
      deletions = 0;
      for (const h of diff.hunks) for (const l of h.lines) l.kind === "add" ? additions++ : l.kind === "del" ? deletions++ : 0;
    }
    return [
      {
        key: d.key,
        path: sel.path,
        origPath: diff?.origPath ?? row?.entry?.origPath ?? null,
        status: (diff?.status ?? row?.letter ?? "M") as FileStatus,
        additions,
        deletions,
        binary: diff?.binary ?? false,
        open: true,
        diff,
        loading: d.loading,
        error: d.error,
      },
    ];
  }),
);

export function resetChanges(): void {
  setChangeSel(null);
  setChangeDiff(null);
}

export function flashGitError(e: unknown): void {
  flash(errorText(e), true);
}
