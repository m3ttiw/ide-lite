//! Shapes that cross the IPC boundary. Mirrors `src/api/types.ts` exactly.

use serde::Serialize;

/// Git change kind. Serialized as the single-character code used in `types.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum FileStatus {
    #[serde(rename = "M")]
    Modified,
    #[serde(rename = "A")]
    Added,
    #[serde(rename = "D")]
    Deleted,
    #[serde(rename = "R")]
    Renamed,
    #[serde(rename = "C")]
    Copied,
    #[serde(rename = "U")]
    Unmerged,
    #[serde(rename = "?")]
    Untracked,
}

impl FileStatus {
    /// Maps a git status letter (porcelain XY, raw diff status) to a kind.
    /// `.` / space (unchanged) and unknown letters give `None`.
    pub fn from_code(c: u8) -> Option<Self> {
        Some(match c {
            b'M' | b'T' => Self::Modified,
            b'A' => Self::Added,
            b'D' => Self::Deleted,
            b'R' => Self::Renamed,
            b'C' => Self::Copied,
            b'U' => Self::Unmerged,
            b'?' => Self::Untracked,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub ignored: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub text: String,
    pub binary: bool,
    pub too_large: bool,
    pub eol: Eol,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub root: String,
    pub is_repo: bool,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,
    pub orig_path: Option<String>,
    pub index: Option<FileStatus>,
    pub worktree: Option<FileStatus>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RefKind {
    Branch,
    Remote,
    Tag,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRef {
    pub name: String,
    pub kind: RefKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author: String,
    pub date: i64,
    pub is_head: bool,
    pub refs: Vec<CommitRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    pub path: String,
    pub orig_path: Option<String>,
    pub status: FileStatus,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LineKind {
    Ctx,
    Add,
    Del,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: LineKind,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub orig_path: Option<String>,
    pub status: FileStatus,
    pub binary: bool,
    pub truncated: bool,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    pub is_main: bool,
    pub is_current: bool,
    pub detached: bool,
    pub locked: bool,
    pub prunable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoEntry {
    pub path: String,
    pub rel_path: String,
    pub branch: Option<String>,
    pub linked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub name: String,
    pub path: String,
    pub is_repo: bool,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
    pub path: String,
    pub parent: Option<String>,
    pub dirs: Vec<FolderEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    pub ahead: u32,
    pub behind: u32,
    pub dirty: u32,
}

/// A file the reviewed worktree changes against its base.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFile {
    pub path: String,
    pub orig_path: Option<String>,
    pub status: FileStatus,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
    /// Blob id of the content on disk now; `None` for a deleted file.
    pub blob: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewInfo {
    /// What the files are compared with: the merge base of HEAD and the base
    /// branch, HEAD itself without a base, the empty tree before any commit.
    pub base_commit: String,
    pub files: Vec<ReviewFile>,
}

/// Someone asked to review a pull request, with where their review stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewer {
    pub name: String,
    /// approved | suggestions (approved with suggestions) | changes (changes
    /// requested) | rejected | waiting (waiting for the author) | commented | pending
    pub state: String,
    pub required: bool,
}

/// A check run, commit status or branch policy of a pull request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCheck {
    pub name: String,
    /// success | failure | pending | neutral | skipped
    pub state: String,
    pub url: Option<String>,
    /// Blocks the merge (Azure DevOps blocking policies; unknown on GitHub: false).
    pub required: bool,
}

/// One comment of a pull request discussion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrComment {
    /// Comments with the same thread id answer each other.
    pub thread: String,
    /// File the thread is on, relative to the repository root; None for the
    /// general discussion.
    pub path: Option<String>,
    pub line: Option<u32>,
    /// "new" (line of the new version) or "old" (line of the old version).
    pub side: String,
    pub author: String,
    pub body: String,
    /// ISO 8601 date.
    pub at: String,
    pub resolved: bool,
    /// The line it was written on is no longer in the pull request diff.
    pub outdated: bool,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    /// Web page of the pull request.
    pub url: String,
    /// open | draft | merged | closed
    pub state: String,
    pub author: Option<String>,
    pub source_branch: String,
    pub target_branch: String,
    /// Local ref of the target branch ("origin/main", or "main" without a
    /// remote-tracking branch); None when neither exists here.
    pub base_ref: Option<String>,
    pub head_commit: Option<String>,
    pub reviewers: Vec<PrReviewer>,
    pub checks: Vec<PrCheck>,
    pub comments: Vec<PrComment>,
}

/// Pull request of the current branch, or why there is none to show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrLookup {
    /// found | none (no pull request for the branch) | detached (no branch) |
    /// noremote | unsupported (remote is not GitHub or Azure DevOps) |
    /// auth (no credentials, or rejected) | error
    pub status: String,
    /// github | azure
    pub provider: Option<String>,
    pub branch: Option<String>,
    /// Web page of the repository.
    pub repo_url: Option<String>,
    /// Technical detail (English) for auth and error.
    pub message: Option<String>,
    pub pr: Option<PullRequest>,
}
