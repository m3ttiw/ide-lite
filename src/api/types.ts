// Contract between the UI and the Rust backend.
//
// This file is the single source of truth for the shapes that cross the
// boundary. The Rust side (src-tauri) serializes exactly these shapes
// (serde `rename_all = "camelCase"`), `tauri.ts` calls the commands, and the
// in-browser mock implements the same `Api` interface.
//
// Path conventions
// - `root` / `worktreePath`: absolute path of a workspace folder (a git
//   worktree root, or any folder when it is not a repository). Paths RETURNED
//   by the backend always use forward slashes (`C:/Users/me/repo`); paths
//   PASSED to it may use either separator.
// - `path` / `dir`: relative to `root`, forward slashes, no leading slash.
//   `""` is the root itself.
//
// Errors
// - Every call rejects with a plain string message on failure.
// - Outside a git repository the git calls do not fail: `repoInfo.isRepo` is
//   false and the list calls resolve to `[]`.

/** Git change kind. `"?"` is untracked, `"U"` is an unmerged conflict. */
export type FileStatus = "M" | "A" | "D" | "R" | "C" | "U" | "?";

export interface DirEntry {
  name: string;
  /** Relative to root. */
  path: string;
  kind: "file" | "dir";
  /** Matched by .gitignore. Always false outside a repository. */
  ignored: boolean;
}

export interface FileContent {
  /** Raw file text (line endings untouched). `""` when binary or tooLarge. */
  text: string;
  /** Not valid UTF-8, or contains NUL bytes. */
  binary: boolean;
  /** Larger than 5 MB: not loaded. */
  tooLarge: boolean;
  /** Dominant line ending on disk, so a save can keep it. */
  eol: "lf" | "crlf";
}

export interface RepoInfo {
  /**
   * Root of the worktree that contains the folder passed in (git toplevel),
   * or that folder itself when it is not inside a repository.
   */
  root: string;
  isRepo: boolean;
  /** Short branch name. null when HEAD is detached or outside a repo. */
  branch: string | null;
  /** Full hash of HEAD. null for a repo without commits or outside a repo. */
  head: string | null;
  /** e.g. "origin/main". null when the branch has no upstream. */
  upstream: string | null;
  /** Commits ahead of / behind the upstream. 0 when there is none. */
  ahead: number;
  behind: number;
}

export interface StatusEntry {
  path: string;
  /** Previous path of a rename or copy, else null. */
  origPath: string | null;
  /** Staged change (index vs HEAD). null when the index is unchanged. */
  index: FileStatus | null;
  /** Unstaged change (working tree vs index). `"?"` for untracked files. */
  worktree: FileStatus | null;
}

export interface CommitRef {
  /** "main", "origin/main", "v1.2.0". */
  name: string;
  kind: "branch" | "remote" | "tag";
}

export interface Commit {
  /** Full 40-character hash. */
  hash: string;
  /** Full hashes, first parent first. Empty for a root commit. */
  parents: string[];
  subject: string;
  author: string;
  /** Author date, unix seconds. */
  date: number;
  /** HEAD points at this commit. */
  isHead: boolean;
  refs: CommitRef[];
}

export interface CommitFile {
  path: string;
  origPath: string | null;
  status: FileStatus;
  /** 0 for binary files. */
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface DiffLine {
  kind: "ctx" | "add" | "del";
  /** Line number in the old file. null on added lines. */
  oldNo: number | null;
  /** Line number in the new file. null on deleted lines. */
  newNo: number | null;
  /** Line content without the leading diff marker and without the newline. */
  text: string;
}

export interface DiffHunk {
  /** The full "@@ -a,b +c,d @@ context" line. */
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  origPath: string | null;
  status: FileStatus;
  binary: boolean;
  /** The diff was longer than the backend limit (20 000 lines) and was cut. */
  truncated: boolean;
  hunks: DiffHunk[];
}

export interface Worktree {
  /** Absolute path, forward slashes. */
  path: string;
  /** Short branch name. null when detached. */
  branch: string | null;
  /** Full hash of the worktree HEAD. */
  head: string;
  /** The main working tree (first entry of `git worktree list`). */
  isMain: boolean;
  /** This worktree contains the `root` the list was asked for. */
  isCurrent: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface WorktreeStatus {
  /** Commits on this worktree's HEAD that `base` does not have. */
  ahead: number;
  /** Commits on `base` that this worktree's HEAD does not have. */
  behind: number;
  /** Number of entries `git status` reports (staged, unstaged, untracked). */
  dirty: number;
}

export interface Api {
  /**
   * Folder to open at startup: the first command-line argument when it is an
   * existing directory, otherwise the process working directory.
   */
  initialRoot(): Promise<string>;

  /** Native folder picker. Resolves to null when the user cancels. */
  pickFolder(): Promise<string | null>;

  repoInfo(root: string): Promise<RepoInfo>;

  /**
   * Direct children of `dir`, directories first, then files, each group
   * sorted case-insensitively by name. The `.git` entry is never listed.
   */
  listDir(root: string, dir: string): Promise<DirEntry[]>;

  /**
   * Every file of the workspace for quick-open: tracked plus untracked,
   * ignored files excluded. Outside a repository: a recursive walk that skips
   * dot-folders and stops at 50 000 files.
   */
  listFiles(root: string): Promise<string[]>;

  readFile(root: string, path: string): Promise<FileContent>;

  /** Writes `text` as UTF-8 exactly as given (the caller owns line endings). */
  writeFile(root: string, path: string, text: string): Promise<void>;

  gitStatus(root: string): Promise<StatusEntry[]>;

  /**
   * One page of history, newest first, children always before their parents
   * (`--date-order`). `all` = true walks every local branch, remote branch
   * and tag plus HEAD; false walks HEAD only.
   */
  gitLog(root: string, skip: number, limit: number, all: boolean): Promise<Commit[]>;

  /**
   * Files changed by a commit. A merge commit is compared with its first
   * parent, a root commit with the empty tree.
   */
  commitFiles(root: string, hash: string): Promise<CommitFile[]>;

  /** Diff of one file in a commit (same comparison rules as commitFiles). */
  commitFileDiff(root: string, hash: string, path: string): Promise<FileDiff>;

  /**
   * Uncommitted diff of one file. staged = true: index vs HEAD. staged =
   * false: working tree vs index; an untracked file comes back as one hunk of
   * added lines.
   */
  workingFileDiff(root: string, path: string, staged: boolean): Promise<FileDiff>;

  /** All worktrees of the repository that contains `root`, main one first. */
  listWorktrees(root: string): Promise<Worktree[]>;

  /**
   * Cheap per-worktree numbers, asked lazily for the rows on screen. `base`
   * is a branch name or hash to compare with; null gives ahead = behind = 0.
   */
  worktreeStatus(worktreePath: string, base: string | null): Promise<WorktreeStatus>;

  /**
   * Creates a worktree next to the main one, in
   * `<main parent>/<main folder>.<branch with "/" replaced by "-">`. Checks
   * out `branch` when it exists, otherwise creates it from the HEAD of `root`.
   */
  addWorktree(root: string, branch: string): Promise<Worktree>;
}
